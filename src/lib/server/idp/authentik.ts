import type { ScannedApp } from '#lib/types.ts';
import { type Fetch, jsonOrThrow, type MemberAccount, ProviderError } from './http.ts';

/**
 * Authentik group membership through its API (/api/v3). Applications in Authentik are
 * usually gated by group policy bindings, so group membership is what grants the app.
 * Needs an API token for a user with permission to change groups (e.g. a superuser
 * service account).
 */
export interface AuthentikConfig {
	url: string;
	token: string;
}

const base = (cfg: AuthentikConfig) => cfg.url.replace(/\/+$/, '').replace(/\/api\/v3$/, '');

async function ak(cfg: AuthentikConfig, f: Fetch, method: string, path: string, body?: unknown) {
	return f(`${base(cfg)}/api/v3${path}`, {
		method,
		headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	});
}

export async function testAuthentik(cfg: AuthentikConfig, f: Fetch = fetch) {
	const me = await jsonOrThrow<{ user: { username: string } }>(await ak(cfg, f, 'GET', '/core/users/me/'), 'Authentik token');
	return { as: me.user.username };
}

export async function authentikTargets(cfg: AuthentikConfig, f: Fetch = fetch) {
	const groups: { id: string; name: string }[] = [];
	for (let page = 1; page < 50; page++) {
		const r = await jsonOrThrow<{ results: { pk: string; name: string }[]; pagination: { next: number } }>(
			await ak(cfg, f, 'GET', `/core/groups/?page_size=100&page=${page}&include_users=false&ordering=name`),
			'Authentik groups'
		);
		groups.push(...r.results.map((g) => ({ id: g.pk, name: g.name })));
		if (!r.pagination?.next) break;
	}
	return { groups };
}

async function userPk(cfg: AuthentikConfig, email: string, f: Fetch): Promise<number | null> {
	const r = await jsonOrThrow<{ results: { pk: number; email: string }[] }>(await ak(cfg, f, 'GET', `/core/users/?email=${encodeURIComponent(email)}`), 'Authentik user');
	return r.results.find((u) => u.email.toLowerCase() === email.toLowerCase())?.pk ?? null;
}

export type AuthentikLevel = { type: 'authentik_group'; id: string; name: string };

export async function authentikGrant(cfg: AuthentikConfig, level: AuthentikLevel, email: string, f: Fetch = fetch): Promise<string> {
	const pk = await userPk(cfg, email, f);
	if (pk === null) throw new ProviderError(`${email} has no Authentik account`);
	const res = await ak(cfg, f, 'POST', `/core/groups/${level.id}/add_user/`, { pk });
	if (!res.ok && res.status !== 204) await jsonOrThrow(res, 'Authentik group');
	return `Authentik: ${email} added to group ${level.name || level.id}`;
}

export async function authentikRevoke(cfg: AuthentikConfig, level: AuthentikLevel, email: string, f: Fetch = fetch): Promise<string> {
	const pk = await userPk(cfg, email, f);
	if (pk === null) return `Authentik: ${email} has no account, so there was nothing to remove`;
	const res = await ak(cfg, f, 'POST', `/core/groups/${level.id}/remove_user/`, { pk });
	if (!res.ok && res.status !== 204 && res.status !== 404) await jsonOrThrow(res, 'Authentik group');
	return `Authentik: ${email} removed from group ${level.name || level.id}`;
}

// ── App scan ─────────────────────────────────────────────────────────────────

async function all<T>(cfg: AuthentikConfig, f: Fetch, path: string, what: string): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page < 200; page++) {
		const r = await jsonOrThrow<{ results: T[]; pagination?: { next: number } }>(await ak(cfg, f, 'GET', `${path}${path.includes('?') ? '&' : '?'}page_size=100&page=${page}`), what);
		out.push(...r.results);
		if (!r.pagination?.next) break;
	}
	return out;
}

interface AkBinding {
	group: string | null;
	group_obj?: { name: string } | null;
	user: number | null;
	user_obj?: { email: string; is_active?: boolean } | null;
	policy: string | null;
	enabled: boolean;
	negate: boolean;
}

/**
 * Applications, and who each one lets in: a group binding becomes an access level that
 * provisions by group membership; user bindings become a "Direct access" level that
 * can't. No bindings at all means Authentik lets everyone in.
 */
export async function authentikApps(cfg: AuthentikConfig, f: Fetch = fetch): Promise<ScannedApp[]> {
	// superuser_full_list: every application, not just the ones the token's user can open.
	const apps = await all<{ pk: string; name: string; slug: string; launch_url?: string | null; meta_launch_url?: string; meta_description?: string }>(
		cfg,
		f,
		'/core/applications/?superuser_full_list=true&ordering=name',
		'Authentik applications'
	);
	const members = new Map<string, string[]>();
	const groupEmails = async (pk: string) => {
		if (!members.has(pk)) {
			const users = await all<{ email: string; is_active: boolean }>(cfg, f, `/core/users/?groups_by_pk=${encodeURIComponent(pk)}&is_active=true`, 'Authentik group members');
			members.set(pk, users.map((u) => u.email).filter(Boolean));
		}
		return members.get(pk)!;
	};
	const out: ScannedApp[] = [];
	for (const app of apps) {
		const bindings = (await all<AkBinding>(cfg, f, `/policies/bindings/?target=${encodeURIComponent(app.pk)}`, 'Authentik policy bindings')).filter((b) => b.enabled && !b.negate);
		const levels: ScannedApp['levels'] = [];
		for (const b of bindings) {
			if (!b.group) continue;
			const name = b.group_obj?.name ?? b.group;
			levels.push({ name, mapping: { type: 'authentik_group', id: b.group, name }, emails: await groupEmails(b.group) });
		}
		const direct = bindings.filter((b) => b.user && b.user_obj?.email && b.user_obj.is_active !== false).map((b) => b.user_obj!.email);
		if (direct.length) levels.push({ name: 'Direct access', mapping: null, emails: direct });
		out.push({
			ref: `authentik:app:${app.pk}`,
			name: app.name,
			url: app.launch_url || app.meta_launch_url || '',
			description: app.meta_description ?? '',
			openToAll: bindings.length === 0,
			levels
		});
	}
	return out;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/** Active members of an access level's group. */
export async function authentikMembers(cfg: AuthentikConfig, level: AuthentikLevel, f: Fetch = fetch): Promise<MemberAccount[]> {
	const users = await all<{ email: string; username: string; name: string; is_active: boolean }>(cfg, f, `/core/users/?groups_by_pk=${encodeURIComponent(level.id)}&is_active=true`, 'Authentik group members');
	return users.map((u) => ({ email: u.email ? u.email.toLowerCase() : undefined, login: u.username, name: u.name }));
}
