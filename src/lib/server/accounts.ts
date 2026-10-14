import { encrypt, decrypt, newId, randomToken, sha256 } from './crypto.ts';
import type { Db } from './db.ts';
import { badRequest, conflict, notFound } from './http.ts';
import type { Membership, Org, OrgSettings, Person, Role, SessionUser } from '#lib/types.ts';

const now = () => new Date().toISOString();
export const normEmail = (e: string) => e.trim().toLowerCase();
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'team'
	);
}

// ── Organisations ────────────────────────────────────────────────────────────

export async function countOrgs(db: Db): Promise<number> {
	return (await db.get<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM orgs'))!.n;
}

export async function createOrg(db: Db, name: string): Promise<Org> {
	const base = slugify(name);
	const taken = new Set(
		(await db.all<{ slug: string }>('SELECT slug FROM orgs WHERE slug = ? OR slug LIKE ?', [base, `${base}-%`])).map((r) => r.slug)
	);
	let n = 1;
	const next = () => {
		let slug = n === 1 ? base : `${base}-${n}`;
		while (taken.has(slug)) slug = `${base}-${++n}`;
		taken.add(slug);
		return slug;
	};
	const id = newId();
	// ON CONFLICT: another sign-up may take the same slug between the read and the insert.
	for (let attempt = 0; attempt < 20; attempt++) {
		const slug = next();
		const { changes } = await db.run('INSERT INTO orgs (id, name, slug, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING', [id, name.trim(), slug, now()]);
		if (changes) return { id, name: name.trim(), slug };
	}
	throw conflict('Couldn’t pick a unique address for that organisation; try a different name');
}

export async function getOrg(db: Db, id: string): Promise<Org | undefined> {
	return db.get<Org>('SELECT id, name, slug FROM orgs WHERE id = ?', [id]);
}

export async function renameOrg(db: Db, id: string, name: string) {
	await db.run('UPDATE orgs SET name = ? WHERE id = ?', [name, id]);
}

/** Org settings with secrets decrypted. */
export async function orgSettings(db: Db, orgId: string): Promise<OrgSettings> {
	const row = await db.get<{ settings: string }>('SELECT settings FROM orgs WHERE id = ?', [orgId]);
	const s = JSON.parse(row?.settings || '{}') as OrgSettings;
	if (s.slackWebhook) {
		try {
			s.slackWebhook = decrypt(s.slackWebhook, `org:${orgId}:slack`);
		} catch {
			s.slackWebhook = undefined;
		}
	}
	return s;
}

export async function saveOrgSettings(db: Db, orgId: string, patch: Partial<OrgSettings>) {
	const current = await orgSettings(db, orgId);
	const next = { ...current, ...patch };
	const stored = { ...next, slackWebhook: next.slackWebhook ? encrypt(next.slackWebhook, `org:${orgId}:slack`) : undefined };
	await db.run('UPDATE orgs SET settings = ? WHERE id = ?', [JSON.stringify(stored), orgId]);
}

/** Next human-friendly request number for an org (#1, #2, …). Call inside a transaction. */
export async function nextRequestNumber(db: Db, orgId: string): Promise<number> {
	await db.run('UPDATE orgs SET request_seq = request_seq + 1 WHERE id = ?', [orgId]);
	return (await db.get<{ n: number }>('SELECT request_seq AS n FROM orgs WHERE id = ?', [orgId]))!.n;
}

// ── Users and membership ─────────────────────────────────────────────────────

export async function countUsers(db: Db): Promise<number> {
	return (await db.get<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users'))!.n;
}

export async function userByEmail(db: Db, email: string) {
	return db.get<SessionUser & { password_hash: string | null }>('SELECT id, email, name, password_hash FROM users WHERE email = ?', [normEmail(email)]);
}

export async function createUser(db: Db, u: { email: string; name: string; passwordHash: string | null }): Promise<SessionUser> {
	const email = normEmail(u.email);
	if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address');
	if (await userByEmail(db, email)) throw conflict('An account with that email already exists');
	const user = { id: newId(), email, name: u.name.trim() };
	await db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [user.id, email, user.name, u.passwordHash, now()]);
	return user;
}

export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export async function updateUser(db: Db, id: string, patch: { name?: string; passwordHash?: string; githubLogin?: string }) {
	if (patch.githubLogin !== undefined) {
		const login = patch.githubLogin.trim().replace(/^@/, '');
		if (login && !GITHUB_LOGIN_RE.test(login)) throw badRequest('That isn’t a valid GitHub username');
		await db.run('UPDATE users SET github_login = ? WHERE id = ?', [login, id]);
	}
	if (patch.name !== undefined) await db.run('UPDATE users SET name = ? WHERE id = ?', [patch.name, id]);
	if (patch.passwordHash !== undefined) await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [patch.passwordHash, id]);
}

export async function addMember(db: Db, orgId: string, userId: string, role: Role) {
	await db.run(
		`INSERT INTO members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active'`,
		[orgId, userId, role, now()]
	);
}

export async function membership(db: Db, orgId: string, userId: string): Promise<{ role: Role } | undefined> {
	return db.get<{ role: Role }>("SELECT role FROM members WHERE org_id = ? AND user_id = ? AND status = 'active'", [orgId, userId]);
}

export async function membershipsOf(db: Db, userId: string): Promise<Membership[]> {
	return db.all<Membership>(
		`SELECT m.org_id AS "orgId", o.name AS "orgName", m.role FROM members m JOIN orgs o ON o.id = m.org_id
		 WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.name`,
		[userId]
	);
}

interface PersonRow {
	id: string;
	email: string;
	name: string;
	role: Role;
	title: string;
	manager_id: string | null;
	status: 'active' | 'deactivated';
	joined_at: string;
	last_login_at: string | null;
}

const toPerson = (r: PersonRow): Person => ({
	id: r.id,
	email: r.email,
	name: r.name,
	role: r.role,
	title: r.title,
	managerId: r.manager_id,
	status: r.status,
	joinedAt: r.joined_at,
	lastLoginAt: r.last_login_at
});

const PERSON = `SELECT u.id, u.email, u.name, m.role, m.title, m.manager_id, m.status, m.joined_at, u.last_login_at
	FROM members m JOIN users u ON u.id = m.user_id`;

export async function listPeople(db: Db, orgId: string, opts: { includeDeactivated?: boolean } = {}): Promise<Person[]> {
	const rows = await db.all<PersonRow>(
		`${PERSON} WHERE m.org_id = ? ${opts.includeDeactivated ? '' : "AND m.status = 'active'"} ORDER BY m.status, LOWER(CASE WHEN u.name = '' THEN u.email ELSE u.name END)`,
		[orgId]
	);
	return rows.map(toPerson);
}

export async function getPerson(db: Db, orgId: string, userId: string): Promise<Person> {
	const r = await db.get<PersonRow>(`${PERSON} WHERE m.org_id = ? AND u.id = ?`, [orgId, userId]);
	if (!r) throw notFound('That person isn’t in this organisation');
	return toPerson(r);
}

export async function updateMember(db: Db, orgId: string, userId: string, patch: { role?: Role; title?: string; managerId?: string | null; status?: 'active' | 'deactivated' }) {
	const sets: string[] = [];
	const params: (string | null)[] = [];
	if (patch.role) sets.push('role = ?', "role_source = 'manual'"), params.push(patch.role);
	if (patch.title !== undefined) sets.push('title = ?'), params.push(patch.title);
	if (patch.managerId !== undefined) sets.push('manager_id = ?'), params.push(patch.managerId);
	if (patch.status) sets.push('status = ?', "deactivated_by = ''"), params.push(patch.status);
	if (!sets.length) return;
	await db.run(`UPDATE members SET ${sets.join(', ')} WHERE org_id = ? AND user_id = ?`, [...params, orgId, userId]);
}

export async function countOwners(db: Db, orgId: string): Promise<number> {
	return (await db.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM members WHERE org_id = ? AND role = 'owner' AND status = 'active'", [orgId]))!.n;
}

/** Admins and owners: the fallback approvers and fulfillers. */
export async function adminIds(db: Db, orgId: string): Promise<string[]> {
	return (await db.all<{ user_id: string }>("SELECT user_id FROM members WHERE org_id = ? AND role IN ('owner', 'admin') AND status = 'active'", [orgId])).map((r) => r.user_id);
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(db: Db, userId: string, orgId: string | null, method: 'password' | 'sso' = 'password'): Promise<string> {
	const token = randomToken();
	await db.run('INSERT INTO sessions (id, user_id, org_id, auth_method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
		sha256(token),
		userId,
		orgId,
		method,
		now(),
		new Date(Date.now() + SESSION_TTL_MS).toISOString()
	]);
	await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), userId]);
	return token;
}

export async function sessionByToken(db: Db, token: string) {
	return db.get<{ id: string; user_id: string; org_id: string | null; auth_method: string; email: string; name: string }>(
		`SELECT s.id, s.user_id, s.org_id, s.auth_method, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
		[sha256(token), now()]
	);
}

export async function setSessionOrg(db: Db, sessionId: string, orgId: string) {
	await db.run('UPDATE sessions SET org_id = ? WHERE id = ?', [orgId, sessionId]);
}

export async function deleteSession(db: Db, token: string) {
	await db.run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
}

export async function deleteUserSessions(db: Db, userId: string, exceptId?: string) {
	await db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, exceptId ?? '']);
}

// ── Invites ──────────────────────────────────────────────────────────────────

export const INVITE_TTL_DAYS = 14;

export async function createInvite(db: Db, orgId: string, email: string, role: Role, invitedBy: string): Promise<{ id: string; token: string }> {
	email = normEmail(email);
	if (!EMAIL_RE.test(email)) throw badRequest(`“${email}” isn’t a valid email address`);
	const existing = await db.get<{ status: string }>('SELECT m.status FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?', [orgId, email]);
	if (existing?.status === 'active') throw conflict(`${email} is already a member`);
	// One live invite per address: a new one replaces the old link.
	await db.run('DELETE FROM invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL', [orgId, email]);
	const token = randomToken(24);
	const id = newId();
	await db.run('INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
		id,
		orgId,
		email,
		role,
		sha256(token),
		invitedBy,
		now(),
		new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString()
	]);
	return { id, token };
}

export async function inviteByToken(db: Db, token: string) {
	return db.get<{ id: string; org_id: string; org_name: string; email: string; role: Role; inviter: string | null }>(
		`SELECT i.id, i.org_id, o.name AS org_name, i.email, i.role, COALESCE(NULLIF(u.name, ''), u.email) AS inviter
		 FROM invites i JOIN orgs o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.invited_by
		 WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`,
		[sha256(token), now()]
	);
}

export async function markInviteAccepted(db: Db, id: string) {
	await db.run('UPDATE invites SET accepted_at = ? WHERE id = ?', [now(), id]);
}

export async function listInvites(db: Db, orgId: string) {
	return db.all<{ id: string; email: string; role: Role; createdAt: string; expiresAt: string }>(
		`SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt" FROM invites
		 WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
		[orgId, now()]
	);
}

export async function revokeInvite(db: Db, orgId: string, id: string) {
	await db.run('DELETE FROM invites WHERE org_id = ? AND id = ?', [orgId, id]);
}
