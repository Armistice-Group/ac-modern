import type { DirectoryGroup, DirectoryUser } from '../directory.ts';
import { type Fetch, jsonOrThrow } from './http.ts';

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
