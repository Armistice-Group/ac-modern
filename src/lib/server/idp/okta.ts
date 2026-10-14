import type { DirectoryGroup, DirectoryUser } from '../directory.ts';
import { type Fetch, jsonOrThrow, ProviderError } from './http.ts';

/** Okta's Users and Groups APIs, with an API token (read-only admin is enough for pulls). */
export interface OktaConfig {
	domain: string;
	apiToken: string;
}

const base = (cfg: OktaConfig) => `https://${cfg.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;

async function pages<T>(cfg: OktaConfig, f: Fetch, path: string): Promise<T[]> {
	const out: T[] = [];
	let url: string | null = `${base(cfg)}${path}`;
	while (url) {
		const res: Response = await f(url, { headers: { authorization: `SSWS ${cfg.apiToken}`, accept: 'application/json' } });
		out.push(...(await jsonOrThrow<T[]>(res, `Okta ${new URL(url).pathname}`)));
		const link = res.headers.get('link') ?? '';
		url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
	}
	return out;
}

interface OUser {
	id: string;
	status: string;
	profile: { login: string; email?: string; firstName?: string; lastName?: string; displayName?: string; title?: string; managerId?: string; manager?: string };
}

export async function pullOkta(cfg: OktaConfig, f: Fetch = fetch): Promise<{ users: DirectoryUser[]; groups: DirectoryGroup[] }> {
	const ousers = await pages<OUser>(cfg, f, '/api/v1/users?limit=200');
	const users: DirectoryUser[] = ousers.map((u) => ({
		id: u.id,
		email: u.profile.email ?? u.profile.login,
		name: u.profile.displayName || [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' '),
		title: u.profile.title ?? '',
		// managerId is usually an employee number or email; it matches when it's an Okta user id or email.
		managerRef: u.profile.managerId ?? u.profile.manager ?? '',
		active: ['ACTIVE', 'PASSWORD_EXPIRED', 'LOCKED_OUT', 'RECOVERY'].includes(u.status)
	}));
	const ogroups = await pages<{ id: string; type: string; profile: { name: string } }>(cfg, f, '/api/v1/groups?limit=200');
	const groups: DirectoryGroup[] = [];
	for (const g of ogroups) {
		if (g.type === 'BUILT_IN') continue; // "Everyone"
		const members = await pages<{ id: string }>(cfg, f, `/api/v1/groups/${g.id}/users?limit=200`);
		groups.push({ id: g.id, name: g.profile.name, memberIds: members.map((m) => m.id) });
	}
	return { users, groups };
}

// ── Provisioning ─────────────────────────────────────────────────────────────
// Group membership (recommended: group-based app assignments and Group Push carry it
// into each app) or direct app assignment. Needs a token whose admin can manage the
// groups/apps (Group Membership Admin, App Admin, or Super Admin).

async function okta(cfg: OktaConfig, f: Fetch, method: string, path: string, body?: unknown) {
	return f(`${base(cfg)}${path}`, {
		method,
		headers: { authorization: `SSWS ${cfg.apiToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	});
}

export async function testOkta(cfg: OktaConfig, f: Fetch = fetch) {
	const me = await jsonOrThrow<{ profile: { login: string } }>(await okta(cfg, f, 'GET', '/api/v1/users/me'), 'Okta token');
	return { as: me.profile.login };
}

/** The Okta user for an email: by login first (usually the email), then by email attribute. */
export async function oktaUserId(cfg: OktaConfig, email: string, f: Fetch = fetch): Promise<string | null> {
	const direct = await okta(cfg, f, 'GET', `/api/v1/users/${encodeURIComponent(email)}`);
	if (direct.ok) return (await direct.json()).id;
	if (direct.status !== 404) await jsonOrThrow(direct, 'Okta user');
	const found = await jsonOrThrow<{ id: string }[]>(await okta(cfg, f, 'GET', `/api/v1/users?search=${encodeURIComponent(`profile.email eq "${email}"`)}`), 'Okta user search');
	return found[0]?.id ?? null;
}

export type OktaLevel = { type: 'okta_group' | 'okta_app'; id: string; name: string };

export async function oktaTargets(cfg: OktaConfig, f: Fetch = fetch) {
	const groups = await pages<{ id: string; type: string; profile: { name: string } }>(cfg, f, '/api/v1/groups?limit=200');
	const apps = await pages<{ id: string; label: string; status: string }>(cfg, f, '/api/v1/apps?limit=200');
	return {
		groups: groups.filter((g) => g.type === 'OKTA_GROUP').map((g) => ({ id: g.id, name: g.profile.name })),
		apps: apps.filter((a) => a.status === 'ACTIVE').map((a) => ({ id: a.id, name: a.label }))
	};
}

async function done(res: Response, what: string) {
	if (!res.ok && res.status !== 204) await jsonOrThrow(res, what);
}

export async function oktaGrant(cfg: OktaConfig, level: OktaLevel, email: string, f: Fetch = fetch): Promise<string> {
	const uid = await oktaUserId(cfg, email, f);
	if (!uid) throw new ProviderError(`${email} has no Okta account`);
	if (level.type === 'okta_group') {
		await done(await okta(cfg, f, 'PUT', `/api/v1/groups/${level.id}/users/${uid}`), 'Okta group');
		return `Okta: ${email} added to group ${level.name || level.id}`;
	}
	await done(await okta(cfg, f, 'POST', `/api/v1/apps/${level.id}/users`, { id: uid, scope: 'USER' }), 'Okta app assignment');
	return `Okta: ${level.name || level.id} assigned to ${email}`;
}

export async function oktaRevoke(cfg: OktaConfig, level: OktaLevel, email: string, f: Fetch = fetch): Promise<string> {
	const uid = await oktaUserId(cfg, email, f);
	if (!uid) return `Okta: ${email} has no Okta account, so there was nothing to remove`;
	const res =
		level.type === 'okta_group'
			? await okta(cfg, f, 'DELETE', `/api/v1/groups/${level.id}/users/${uid}`)
			: await okta(cfg, f, 'DELETE', `/api/v1/apps/${level.id}/users/${uid}`);
	if (res.status !== 404) await done(res, level.type === 'okta_group' ? 'Okta group' : 'Okta app assignment');
	return level.type === 'okta_group' ? `Okta: ${email} removed from group ${level.name || level.id}` : `Okta: ${level.name || level.id} unassigned from ${email}`;
}
