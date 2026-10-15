import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { closeGrantRecord, listGrants, recordGrant } from './grants.ts';
import { badRequest, conflict, notFound } from './http.ts';
import type { Fetch, MemberAccount } from './idp/http.ts';
import type { Actor } from './requests.ts';
import { getResource } from './resources.ts';
import { RECONCILIATION_ACTIONS, RECONCILIATION_RESOLUTION, RECONCILIATION_STATUS } from '#lib/format.ts';
import type { LevelMapping, Reconciliation, ReconciliationCounts, ReconciliationItem, ReconciliationResolution, ReconciliationStatus, Resource } from '#lib/types.ts';

/**
 * Reconciliation: compare a system's real user list (a CSV export, or the members of the
 * IdP groups its levels map to) with the access ac·modern records for it. Auditors call
 * this completeness: every account in the system was approved, and every record is real.
 * Each run is kept as evidence, and every finding is resolved with a reason.
 */

const now = () => new Date().toISOString();

/** An account in the system, with the access levels (names) it has there; none when unknown. */
export interface SourceAccount extends MemberAccount {
	levels: string[];
}

// ── Reading a CSV export ─────────────────────────────────────────────────────

/** RFC 4180-ish: quotes, doubled quotes, and a comma, semicolon or tab separator (guessed from the first line). */
export function parseCsv(text: string): string[][] {
	const src = text.replace(/^﻿/, '');
	const first = src.split(/\r?\n/, 1)[0] ?? '';
	const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1]);
	const sep = counts[0][1] > 1 ? counts[0][0] : ',';
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"' && src[i + 1] === '"') (cell += '"'), i++;
			else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell === '') quoted = true;
		else if (c === sep) row.push(cell), (cell = '');
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && src[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			(row = []), (cell = '');
		} else cell += c;
	}
	if (cell !== '' || row.length) row.push(cell), rows.push(row);
	return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some(Boolean));
}

const EMAIL_HEAD = /^(e-?mail|e-?mail ?address|mail|primary ?e-?mail|work ?e-?mail|user ?principal ?name|upn|email_address|user_email)$/i;
const LOGIN_HEAD = /^(user ?name|username|user_name|login|user|account|account ?name|handle|github|github ?login|user ?id|user_login|sam ?account ?name|member)$/i;
const NAME_HEAD = /^(name|full ?name|display ?name|displayname)$/i;
const LEVEL_HEAD = /(role|level|access|permission|privilege|group|team|type|plan|seat)/i;

/**
 * Reads a user-list export: finds the email or username column (and a role/level and name
 * column if there are any) by header, or, without headers, by the column that holds emails.
 */
export function parseAccounts(text: string): { accounts: SourceAccount[]; columns: { email?: string; login?: string; level?: string; name?: string } } {
	const rows = parseCsv(text);
	if (!rows.length) throw badRequest('The file is empty');
	const head = rows[0];
	const looksLikeHeader = !head.some((v) => v.includes('@')) && (head.some((h) => EMAIL_HEAD.test(h) || LOGIN_HEAD.test(h) || NAME_HEAD.test(h) || /e-?mail/i.test(h)) || rows.length === 1);
	const find = (test: (h: string) => boolean, skip: number[] = []) => head.findIndex((h, i) => !skip.includes(i) && test(h));
	let email = -1;
	let login = -1;
	let level = -1;
	let name = -1;
	let body = rows;
	if (looksLikeHeader) {
		body = rows.slice(1);
		email = find((h) => EMAIL_HEAD.test(h));
		if (email < 0) email = find((h) => /e-?mail/i.test(h));
		login = find((h) => LOGIN_HEAD.test(h), [email]);
		name = find((h) => NAME_HEAD.test(h), [email, login]);
		level = find((h) => LEVEL_HEAD.test(h) && !/e-?mail|name/i.test(h), [email, login, name]);
		if (email < 0 && login < 0) throw badRequest(`Couldn’t find an email or username column. The columns are: ${head.join(', ')}`);
	} else {
		const width = Math.max(...rows.map((r) => r.length));
		for (let i = 0; i < width && email < 0; i++) if (rows.filter((r) => (r[i] ?? '').includes('@')).length >= rows.length / 2) email = i;
		// Without headers, only a column of emails, or a plain one-column list of usernames, is safe to read.
		if (email < 0 && width > 1) throw badRequest('Couldn’t find an email or username column. Add a header row (e.g. “email”, “username”, “role”).');
		if (email < 0) login = 0;
	}
	const accounts: SourceAccount[] = [];
	for (const r of body) {
		const e = email >= 0 ? (r[email] ?? '').trim() : '';
		const l = login >= 0 ? (r[login] ?? '').trim() : '';
		if (!e && !l) continue;
		const levels = level >= 0 ? (r[level] ?? '').split(/[;|]/).map((v) => v.trim()).filter(Boolean) : [];
		accounts.push({
			email: e.includes('@') ? e.toLowerCase() : l.includes('@') ? l.toLowerCase() : undefined,
			login: l && !l.includes('@') ? l : e && !e.includes('@') ? e : undefined,
			name: name >= 0 ? r[name] || undefined : undefined,
			levels
		});
	}
	if (!accounts.length) throw badRequest('No accounts found in the file');
	return { accounts, columns: { email: head[email] && looksLikeHeader ? head[email] : undefined, login: looksLikeHeader && login >= 0 ? head[login] : undefined, level: level >= 0 ? head[level] : undefined, name: name >= 0 ? head[name] : undefined } };
}

// ── Pulling from the connected system ────────────────────────────────────────

/** Members of the groups, teams or app assignments each level is set up through. */
export async function pullAccounts(db: Db, orgId: string, resource: Resource, f: Fetch = fetch): Promise<SourceAccount[]> {
	if (resource.fulfillment !== 'integration' || !resource.integration) throw badRequest(`${resource.name} isn’t set up through an integration, so upload its user list instead`);
	const { getIntegration } = await import('./integrations.ts');
	const cfg = await getIntegration<Record<string, string>>(db, orgId, resource.integration);
	const { INTEGRATIONS } = await import('#lib/integrations.ts');
	if (!cfg) throw badRequest(`${INTEGRATIONS[resource.integration].name} isn’t connected (Settings → Integrations)`);
	if (!resource.roles.some((r) => resource.integrationMap[r.id])) throw badRequest(`None of ${resource.name}’s levels are mapped in ${INTEGRATIONS[resource.integration].name}`);
	const byKey = new Map<string, SourceAccount>();
	for (const role of resource.roles) {
		const level = resource.integrationMap[role.id] as LevelMapping | undefined;
		if (!level) continue;
		let members: MemberAccount[] = [];
		const lv = level as never;
		switch (resource.integration) {
			case 'okta':
				members = await (await import('./idp/okta.ts')).oktaMembers(cfg as never, lv, f);
				break;
			case 'authentik':
				members = await (await import('./idp/authentik.ts')).authentikMembers(cfg as never, lv, f);
				break;
			case 'entra':
				members = await (await import('./idp/entra.ts')).entraMembers(cfg as never, lv, f);
				break;
			case 'google':
				members = await (await import('./idp/google.ts')).googleMembers(cfg as never, lv, f);
				break;
			case 'github':
				members = await (await import('./idp/github.ts')).githubMembers(cfg as never, lv, f);
				break;
		}
		for (const m of members) {
			const key = (m.email || m.login || '').toLowerCase();
			if (!key) continue;
			const a = byKey.get(key) ?? { ...m, levels: [] };
			if (!a.levels.includes(role.name)) a.levels.push(role.name);
			byKey.set(key, a);
		}
	}
	return [...byKey.values()];
}

// ── Comparing ────────────────────────────────────────────────────────────────

interface Person {
	id: string;
	name: string;
	email: string;
	github_login: string;
	status: 'active' | 'deactivated';
}

/**
 * Compares the accounts with the resource's recorded access and stores the result.
 * Accounts are matched to members by email, or by GitHub username; levels by name.
 */
export async function runReconciliation(
	db: Db,
	actor: Actor & { userId: string },
	resourceId: string,
	input: { source: 'csv' | 'idp'; filename: string; accounts: SourceAccount[] }
): Promise<string> {
	const resource = await getResource(db, actor.orgId, resourceId);
	const people = await db.all<Person>(
		'SELECT u.id, u.name, u.email, u.github_login, m.status FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?',
		[actor.orgId]
	);
	const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]));
	const byLogin = new Map(people.filter((p) => p.github_login).map((p) => [p.github_login.toLowerCase(), p]));
	const grants = await listGrants(db, actor.orgId, { resourceId: resource.id, statuses: ['active', 'pending_revoke'] });
	const roleByName = new Map(resource.roles.map((r) => [r.name.toLowerCase(), r]));

	// One entry per person (several rows or logins can be the same person), or per unknown account.
	const entries = new Map<string, { account: string; person: Person | null; levels: Set<string> }>();
	for (const a of input.accounts) {
		const person = (a.email && byEmail.get(a.email.toLowerCase())) || (a.login && (byLogin.get(a.login.toLowerCase()) ?? byEmail.get(a.login.toLowerCase()))) || null;
		const key = person ? `user:${person.id}` : `acct:${(a.email || a.login || '').toLowerCase()}`;
		const e = entries.get(key) ?? { account: a.email || a.login || '', person, levels: new Set<string>() };
		for (const l of a.levels) e.levels.add(l);
		entries.set(key, e);
	}

	type Item = { account: string; userId: string | null; grantId: string | null; roleId: string | null; status: ReconciliationStatus; level: string; detail: string };
	const items: Item[] = [];
	const seen = new Set<string>();
	const lc = (xs: Iterable<string>) => [...xs].map((x) => x.toLowerCase()).sort();
	for (const e of entries.values()) {
		const held = e.person ? grants.filter((g) => g.user.id === e.person!.id) : [];
		const sysLevels = [...e.levels];
		const oneRole = sysLevels.length === 1 ? (roleByName.get(sysLevels[0].toLowerCase())?.id ?? null) : null;
		if (e.person) seen.add(e.person.id);
		if (held.length) {
			const recorded = held.map((g) => g.role.name);
			const same = !sysLevels.length || JSON.stringify(lc(new Set(sysLevels))) === JSON.stringify(lc(new Set(recorded)));
			items.push({
				account: e.account,
				userId: e.person!.id,
				grantId: held[0].id,
				roleId: same ? held[0].role.id : oneRole,
				status: same ? 'matched' : 'level_mismatch',
				level: sysLevels.length ? sysLevels.join(', ') : recorded.join(', '),
				detail: same ? '' : `ac·modern records ${recorded.join(', ')}`
			});
			continue;
		}
		items.push({
			account: e.account,
			userId: e.person?.id ?? null,
			grantId: null,
			roleId: oneRole ?? (resource.roles.length === 1 ? resource.roles[0].id : null),
			status: 'unknown',
			level: sysLevels.join(', '),
			detail: !e.person ? 'Not a member of ac·modern' : e.person.status === 'deactivated' ? 'Deactivated in ac·modern: they still have an account here' : 'No access recorded in ac·modern'
		});
	}
	for (const g of grants) {
		if (seen.has(g.user.id)) continue;
		items.push({ account: g.user.email, userId: g.user.id, grantId: g.id, roleId: g.role.id, status: 'missing', level: g.role.name, detail: g.status === 'pending_revoke' ? 'A removal is already under way' : 'Recorded in ac·modern, not in the system' });
	}

	const counts: ReconciliationCounts = {
		accounts: entries.size,
		matched: items.filter((i) => i.status === 'matched').length,
		unknown: items.filter((i) => i.status === 'unknown').length,
		missing: items.filter((i) => i.status === 'missing').length,
		level_mismatch: items.filter((i) => i.status === 'level_mismatch').length
	};
	const id = newId();
	const { INTEGRATIONS } = await import('#lib/integrations.ts');
	const from = input.source === 'csv' ? input.filename || 'an uploaded user list' : resource.integration ? INTEGRATIONS[resource.integration].name : 'the IdP';
	await db.tx(async (tx) => {
		await tx.run('INSERT INTO reconciliations (id, org_id, resource_id, source, filename, run_by, created_at, counts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
			id,
			actor.orgId,
			resource.id,
			input.source,
			input.filename,
			actor.userId,
			now(),
			JSON.stringify(counts)
		]);
		for (const i of items)
			await tx.run(
				'INSERT INTO reconciliation_items (id, org_id, reconciliation_id, account, user_id, grant_id, role_id, status, level, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
				[newId(), actor.orgId, id, i.account, i.userId, i.grantId, i.roleId, i.status, i.level, i.detail]
			);
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'reconciliation.run',
			subject: resource.name,
			summary: `Reconciled ${resource.name} with ${from}: ${counts.accounts} accounts, ${counts.matched} matched, ${counts.unknown} not in ac·modern, ${counts.missing} not in the system, ${counts.level_mismatch} with a different level`,
			data: { reconciliationId: id, source: input.source, filename: input.filename, counts }
		});
	});
	return id;
}

// ── Resolving findings ───────────────────────────────────────────────────────

export async function resolveItem(db: Db, actor: Actor & { userId: string }, itemId: string, input: { resolution: ReconciliationResolution; note: string; roleId?: string | null }) {
	const item = await db.get<{ id: string; reconciliation_id: string; resource_id: string; account: string; user_id: string | null; grant_id: string | null; role_id: string | null; status: ReconciliationStatus; resolution: string | null }>(
		`SELECT i.id, i.reconciliation_id, r.resource_id, i.account, i.user_id, i.grant_id, i.role_id, i.status, i.resolution FROM reconciliation_items i
		 JOIN reconciliations r ON r.id = i.reconciliation_id WHERE i.org_id = ? AND i.id = ?`,
		[actor.orgId, itemId]
	);
	if (!item) throw notFound('That finding doesn’t exist');
	if (item.resolution) throw conflict('That finding is already resolved');
	if (!RECONCILIATION_ACTIONS[item.status].includes(input.resolution)) throw badRequest(item.status === 'matched' ? 'Matched accounts need nothing doing' : 'That doesn’t apply to this finding');
	const note = input.note.trim();
	if (note.length < 3) throw badRequest('Say why, for the record');
	const resource = await getResource(db, actor.orgId, item.resource_id);

	if (input.resolution === 'recorded') {
		if (!item.user_id) throw badRequest('This account isn’t a member of ac·modern, so there’s nobody to record it for');
		const roleId = input.roleId || item.role_id;
		if (!roleId) throw badRequest('Pick the access level they have');
		await recordGrant(db, actor, { userId: item.user_id, resourceId: resource.id, roleId, expiresAt: null, note: `Found by reconciliation: ${note}`, source: 'import' });
	} else if (input.resolution === 'closed') {
		if (!item.grant_id) throw badRequest('There’s no record to close');
		await closeGrantRecord(db, actor, item.grant_id, `Not in ${resource.name} (reconciliation): ${note}`);
	}
	await db.run('UPDATE reconciliation_items SET resolution = ?, resolved_by = ?, resolved_at = ?, note = ? WHERE id = ?', [input.resolution, actor.userId, now(), note, item.id]);
	await record(db, {
		orgId: actor.orgId,
		actorId: actor.userId,
		action: 'reconciliation.resolved',
		subject: resource.name,
		summary: `${RECONCILIATION_RESOLUTION[input.resolution]}: ${item.account} on ${resource.name}: “${note}”`,
		data: { reconciliationId: item.reconciliation_id, itemId: item.id, status: item.status, resolution: input.resolution, note }
	});
}

// ── Reading runs ─────────────────────────────────────────────────────────────

interface RunRow {
	id: string;
	resource_id: string;
	resource_name: string;
	resource_color: string;
	source: 'csv' | 'idp';
	filename: string;
	run_by: string | null;
	run_by_name: string | null;
	run_by_email: string | null;
	created_at: string;
	counts: string;
	unresolved: number;
}

const RUN_SELECT = `SELECT c.id, c.resource_id, r.name AS resource_name, r.color AS resource_color, c.source, c.filename, c.run_by, u.name AS run_by_name, u.email AS run_by_email, c.created_at, c.counts,
	(SELECT CAST(COUNT(*) AS INTEGER) FROM reconciliation_items i WHERE i.reconciliation_id = c.id AND i.status <> 'matched' AND i.resolution IS NULL) AS unresolved
	FROM reconciliations c JOIN resources r ON r.id = c.resource_id LEFT JOIN users u ON u.id = c.run_by`;

const toRun = (r: RunRow): Reconciliation => ({
	id: r.id,
	resource: { id: r.resource_id, name: r.resource_name, color: r.resource_color },
	source: r.source,
	filename: r.filename,
	runBy: r.run_by ? { id: r.run_by, name: r.run_by_name ?? '', email: r.run_by_email ?? '' } : null,
	createdAt: r.created_at,
	counts: JSON.parse(r.counts || '{}'),
	unresolved: Number(r.unresolved ?? 0)
});

export async function listReconciliations(db: Db, orgId: string, f: { resourceId?: string; from?: string; to?: string } = {}): Promise<Reconciliation[]> {
	const where = ['c.org_id = ?'];
	const params: string[] = [orgId];
	if (f.resourceId) where.push('c.resource_id = ?'), params.push(f.resourceId);
	if (f.from) where.push('c.created_at >= ?'), params.push(f.from);
	if (f.to) where.push('c.created_at < ?'), params.push(f.to);
	return (await db.all<RunRow>(`${RUN_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC`, params)).map(toRun);
}

export async function getReconciliation(db: Db, orgId: string, id: string): Promise<Reconciliation> {
	const r = await db.get<RunRow>(`${RUN_SELECT} WHERE c.org_id = ? AND c.id = ?`, [orgId, id]);
	if (!r) throw notFound('That reconciliation doesn’t exist');
	return toRun(r);
}

const STATUS_ORDER: Record<ReconciliationStatus, number> = { unknown: 0, level_mismatch: 1, missing: 2, matched: 3 };

export async function reconciliationItems(db: Db, orgId: string, id: string): Promise<ReconciliationItem[]> {
	const rows = await db.all<{
		id: string;
		account: string;
		user_id: string | null;
		uname: string | null;
		uemail: string | null;
		mstatus: 'active' | 'deactivated' | null;
		grant_id: string | null;
		role_id: string | null;
		status: ReconciliationStatus;
		level: string;
		detail: string;
		resolution: ReconciliationResolution | null;
		resolver: string | null;
		resolved_at: string | null;
		note: string;
	}>(
		`SELECT i.id, i.account, i.user_id, u.name AS uname, u.email AS uemail, m.status AS mstatus, i.grant_id, i.role_id, i.status, i.level, i.detail, i.resolution,
			COALESCE(NULLIF(ru.name, ''), ru.email) AS resolver, i.resolved_at, i.note
		 FROM reconciliation_items i
		 LEFT JOIN users u ON u.id = i.user_id
		 LEFT JOIN members m ON m.user_id = i.user_id AND m.org_id = i.org_id
		 LEFT JOIN users ru ON ru.id = i.resolved_by
		 WHERE i.org_id = ? AND i.reconciliation_id = ?`,
		[orgId, id]
	);
	return rows
		.map((r) => ({
			id: r.id,
			account: r.account,
			user: r.user_id ? { id: r.user_id, name: r.uname ?? '', email: r.uemail ?? '', member: r.mstatus } : null,
			grantId: r.grant_id,
			roleId: r.role_id,
			status: r.status,
			level: r.level,
			detail: r.detail,
			resolution: r.resolution,
			resolvedBy: r.resolver,
			resolvedAt: r.resolved_at,
			note: r.note
		}))
		.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.account.localeCompare(b.account));
}

/** The run as evidence: every account and grant compared, with how each finding was resolved. */
export function reconciliationCsv(run: Reconciliation, items: ReconciliationItem[]): string {
	const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
	const head = ['system', 'reconciled_at', 'source', 'file', 'run_by', 'account', 'person', 'person_email', 'status', 'level', 'detail', 'resolution', 'resolved_by', 'resolved_at', 'note'];
	const lines = items.map((i) =>
		[
			run.resource.name,
			run.createdAt,
			run.source === 'csv' ? 'uploaded list' : 'pulled from integration',
			run.filename,
			run.runBy ? run.runBy.name || run.runBy.email : '',
			i.account,
			i.user?.name ?? '',
			i.user?.email ?? '',
			RECONCILIATION_STATUS[i.status],
			i.level,
			i.detail,
			i.resolution ? RECONCILIATION_RESOLUTION[i.resolution] : i.status === 'matched' ? '' : 'unresolved',
			i.resolvedBy ?? '',
			i.resolvedAt ?? '',
			i.note
		]
			.map(cell)
			.join(',')
	);
	return [head.join(','), ...lines].join('\n');
}
