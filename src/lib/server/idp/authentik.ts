import { type Fetch, jsonOrThrow, ProviderError } from './http.ts';

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
