import type { DirectoryGroup, DirectoryUser } from '../directory.ts';
import type { ScannedApp } from '#lib/types.ts';
import { type Fetch, jsonOrThrow, type MemberAccount, ProviderError } from './http.ts';

/** Microsoft Entra ID through Microsoft Graph, as an app with User.Read.All and GroupMember.Read.All. */
export interface EntraConfig {
	tenantId: string;
	clientId: string;
	clientSecret: string;
}

export async function graphToken(cfg: EntraConfig, f: Fetch = fetch): Promise<string> {
	const res = await f(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: 'https://graph.microsoft.com/.default' })
	});
	return (await jsonOrThrow<{ access_token: string }>(res, 'Microsoft sign-in')).access_token;
}

async function pages<T>(f: Fetch, token: string, url: string): Promise<T[]> {
	const out: T[] = [];
	let next: string | undefined = url;
	while (next) {
		const res: Response = await f(next, { headers: { authorization: `Bearer ${token}` } });
		const body: { value: T[]; '@odata.nextLink'?: string } = await jsonOrThrow(res, `Microsoft Graph ${new URL(next).pathname}`);
		out.push(...body.value);
		next = body['@odata.nextLink'];
	}
	return out;
}

interface GUser {
	id: string;
	displayName?: string;
	mail?: string | null;
	userPrincipalName: string;
	jobTitle?: string | null;
	accountEnabled?: boolean;
	userType?: string;
	manager?: { id: string } | null;
}

export async function pullEntra(cfg: EntraConfig, f: Fetch = fetch): Promise<{ users: DirectoryUser[]; groups: DirectoryGroup[] }> {
	const token = await graphToken(cfg, f);
	const G = 'https://graph.microsoft.com/v1.0';
	const gusers = await pages<GUser>(f, token, `${G}/users?$select=id,displayName,mail,userPrincipalName,jobTitle,accountEnabled,userType&$expand=manager($select=id)&$top=999`);
	const users: DirectoryUser[] = gusers
		.filter((u) => u.userType !== 'Guest')
		.map((u) => ({
			id: u.id,
			email: u.mail || u.userPrincipalName,
			name: u.displayName ?? '',
			title: u.jobTitle ?? '',
			managerRef: u.manager?.id ?? '',
			active: u.accountEnabled !== false
		}));
	const ggroups = await pages<{ id: string; displayName: string }>(f, token, `${G}/groups?$select=id,displayName&$top=999`);
	const groups: DirectoryGroup[] = [];
	for (const g of ggroups) {
		const members = await pages<{ id: string; '@odata.type': string }>(f, token, `${G}/groups/${g.id}/transitiveMembers?$select=id&$top=999`);
		groups.push({ id: g.id, name: g.displayName, memberIds: members.filter((m) => m['@odata.type'] === '#microsoft.graph.user').map((m) => m.id) });
	}
	return { users, groups };
}

// ── Provisioning ─────────────────────────────────────────────────────────────
// Security group membership. The app needs GroupMember.ReadWrite.All (application),
// and groups must be assigned (not dynamic) and not mail-enabled.

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graph(token: string, f: Fetch, method: string, url: string, body?: unknown) {
	return f(url.startsWith('http') ? url : `${GRAPH}${url}`, {
		method,
		headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	});
}

export async function testEntra(cfg: EntraConfig, f: Fetch = fetch) {
	const token = await graphToken(cfg, f);
	await jsonOrThrow(await graph(token, f, 'GET', '/groups?$top=1&$select=id'), 'Microsoft Graph groups');
	return { as: `app ${cfg.clientId}` };
}

/** Assigned security groups only: dynamic and mail-enabled groups can't be changed through Graph. */
export async function entraTargets(cfg: EntraConfig, f: Fetch = fetch) {
	const token = await graphToken(cfg, f);
	const groups = await pages<{ id: string; displayName: string; groupTypes?: string[]; mailEnabled?: boolean; securityEnabled?: boolean }>(
		f,
		token,
		`${GRAPH}/groups?$select=id,displayName,groupTypes,mailEnabled,securityEnabled&$top=999`
	);
	return {
		groups: groups
			.filter((g) => !(g.groupTypes ?? []).includes('DynamicMembership') && (g.securityEnabled || (g.groupTypes ?? []).includes('Unified')))
			.map((g) => ({ id: g.id, name: g.displayName }))
	};
}

async function entraUserId(token: string, email: string, f: Fetch): Promise<string | null> {
	const direct = await graph(token, f, 'GET', `/users/${encodeURIComponent(email)}?$select=id`);
	if (direct.ok) return (await direct.json()).id;
	if (direct.status !== 404) await jsonOrThrow(direct, 'Microsoft user');
	const found = await jsonOrThrow<{ value: { id: string }[] }>(
		await graph(token, f, 'GET', `/users?$select=id&$filter=${encodeURIComponent(`mail eq '${email.replaceAll("'", "''")}'`)}`),
		'Microsoft user search'
	);
	return found.value[0]?.id ?? null;
}

export type EntraLevel = { type: 'entra_group'; id: string; name: string };

export async function entraGrant(cfg: EntraConfig, level: EntraLevel, email: string, f: Fetch = fetch): Promise<string> {
	const token = await graphToken(cfg, f);
	const uid = await entraUserId(token, email, f);
	if (!uid) throw new ProviderError(`${email} has no Microsoft Entra account`);
	const res = await graph(token, f, 'POST', `/groups/${level.id}/members/$ref`, { '@odata.id': `${GRAPH}/directoryObjects/${uid}` });
	if (!res.ok && res.status !== 204) {
		const text = await res.text();
		// Already a member: Graph answers 400 "added object references already exist".
		if (!(res.status === 400 && /already exist/i.test(text))) await jsonOrThrow(new Response(text, { status: res.status }), 'Microsoft group');
	}
	return `Entra ID: ${email} added to group ${level.name || level.id}`;
}

export async function entraRevoke(cfg: EntraConfig, level: EntraLevel, email: string, f: Fetch = fetch): Promise<string> {
	const token = await graphToken(cfg, f);
	const uid = await entraUserId(token, email, f);
	if (!uid) return `Entra ID: ${email} has no account, so there was nothing to remove`;
	const res = await graph(token, f, 'DELETE', `/groups/${level.id}/members/${uid}/$ref`);
	if (!res.ok && res.status !== 204 && res.status !== 404) await jsonOrThrow(res, 'Microsoft group');
	return `Entra ID: ${email} removed from group ${level.name || level.id}`;
}

// ── App scan ─────────────────────────────────────────────────────────────────

/**
 * Enterprise applications (service principals tagged as integrated apps) and who's
 * assigned to them. Group assignments become access levels that provision by group
 * membership; direct user assignments become a level that can't be provisioned yet.
 * Needs Application.Read.All on top of the directory permissions.
 */
export async function entraApps(cfg: EntraConfig, f: Fetch = fetch): Promise<ScannedApp[]> {
	const token = await graphToken(cfg, f);
	const sps = await pages<{ id: string; displayName: string; homepage?: string | null; appRoleAssignmentRequired?: boolean; notes?: string | null }>(
		f,
		token,
		`${GRAPH}/servicePrincipals?$filter=${encodeURIComponent("tags/any(t:t eq 'WindowsAzureActiveDirectoryIntegratedApp')")}&$select=id,displayName,homepage,appRoleAssignmentRequired,notes&$top=999`
	);
	const groupEmails = new Map<string, string[]>();
	const userEmail = new Map<string, string>();
	const out: ScannedApp[] = [];
	for (const sp of sps) {
		const assignments = await pages<{ principalType: string; principalId: string; principalDisplayName: string }>(f, token, `${GRAPH}/servicePrincipals/${sp.id}/appRoleAssignedTo?$top=999`);
		const levels: ScannedApp['levels'] = [];
		for (const a of assignments.filter((x) => x.principalType === 'Group')) {
			if (levels.some((l) => l.mapping && 'id' in l.mapping && l.mapping.id === a.principalId)) continue;
			if (!groupEmails.has(a.principalId)) {
				const users = await pages<GUser>(f, token, `${GRAPH}/groups/${a.principalId}/transitiveMembers/microsoft.graph.user?$select=mail,userPrincipalName,accountEnabled&$top=999`);
				groupEmails.set(a.principalId, users.filter((u) => u.accountEnabled !== false).map((u) => u.mail || u.userPrincipalName));
			}
			levels.push({ name: a.principalDisplayName, mapping: { type: 'entra_group', id: a.principalId, name: a.principalDisplayName }, emails: groupEmails.get(a.principalId)! });
		}
		const direct: string[] = [];
		for (const a of assignments.filter((x) => x.principalType === 'User')) {
			if (!userEmail.has(a.principalId)) {
				const u = await jsonOrThrow<GUser>(await f(`${GRAPH}/users/${a.principalId}?$select=mail,userPrincipalName,accountEnabled`, { headers: { authorization: `Bearer ${token}` } }), 'Microsoft Graph user');
				userEmail.set(a.principalId, u.accountEnabled === false ? '' : u.mail || u.userPrincipalName);
			}
			if (userEmail.get(a.principalId)) direct.push(userEmail.get(a.principalId)!);
		}
		if (direct.length) levels.push({ name: 'Direct assignment', mapping: null, emails: [...new Set(direct)] });
		out.push({
			ref: `entra:app:${sp.id}`,
			name: sp.displayName,
			url: sp.homepage ?? '',
			description: sp.notes ?? '',
			// Without "Assignment required", anyone in the tenant can sign in.
			openToAll: sp.appRoleAssignmentRequired === false && !assignments.length,
			levels
		});
	}
	return out;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/** Users in an access level's group, including through nested groups. */
export async function entraMembers(cfg: EntraConfig, level: EntraLevel, f: Fetch = fetch): Promise<MemberAccount[]> {
	const token = await graphToken(cfg, f);
	const users = await pages<GUser>(f, token, `${GRAPH}/groups/${encodeURIComponent(level.id)}/transitiveMembers/microsoft.graph.user?$select=id,displayName,mail,userPrincipalName&$top=999`);
	return users.map((u) => ({ email: (u.mail || u.userPrincipalName).toLowerCase(), login: u.userPrincipalName, name: u.displayName }));
}
