import { addMember, createUser, normEmail, EMAIL_RE } from './accounts.ts';
import { decrypt, encrypt, newId, randomToken, sha256 } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { offboard } from './grants.ts';
import { badRequest } from './http.ts';
import { getBilling } from './billing.ts';
import type { Effects } from './requests.ts';

/**
 * Directory sync. The identity provider is the source of truth for who works here: people
 * appear, get their title and manager, and are offboarded when the IdP deactivates them.
 * IdP groups can make people ac·modern admins, or stand for an access level (e.g. the
 * Okta group "github-admins" = GitHub Owner), in which case that access is detected and
 * tracked automatically. SCIM pushes changes in; Google, Okta and Microsoft are pulled.
 */

export type DirectoryKind = 'scim' | 'google' | 'okta' | 'entra';

export interface DirectoryUser {
	/** Stable id in the source (our SCIM id, or the provider's user id). */
	id: string;
	externalId?: string;
	email: string;
	name: string;
	title: string;
	/** The manager's id in the same directory, or their email. */
	managerRef: string;
	active: boolean;
	raw?: unknown;
}

export interface DirectoryGroup {
	id: string;
	externalId?: string;
	name: string;
	memberIds: string[];
}

export interface DirectorySource {
	kind: DirectoryKind;
	config: Record<string, string>;
	hasScimToken: boolean;
	onDeactivate: 'offboard' | 'deactivate';
	createMembers: boolean;
	lastSyncAt: string | null;
	lastError: string;
	stats: Record<string, number>;
}

const now = () => new Date().toISOString();

export async function getSource(db: Db, orgId: string): Promise<DirectorySource | null> {
	const r = await db.get<{ kind: DirectoryKind; config: string; scim_token_hash: string | null; on_deactivate: 'offboard' | 'deactivate'; create_members: number; last_sync_at: string | null; last_error: string; stats: string }>(
		'SELECT kind, config, scim_token_hash, on_deactivate, create_members, last_sync_at, last_error, stats FROM directory_sources WHERE org_id = ?',
		[orgId]
	);
	if (!r) return null;
	return {
		kind: r.kind,
		config: r.config ? JSON.parse(decrypt(r.config, `org:${orgId}:directory`)) : {},
		hasScimToken: !!r.scim_token_hash,
		onDeactivate: r.on_deactivate,
		createMembers: !!r.create_members,
		lastSyncAt: r.last_sync_at,
		lastError: r.last_error,
		stats: JSON.parse(r.stats || '{}')
	};
}

const REQUIRED: Record<DirectoryKind, string[]> = {
	scim: [],
	google: ['serviceAccountJson', 'adminEmail'],
	okta: ['domain', 'apiToken'],
	entra: ['tenantId', 'clientId', 'clientSecret']
};

/** Saves the source. Config secrets are merged so blank fields keep stored values. */
export async function saveSource(db: Db, orgId: string, input: { kind: DirectoryKind; config: Record<string, string>; onDeactivate: 'offboard' | 'deactivate'; createMembers: boolean }) {
	const current = await getSource(db, orgId);
	const config = current?.kind === input.kind ? { ...current.config } : {};
	for (const [k, v] of Object.entries(input.config)) if (v) config[k] = v.trim();
	for (const k of REQUIRED[input.kind]) if (!config[k]) throw badRequest(`${k} is required`);
	if (input.kind === 'google') {
		try {
			const sa = JSON.parse(config.serviceAccountJson);
			if (!sa.client_email || !sa.private_key) throw new Error();
		} catch {
			throw badRequest('Paste the service account’s JSON key file');
		}
	}
	if (current && current.kind !== input.kind) {
		// A different directory: its ids mean nothing here, so start clean rather than
		// treating everyone the old one knew as removed. Members and grants stay.
		for (const t of ['directory_memberships', 'directory_groups', 'directory_users', 'group_mappings']) await db.run(`DELETE FROM ${t} WHERE org_id = ?`, [orgId]);
		await db.run('UPDATE directory_sources SET scim_token_hash = NULL WHERE org_id = ?', [orgId]);
	}
	await db.run(
		`INSERT INTO directory_sources (org_id, kind, config, on_deactivate, create_members, created_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (org_id) DO UPDATE SET kind = excluded.kind, config = excluded.config, on_deactivate = excluded.on_deactivate, create_members = excluded.create_members`,
		[orgId, input.kind, encrypt(JSON.stringify(config), `org:${orgId}:directory`), input.onDeactivate, input.createMembers, now()]
	);
}

/** A new SCIM bearer token (shown once). */
export async function rotateScimToken(db: Db, orgId: string): Promise<string> {
	const token = `acm_scim_${randomToken(32)}`;
	const { changes } = await db.run('UPDATE directory_sources SET scim_token_hash = ? WHERE org_id = ?', [sha256(token), orgId]);
	if (!changes) throw badRequest('Choose SCIM as the directory source first');
	return token;
}

export async function orgForScimToken(db: Db, token: string): Promise<string | null> {
	if (!token.startsWith('acm_scim_')) return null;
	return (await db.get<{ org_id: string }>("SELECT org_id FROM directory_sources WHERE scim_token_hash = ? AND kind = 'scim'", [sha256(token)]))?.org_id ?? null;
}

/** Stops syncing. People, groups and detected grants stay as they are. */
export async function disconnect(db: Db, orgId: string) {
	await db.run('DELETE FROM directory_sources WHERE org_id = ?', [orgId]);
}

// ── Storing what the directory says ──────────────────────────────────────────

export async function upsertUser(db: Db, orgId: string, u: DirectoryUser) {
	await db.run(
		`INSERT INTO directory_users (org_id, id, external_id, email, name, title, manager_ref, active, raw, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (org_id, id) DO UPDATE SET external_id = excluded.external_id, email = excluded.email, name = excluded.name, title = excluded.title,
		 manager_ref = excluded.manager_ref, active = excluded.active, raw = excluded.raw, updated_at = excluded.updated_at`,
		[orgId, u.id, u.externalId ?? '', normEmail(u.email), u.name, u.title, u.managerRef, u.active, JSON.stringify(u.raw ?? {}), now()]
	);
}

export async function upsertGroup(db: Db, orgId: string, g: DirectoryGroup) {
	await db.run(
		`INSERT INTO directory_groups (org_id, id, external_id, name, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (org_id, id) DO UPDATE SET external_id = excluded.external_id, name = excluded.name, updated_at = excluded.updated_at`,
		[orgId, g.id, g.externalId ?? '', g.name, now()]
	);
	await db.run('DELETE FROM directory_memberships WHERE org_id = ? AND group_id = ?', [orgId, g.id]);
	for (const m of new Set(g.memberIds)) await db.run('INSERT INTO directory_memberships (org_id, group_id, user_id) VALUES (?, ?, ?)', [orgId, g.id, m]);
}

/** A full pull replaces everything: users missing from it count as deactivated. */
export async function replaceSnapshot(db: Db, orgId: string, users: DirectoryUser[], groups: DirectoryGroup[]) {
	await db.tx(async (tx) => {
		const seen = new Set(users.map((u) => u.id));
		for (const u of users) await upsertUser(tx, orgId, u);
		const stale = await tx.all<{ id: string }>('SELECT id FROM directory_users WHERE org_id = ?', [orgId]);
		for (const s of stale) if (!seen.has(s.id)) await tx.run('UPDATE directory_users SET active = 0, updated_at = ? WHERE org_id = ? AND id = ?', [now(), orgId, s.id]);
		const groupIds = new Set(groups.map((g) => g.id));
		for (const g of groups) await upsertGroup(tx, orgId, g);
		const oldGroups = await tx.all<{ id: string }>('SELECT id FROM directory_groups WHERE org_id = ?', [orgId]);
		for (const g of oldGroups)
			if (!groupIds.has(g.id)) {
				await tx.run('DELETE FROM directory_memberships WHERE org_id = ? AND group_id = ?', [orgId, g.id]);
				await tx.run('DELETE FROM directory_groups WHERE org_id = ? AND id = ?', [orgId, g.id]);
			}
	});
}

// ── Mappings ─────────────────────────────────────────────────────────────────

export interface GroupMapping {
	id: string;
	groupId: string;
	target: 'admin' | 'access';
	resourceId: string | null;
	roleId: string | null;
}

export async function listMappings(db: Db, orgId: string): Promise<GroupMapping[]> {
	return (
		await db.all<{ id: string; group_id: string; target: 'admin' | 'access'; resource_id: string | null; role_id: string | null }>(
			'SELECT id, group_id, target, resource_id, role_id FROM group_mappings WHERE org_id = ? ORDER BY created_at',
			[orgId]
		)
	).map((m) => ({ id: m.id, groupId: m.group_id, target: m.target, resourceId: m.resource_id, roleId: m.role_id }));
}

export async function addMapping(db: Db, orgId: string, m: { groupId: string; target: 'admin' | 'access'; resourceId?: string; roleId?: string }) {
	if (!(await db.get('SELECT 1 FROM directory_groups WHERE org_id = ? AND id = ?', [orgId, m.groupId]))) throw badRequest('That group isn’t in the directory');
	if (m.target === 'access') {
		const ok = await db.get('SELECT 1 FROM resource_roles WHERE org_id = ? AND resource_id = ? AND id = ? AND archived = 0', [orgId, m.resourceId ?? '', m.roleId ?? '']);
		if (!ok) throw badRequest('Choose a resource and access level');
	}
	const dup = await db.get('SELECT 1 FROM group_mappings WHERE org_id = ? AND group_id = ? AND target = ? AND COALESCE(role_id, \'\') = ?', [orgId, m.groupId, m.target, m.roleId ?? '']);
	if (dup) return;
	await db.run('INSERT INTO group_mappings (id, org_id, group_id, target, resource_id, role_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
		newId(),
		orgId,
		m.groupId,
		m.target,
		m.target === 'access' ? m.resourceId! : null,
		m.target === 'access' ? m.roleId! : null,
		now()
	]);
}

export async function removeMapping(db: Db, orgId: string, id: string) {
	await db.run('DELETE FROM group_mappings WHERE org_id = ? AND id = ?', [orgId, id]);
}

// ── Reconcile ────────────────────────────────────────────────────────────────

export interface ReconcileResult {
	created: number;
	updated: number;
	deactivated: number;
	reactivated: number;
	adminsAdded: number;
	adminsRemoved: number;
	grantsDetected: number;
	grantsEnded: number;
	unmatched: number;
}

/**
 * Makes ac·modern match the stored directory. Only touches what the directory owns:
 * members it created (or matched by email), admin roles it granted, and grants it detected.
 * Owners and manually made admins are left alone.
 */
export async function reconcile(db: Db, orgId: string, fx: Effects): Promise<ReconcileResult> {
	const source = await getSource(db, orgId);
	const res: ReconcileResult = { created: 0, updated: 0, deactivated: 0, reactivated: 0, adminsAdded: 0, adminsRemoved: 0, grantsDetected: 0, grantsEnded: 0, unmatched: 0 };
	if (!source) return res;
	const system = { orgId, userId: null, admin: true };
	const dusers = await db.all<{ id: string; email: string; name: string; title: string; manager_ref: string; active: number; user_id: string | null }>(
		'SELECT id, email, name, title, manager_ref, active, user_id FROM directory_users WHERE org_id = ?',
		[orgId]
	);

	// 1. People. If an address appears twice (e.g. recreated in the IdP), the active record wins.
	const byDirId = new Map<string, string>();
	const byEmail = new Map<string, string>();
	const activeEmails = new Set(dusers.filter((u) => u.active).map((u) => u.email));
	for (const du of dusers) {
		if (!EMAIL_RE.test(du.email)) continue;
		if (!du.active && activeEmails.has(du.email)) continue;
		let userId = du.user_id ?? (await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [du.email]))?.id ?? null;
		const member = userId ? await db.get<{ status: string; title: string; deactivated_by: string; source: string }>('SELECT status, title, deactivated_by, source FROM members WHERE org_id = ? AND user_id = ?', [orgId, userId]) : undefined;
		if (du.active) {
			if (!member) {
				if (!source.createMembers || !(await getBilling(db, orgId)).canGrow) {
					res.unmatched++;
					continue;
				}
				userId ??= (await createUser(db, { email: du.email, name: du.name, passwordHash: null })).id;
				await addMember(db, orgId, userId, 'member');
				await db.run("UPDATE members SET source = 'directory' WHERE org_id = ? AND user_id = ?", [orgId, userId]);
				await record(db, { orgId, actorId: null, action: 'member.joined', subject: du.email, summary: `${du.name || du.email} added from the directory` });
				res.created++;
			} else if (member.status === 'deactivated' && member.deactivated_by === 'directory') {
				// Re-enabled in the IdP. (Someone offboarded by hand stays offboarded.)
				await db.run("UPDATE members SET status = 'active', deactivated_by = '' WHERE org_id = ? AND user_id = ?", [orgId, userId]);
				await record(db, { orgId, actorId: null, action: 'member.reactivated', subject: du.email, summary: `${du.name || du.email} reactivated by the directory` });
				res.reactivated++;
			}
			if (member && du.title && member.title !== du.title) {
				await db.run('UPDATE members SET title = ? WHERE org_id = ? AND user_id = ?', [du.title, orgId, userId]);
				res.updated++;
			} else if (!member && du.title) await db.run('UPDATE members SET title = ? WHERE org_id = ? AND user_id = ?', [du.title, orgId, userId]);
			if (du.name) await db.run("UPDATE users SET name = ? WHERE id = ? AND name = ''", [du.name, userId]);
		} else if (member?.status === 'active' && userId) {
			const role = await db.get<{ role: string }>('SELECT role FROM members WHERE org_id = ? AND user_id = ?', [orgId, userId]);
			if (role?.role === 'owner') {
				await record(db, { orgId, actorId: null, action: 'directory.skipped', subject: du.email, summary: `${du.email} is deactivated in the directory but is an owner here; offboard them by hand` });
			} else if (source.onDeactivate === 'offboard') {
				await offboard(db, system, userId, 'Deactivated in the identity provider', fx, 'directory');
				res.deactivated++;
			} else {
				await db.run("UPDATE members SET status = 'deactivated', deactivated_by = 'directory' WHERE org_id = ? AND user_id = ?", [orgId, userId]);
				await db.run('DELETE FROM sessions WHERE user_id = ? AND org_id = ?', [userId, orgId]);
				await record(db, { orgId, actorId: null, action: 'member.deactivated', subject: du.email, summary: `${du.name || du.email} deactivated by the directory` });
				res.deactivated++;
			}
		}
		if (userId) {
			if (du.user_id !== userId) await db.run('UPDATE directory_users SET user_id = ? WHERE org_id = ? AND id = ?', [userId, orgId, du.id]);
			byDirId.set(du.id, userId);
			byEmail.set(du.email, userId);
		}
	}

	// Managers, once everyone exists.
	for (const du of dusers) {
		const userId = byDirId.get(du.id);
		if (!userId || !du.active || !du.manager_ref) continue;
		const managerId = byDirId.get(du.manager_ref) ?? byEmail.get(normEmail(du.manager_ref));
		if (!managerId || managerId === userId) continue;
		const { changes } = await db.run('UPDATE members SET manager_id = ? WHERE org_id = ? AND user_id = ? AND (manager_id IS NULL OR manager_id <> ?)', [managerId, orgId, userId, managerId]);
		if (changes) res.updated++;
	}

	const mappings = await listMappings(db, orgId);
	const membersOf = async (groupId: string) =>
		new Set(
			(
				await db.all<{ user_id: string }>(
					`SELECT du.user_id FROM directory_memberships dm JOIN directory_users du ON du.org_id = dm.org_id AND du.id = dm.user_id
					 JOIN members m ON m.org_id = dm.org_id AND m.user_id = du.user_id
					 WHERE dm.org_id = ? AND dm.group_id = ? AND du.active = 1 AND m.status = 'active'`,
					[orgId, groupId]
				)
			).map((r) => r.user_id)
		);
	const groupName = async (id: string) => (await db.get<{ name: string }>('SELECT name FROM directory_groups WHERE org_id = ? AND id = ?', [orgId, id]))?.name ?? id;

	// 2. ac·modern admins from groups.
	const adminGroups = mappings.filter((m) => m.target === 'admin');
	const shouldBeAdmin = new Set<string>();
	for (const m of adminGroups) for (const u of await membersOf(m.groupId)) shouldBeAdmin.add(u);
	for (const u of shouldBeAdmin) {
		const { changes } = await db.run("UPDATE members SET role = 'admin', role_source = 'directory' WHERE org_id = ? AND user_id = ? AND role = 'member'", [orgId, u]);
		if (changes) {
			res.adminsAdded++;
			await record(db, { orgId, actorId: null, action: 'member.updated', subject: u, summary: `Made admin by directory group membership`, data: { role: { from: 'member', to: 'admin' }, userId: u } });
		}
	}
	const directoryAdmins = await db.all<{ user_id: string }>("SELECT user_id FROM members WHERE org_id = ? AND role = 'admin' AND role_source = 'directory'", [orgId]);
	for (const a of directoryAdmins) {
		if (shouldBeAdmin.has(a.user_id)) continue;
		await db.run("UPDATE members SET role = 'member', role_source = 'manual' WHERE org_id = ? AND user_id = ?", [orgId, a.user_id]);
		await record(db, { orgId, actorId: null, action: 'member.updated', subject: a.user_id, summary: 'Admin role removed: no longer in a mapped directory group', data: { role: { from: 'admin', to: 'member' }, userId: a.user_id } });
		res.adminsRemoved++;
	}

	// 3. Access detected from groups. The IdP grants it, so it's recorded (and ended) directly.
	const wanted = new Map<string, { userId: string; resourceId: string; roleId: string; groupId: string }>();
	for (const m of mappings.filter((x) => x.target === 'access' && x.roleId && x.resourceId)) {
		for (const u of await membersOf(m.groupId)) wanted.set(`${u}:${m.roleId}`, { userId: u, resourceId: m.resourceId!, roleId: m.roleId!, groupId: m.groupId });
	}
	for (const w of wanted.values()) {
		const held = await db.get("SELECT 1 FROM grants WHERE org_id = ? AND user_id = ? AND role_id = ? AND status <> 'revoked'", [orgId, w.userId, w.roleId]);
		if (held) continue;
		const gname = await groupName(w.groupId);
		await db.run(
			"INSERT INTO grants (id, org_id, user_id, resource_id, role_id, status, source, idp_group, note, granted_at) VALUES (?, ?, ?, ?, ?, 'active', 'idp', ?, ?, ?)",
			[newId(), orgId, w.userId, w.resourceId, w.roleId, w.groupId, `IdP group ${gname}`, now()]
		);
		const label = await db.get<{ r: string; l: string; p: number; e: string }>(
			'SELECT r.name AS r, rr.name AS l, rr.privileged AS p, u.email AS e FROM resource_roles rr JOIN resources r ON r.id = rr.resource_id JOIN users u ON u.id = ? WHERE rr.id = ?',
			[w.userId, w.roleId]
		);
		await record(db, {
			orgId,
			actorId: null,
			action: 'grant.detected',
			subject: label?.r ?? '',
			summary: `Detected in the IdP without a request: ${label?.e} has ${label?.r} (${label?.l})${label?.p ? ' [privileged]' : ''} via group ${gname}`,
			data: { userId: w.userId, roleId: w.roleId, group: gname, privileged: !!label?.p }
		});
		res.grantsDetected++;
	}
	const detected = await db.all<{ id: string; user_id: string; role_id: string; idp_group: string }>(
		"SELECT id, user_id, role_id, idp_group FROM grants WHERE org_id = ? AND source = 'idp' AND status = 'active'",
		[orgId]
	);
	for (const g of detected) {
		if (wanted.has(`${g.user_id}:${g.role_id}`)) continue;
		await db.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", [now(), g.id]);
		await record(db, { orgId, actorId: null, action: 'grant.revoked', subject: g.idp_group, summary: `Access ended in the IdP (removed from group ${await groupName(g.idp_group)})`, data: { grantId: g.id } });
		res.grantsEnded++;
	}

	const stats = {
		users: dusers.length,
		active: dusers.filter((u) => u.active).length,
		groups: (await db.get<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM directory_groups WHERE org_id = ?', [orgId]))!.n,
		unmatched: res.unmatched
	};
	await db.run("UPDATE directory_sources SET last_sync_at = ?, last_error = '', stats = ? WHERE org_id = ?", [now(), JSON.stringify(stats), orgId]);
	return res;
}

export async function recordSyncError(db: Db, orgId: string, message: string) {
	await db.run('UPDATE directory_sources SET last_error = ?, last_sync_at = ? WHERE org_id = ?', [message.slice(0, 500), now(), orgId]);
}

// ── Pull sync ────────────────────────────────────────────────────────────────

/** Pulls from Google/Okta/Microsoft (not SCIM: that's pushed) and reconciles. */
export async function syncDirectory(db: Db, orgId: string, fx: Effects, f: typeof fetch = fetch): Promise<ReconcileResult> {
	const source = await getSource(db, orgId);
	if (!source) throw badRequest('Connect a directory first');
	if (source.kind !== 'scim') {
		try {
			const snap =
				source.kind === 'google'
					? await (await import('./idp/google.ts')).pullGoogle(source.config as never, f)
					: source.kind === 'okta'
						? await (await import('./idp/okta.ts')).pullOkta(source.config as never, f)
						: await (await import('./idp/entra.ts')).pullEntra(source.config as never, f);
			if (!snap.users.length) throw new Error('The directory returned no users; check the account’s permissions');
			await replaceSnapshot(db, orgId, snap.users, snap.groups);
		} catch (err) {
			await recordSyncError(db, orgId, (err as Error).message);
			throw err;
		}
	}
	const res = await reconcile(db, orgId, fx);
	await record(db, {
		orgId,
		actorId: null,
		action: 'directory.synced',
		summary: `Directory sync: ${res.created} added, ${res.deactivated} deactivated, ${res.grantsDetected} grants detected, ${res.grantsEnded} ended`,
		data: { ...res }
	});
	return res;
}
