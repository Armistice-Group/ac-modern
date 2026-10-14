import { createSign } from 'node:crypto';
import type { DirectoryGroup, DirectoryUser } from '../directory.ts';
import { type Fetch, jsonOrThrow, ProviderError } from './http.ts';

/**
 * Google Workspace through the Admin SDK, as a service account with domain-wide delegation
 * acting as an admin (`adminEmail`). Used for directory pulls and for provisioning
 * (group membership, account suspension).
 */
export interface GoogleConfig {
	serviceAccountJson: string;
	adminEmail: string;
}

export const DIRECTORY_SCOPES = [
	'https://www.googleapis.com/auth/admin.directory.user.readonly',
	'https://www.googleapis.com/auth/admin.directory.group.readonly',
	'https://www.googleapis.com/auth/admin.directory.group.member.readonly'
];
export const PROVISIONING_SCOPES = ['https://www.googleapis.com/auth/admin.directory.group.member', 'https://www.googleapis.com/auth/admin.directory.user'];

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export async function googleToken(cfg: GoogleConfig, scopes: string[], f: Fetch = fetch): Promise<string> {
	let sa: { client_email: string; private_key: string; token_uri?: string };
	try {
		sa = JSON.parse(cfg.serviceAccountJson);
	} catch {
		throw new ProviderError('The service account key isn’t valid JSON');
	}
	const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
	const iat = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(JSON.stringify({ iss: sa.client_email, sub: cfg.adminEmail, scope: scopes.join(' '), aud, iat, exp: iat + 3600 }));
	const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key).toString('base64url');
	const res = await f(aud, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` })
	});
	return (await jsonOrThrow<{ access_token: string }>(res, 'Google sign-in')).access_token;
}

const API = 'https://admin.googleapis.com/admin/directory/v1';

async function pages<T>(f: Fetch, token: string, url: string, key: string): Promise<T[]> {
	const out: T[] = [];
	let next: string | undefined;
	do {
		const u = new URL(url);
		if (next) u.searchParams.set('pageToken', next);
		const res = await f(u, { headers: { authorization: `Bearer ${token}` } });
		const body = await jsonOrThrow<Record<string, unknown> & { nextPageToken?: string }>(res, `Google ${u.pathname}`);
		out.push(...((body[key] as T[]) ?? []));
		next = body.nextPageToken;
	} while (next);
	return out;
}

interface GUser {
	id: string;
	primaryEmail: string;
	name?: { fullName?: string };
	suspended?: boolean;
	archived?: boolean;
	organizations?: { title?: string; primary?: boolean }[];
	relations?: { type: string; value: string }[];
}

export async function pullGoogle(cfg: GoogleConfig, f: Fetch = fetch): Promise<{ users: DirectoryUser[]; groups: DirectoryGroup[] }> {
	const token = await googleToken(cfg, DIRECTORY_SCOPES, f);
	const gusers = await pages<GUser>(f, token, `${API}/users?customer=my_customer&maxResults=500&projection=full`, 'users');
	const users: DirectoryUser[] = gusers.map((u) => ({
		id: u.id,
		email: u.primaryEmail,
		name: u.name?.fullName ?? '',
		title: (u.organizations?.find((o) => o.primary) ?? u.organizations?.[0])?.title ?? '',
		managerRef: u.relations?.find((r) => r.type === 'manager')?.value ?? '',
		active: !u.suspended && !u.archived
	}));
	const ggroups = await pages<{ id: string; email: string; name: string }>(f, token, `${API}/groups?customer=my_customer&maxResults=200`, 'groups');
	const groups: DirectoryGroup[] = [];
	for (const g of ggroups) {
		const members = await pages<{ id: string; type: string }>(f, token, `${API}/groups/${encodeURIComponent(g.id)}/members?maxResults=200&includeDerivedMembership=true`, 'members');
		groups.push({ id: g.id, externalId: g.email, name: g.name || g.email, memberIds: members.filter((m) => m.type === 'USER').map((m) => m.id) });
	}
	return { users, groups };
}

// ── Provisioning ─────────────────────────────────────────────────────────────

export type GoogleLevel = { type: 'google_group'; group: string; role: 'MEMBER' | 'MANAGER' | 'OWNER' } | { type: 'google_account' };

async function call(f: Fetch, token: string, method: string, url: string, body?: unknown) {
	return f(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
}

export async function testGoogle(cfg: GoogleConfig, f: Fetch = fetch) {
	const token = await googleToken(cfg, PROVISIONING_SCOPES, f);
	const res = await call(f, token, 'GET', `${API}/users/${encodeURIComponent(cfg.adminEmail)}`);
	const me = await jsonOrThrow<{ primaryEmail: string; isAdmin?: boolean }>(res, 'Google admin');
	return { as: me.primaryEmail };
}

export async function googleGrant(cfg: GoogleConfig, level: GoogleLevel, email: string, f: Fetch = fetch): Promise<string> {
	const token = await googleToken(cfg, PROVISIONING_SCOPES, f);
	if (level.type === 'google_account') {
		const res = await call(f, token, 'PUT', `${API}/users/${encodeURIComponent(email)}`, { suspended: false });
		if (res.status === 404) throw new ProviderError(`${email} doesn’t have a Google Workspace account yet; create it in the Admin console, then mark this done`);
		await jsonOrThrow(res, 'Google account');
		return `Google Workspace: ${email} is active`;
	}
	const res = await call(f, token, 'POST', `${API}/groups/${encodeURIComponent(level.group)}/members`, { email, role: level.role });
	if (res.status === 409) {
		await jsonOrThrow(await call(f, token, 'PATCH', `${API}/groups/${encodeURIComponent(level.group)}/members/${encodeURIComponent(email)}`, { role: level.role }), 'Google group');
	} else await jsonOrThrow(res, 'Google group');
	return `Google Workspace: ${email} added to ${level.group} as ${level.role.toLowerCase()}`;
}

export async function googleRevoke(cfg: GoogleConfig, level: GoogleLevel, email: string, f: Fetch = fetch): Promise<string> {
	const token = await googleToken(cfg, PROVISIONING_SCOPES, f);
	if (level.type === 'google_account') {
		const res = await call(f, token, 'PUT', `${API}/users/${encodeURIComponent(email)}`, { suspended: true });
		if (res.status !== 404) await jsonOrThrow(res, 'Google account');
		return `Google Workspace: ${email} suspended`;
	}
	const res = await call(f, token, 'DELETE', `${API}/groups/${encodeURIComponent(level.group)}/members/${encodeURIComponent(email)}`);
	if (res.status !== 404 && !res.ok) await jsonOrThrow(res, 'Google group');
	return `Google Workspace: ${email} removed from ${level.group}`;
}
