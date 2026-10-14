import type { DirectoryGroup, DirectoryUser } from '../directory.ts';
import { type Fetch, jsonOrThrow } from './http.ts';

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
