import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { type DirectoryUser, reconcile, upsertGroup, upsertUser } from './directory.ts';
import { effects, flush } from './requests.ts';

/**
 * A SCIM 2.0 service provider (RFC 7643/7644), enough for Okta, Entra ID, JumpCloud and
 * OneLogin to provision users and groups. Each write is stored as-is, then the org is
 * reconciled so ac·modern reflects it immediately.
 */

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export interface ScimResponse {
	status: number;
	body?: unknown;
}

const err = (status: number, detail: string, scimType?: string): ScimResponse => ({ status, body: { schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) } });

type Obj = Record<string, unknown>;

interface UserRow {
	id: string;
	external_id: string;
	email: string;
	name: string;
	title: string;
	manager_ref: string;
	active: number;
	raw: string;
	updated_at: string;
}

const bool = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() === 'true' : !!v);

function userToScim(r: UserRow, base: string) {
	const raw = JSON.parse(r.raw || '{}') as Obj;
	return {
		...raw,
		schemas: [USER, ENTERPRISE],
		id: r.id,
		externalId: r.external_id || undefined,
		userName: (raw.userName as string) ?? r.email,
		name: (raw.name as Obj) ?? { formatted: r.name },
		displayName: r.name,
		title: r.title,
		active: !!r.active,
		emails: [{ value: r.email, type: 'work', primary: true }],
		[ENTERPRISE]: { ...((raw[ENTERPRISE] as Obj) ?? {}), ...(r.manager_ref ? { manager: { value: r.manager_ref } } : {}) },
		meta: { resourceType: 'User', lastModified: r.updated_at, location: `${base}/Users/${r.id}` }
	};
}

/** Pulls our fields out of a SCIM user document. */
function fromScim(id: string, doc: Obj): DirectoryUser {
	const emails = (doc.emails as { value?: string; primary?: boolean; type?: string }[] | undefined) ?? [];
	const email = emails.find((e) => e.primary)?.value ?? emails.find((e) => e.type === 'work')?.value ?? emails[0]?.value ?? (doc.userName as string) ?? '';
	const name = (doc.name as Obj | undefined) ?? {};
	const display = (doc.displayName as string) || (name.formatted as string) || [name.givenName, name.familyName].filter(Boolean).join(' ');
	const ent = (doc[ENTERPRISE] as Obj | undefined) ?? {};
	const manager = ent.manager as Obj | string | undefined;
	return {
		id,
		externalId: (doc.externalId as string) ?? '',
		email: String(email),
		name: String(display ?? ''),
		title: String(doc.title ?? ''),
		managerRef: typeof manager === 'string' ? manager : String(manager?.value ?? ''),
		active: doc.active === undefined ? true : bool(doc.active),
		raw: doc
	};
}

/** Applies RFC 7644 PATCH operations to a document, covering what Okta and Entra send. */
export function applyPatch(doc: Obj, ops: { op: string; path?: string; value?: unknown }[]): Obj {
	const out: Obj = structuredClone(doc);
	for (const o of ops) {
		const op = String(o.op).toLowerCase();
		if (!o.path) {
			// { op: replace, value: { active: false, "name.givenName": "x" } }
			if (o.value && typeof o.value === 'object') for (const [k, v] of Object.entries(o.value as Obj)) setPath(out, k, v);
			continue;
		}
		if (op === 'remove') setPath(out, o.path, undefined);
		else setPath(out, o.path, o.value);
	}
	return out;
}

function setPath(doc: Obj, path: string, value: unknown) {
	// Extension attributes: "urn:...:enterprise:2.0:User:manager"
	if (path.startsWith(ENTERPRISE)) {
		const attr = path.slice(ENTERPRISE.length + 1);
		const ext = ((doc[ENTERPRISE] as Obj) ??= {});
		if (!attr) Object.assign(ext, value as Obj);
		else ext[attr] = attr === 'manager' && typeof value === 'string' ? { value } : value;
		return;
	}
	// emails[type eq "work"].value
	const filtered = /^(\w+)\[(\w+) eq "([^"]*)"\]\.?(\w+)?$/.exec(path);
	if (filtered) {
		const [, attr, key, match, sub] = filtered;
		const list = ((doc[attr] as Obj[]) ??= []);
		let item = list.find((x) => String(x[key]) === match);
		if (!item) list.push((item = { [key]: match, ...(attr === 'emails' ? { primary: true } : {}) }));
		if (sub) item[sub] = value;
		else if (value === undefined) list.splice(list.indexOf(item), 1);
		return;
	}
	const parts = path.split('.');
	let cur = doc;
	for (const p of parts.slice(0, -1)) cur = (cur[p] as Obj) ??= {};
	const last = parts.at(-1)!;
	if (value === undefined) delete cur[last];
	else cur[last] = last === 'active' ? bool(value) : value;
}

/** Supports `attr eq "value"` filters (userName, externalId, displayName, emails.value). */
function parseFilter(filter: string | null): { attr: string; value: string } | null {
	if (!filter) return null;
	const m = /^\s*([\w.]+)\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
	return m ? { attr: m[1].toLowerCase(), value: m[2] } : null;
}

async function afterWrite(db: Db, orgId: string, origin: string) {
	const fx = effects();
	await reconcile(db, orgId, fx);
	await flush(db, orgId, fx, origin);
}

export async function handleScim(db: Db, orgId: string, method: string, path: string[], query: URLSearchParams, body: Obj | null, base: string, origin: string): Promise<ScimResponse> {
	const [resource, id] = path;
	const page = (total: number, items: unknown[], start: number) => ({ status: 200, body: { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: items.length, Resources: items } });
	const startIndex = Math.max(1, Number(query.get('startIndex')) || 1);
	const count = Math.min(Math.max(0, Number(query.get('count') ?? 100) || 0), 500);

	switch (resource) {
		case 'ServiceProviderConfig':
			return {
				status: 200,
				body: {
					schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
					patch: { supported: true },
					bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
					filter: { supported: true, maxResults: 500 },
					changePassword: { supported: false },
					sort: { supported: false },
					etag: { supported: false },
					authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The token from ac·modern → Settings → Directory sync', primary: true }]
				}
			};
		case 'ResourceTypes':
			return page(2, [
				{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER, schemaExtensions: [{ schema: ENTERPRISE, required: false }] },
				{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP }
			], 1);
		case 'Schemas':
			return page(3, [{ id: USER, name: 'User' }, { id: ENTERPRISE, name: 'EnterpriseUser' }, { id: GROUP, name: 'Group' }], 1);
		case 'Users':
			return users(db, orgId, method, id, query, body, base, origin, startIndex, count, page);
		case 'Groups':
			return groups(db, orgId, method, id, query, body, base, origin, startIndex, count, page);
		default:
			return err(404, 'Unknown SCIM resource');
	}
}

async function users(
	db: Db,
	orgId: string,
	method: string,
	id: string | undefined,
	query: URLSearchParams,
	body: Obj | null,
	base: string,
	origin: string,
	startIndex: number,
	count: number,
	page: (t: number, i: unknown[], s: number) => ScimResponse
): Promise<ScimResponse> {
	const get = (uid: string) => db.get<UserRow>('SELECT * FROM directory_users WHERE org_id = ? AND id = ?', [orgId, uid]);
	if (method === 'GET' && !id) {
		const f = parseFilter(query.get('filter'));
		let rows = await db.all<UserRow>('SELECT * FROM directory_users WHERE org_id = ? ORDER BY updated_at', [orgId]);
		if (f) {
			const v = f.value.toLowerCase();
			rows = rows.filter((r) => {
				const raw = JSON.parse(r.raw || '{}') as Obj;
				if (f.attr === 'username') return String(raw.userName ?? r.email).toLowerCase() === v;
				if (f.attr === 'externalid') return r.external_id === f.value;
				if (f.attr === 'emails.value' || f.attr === 'emails') return r.email === v;
				if (f.attr === 'id') return r.id === f.value;
				return false;
			});
		}
		return page(rows.length, rows.slice(startIndex - 1, startIndex - 1 + count).map((r) => userToScim(r, base)), startIndex);
	}
	if (method === 'GET') {
		const r = await get(id!);
		return r ? { status: 200, body: userToScim(r, base) } : err(404, 'User not found');
	}
	if (method === 'POST') {
		if (!body) return err(400, 'Expected a SCIM User', 'invalidSyntax');
		const u = fromScim(newId(), body);
		if (!u.email.includes('@')) return err(400, 'The user needs an email (userName or emails)', 'invalidValue');
		const clash = await db.get<{ id: string }>('SELECT id FROM directory_users WHERE org_id = ? AND (email = ? OR (external_id <> \'\' AND external_id = ?))', [orgId, u.email.toLowerCase(), u.externalId ?? '']);
		if (clash) return err(409, 'A user with that userName already exists', 'uniqueness');
		await upsertUser(db, orgId, u);
		await afterWrite(db, orgId, origin);
		return { status: 201, body: userToScim((await get(u.id))!, base) };
	}
	if (!id) return err(405, 'Method not allowed');
	const current = await get(id);
	if (!current) return err(404, 'User not found');
	if (method === 'PUT') {
		if (!body) return err(400, 'Expected a SCIM User', 'invalidSyntax');
		await upsertUser(db, orgId, fromScim(id, body));
	} else if (method === 'PATCH') {
		const ops = (body?.Operations ?? body?.operations) as { op: string; path?: string; value?: unknown }[] | undefined;
		if (!Array.isArray(ops)) return err(400, `Expected ${PATCH}`, 'invalidSyntax');
		const doc = userToScim(current, base) as Obj;
		await upsertUser(db, orgId, fromScim(id, applyPatch(doc, ops)));
	} else if (method === 'DELETE') {
		// Deleting in the IdP deactivates here; history stays.
		await db.run('UPDATE directory_users SET active = 0, updated_at = ? WHERE org_id = ? AND id = ?', [new Date().toISOString(), orgId, id]);
		await db.run('DELETE FROM directory_memberships WHERE org_id = ? AND user_id = ?', [orgId, id]);
		await afterWrite(db, orgId, origin);
		return { status: 204 };
	} else return err(405, 'Method not allowed');
	await afterWrite(db, orgId, origin);
	return { status: 200, body: userToScim((await get(id))!, base) };
}

async function groups(
	db: Db,
	orgId: string,
	method: string,
	id: string | undefined,
	query: URLSearchParams,
	body: Obj | null,
	base: string,
	origin: string,
	startIndex: number,
	count: number,
	page: (t: number, i: unknown[], s: number) => ScimResponse
): Promise<ScimResponse> {
	const load = async (gid: string) => {
		const g = await db.get<{ id: string; external_id: string; name: string; updated_at: string }>('SELECT id, external_id, name, updated_at FROM directory_groups WHERE org_id = ? AND id = ?', [orgId, gid]);
		if (!g) return null;
		const members = await db.all<{ user_id: string }>('SELECT user_id FROM directory_memberships WHERE org_id = ? AND group_id = ?', [orgId, gid]);
		return { g, members: members.map((m) => m.user_id) };
	};
	const toScim = (x: NonNullable<Awaited<ReturnType<typeof load>>>, withMembers = true) => ({
		schemas: [GROUP],
		id: x.g.id,
		externalId: x.g.external_id || undefined,
		displayName: x.g.name,
		...(withMembers ? { members: x.members.map((value) => ({ value })) } : {}),
		meta: { resourceType: 'Group', lastModified: x.g.updated_at, location: `${base}/Groups/${x.g.id}` }
	});
	const memberIds = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((m) => String((m as Obj).value ?? m));

	if (method === 'GET' && !id) {
		const f = parseFilter(query.get('filter'));
		let rows = await db.all<{ id: string; name: string; external_id: string }>('SELECT id, name, external_id FROM directory_groups WHERE org_id = ? ORDER BY name', [orgId]);
		if (f?.attr === 'displayname') rows = rows.filter((r) => r.name.toLowerCase() === f.value.toLowerCase());
		if (f?.attr === 'externalid') rows = rows.filter((r) => r.external_id === f.value);
		const excluded = (query.get('excludedAttributes') ?? '').includes('members');
		const items = [];
		for (const r of rows.slice(startIndex - 1, startIndex - 1 + count)) items.push(toScim((await load(r.id))!, !excluded));
		return page(rows.length, items, startIndex);
	}
	if (method === 'GET') {
		const x = await load(id!);
		return x ? { status: 200, body: toScim(x) } : err(404, 'Group not found');
	}
	if (method === 'POST') {
		if (!body?.displayName) return err(400, 'displayName is required', 'invalidValue');
		if (await db.get('SELECT 1 FROM directory_groups WHERE org_id = ? AND LOWER(name) = ?', [orgId, String(body.displayName).toLowerCase()])) return err(409, 'A group with that name exists', 'uniqueness');
		const gid = newId();
		await upsertGroup(db, orgId, { id: gid, externalId: String(body.externalId ?? ''), name: String(body.displayName), memberIds: memberIds(body.members) });
		await afterWrite(db, orgId, origin);
		return { status: 201, body: toScim((await load(gid))!) };
	}
	if (!id) return err(405, 'Method not allowed');
	const x = await load(id);
	if (!x) return err(404, 'Group not found');
	if (method === 'PUT') {
		await upsertGroup(db, orgId, { id, externalId: String(body?.externalId ?? x.g.external_id), name: String(body?.displayName ?? x.g.name), memberIds: memberIds(body?.members) });
	} else if (method === 'PATCH') {
		const ops = (body?.Operations ?? body?.operations) as { op: string; path?: string; value?: unknown }[] | undefined;
		if (!Array.isArray(ops)) return err(400, `Expected ${PATCH}`, 'invalidSyntax');
		let name = x.g.name;
		const members = new Set(x.members);
		for (const o of ops) {
			const op = String(o.op).toLowerCase();
			const path = o.path ?? '';
			const filtered = /^members\[value eq "([^"]+)"\]$/.exec(path);
			if (filtered && op === 'remove') members.delete(filtered[1]);
			else if (path === 'members' && op === 'add') memberIds(o.value).forEach((m) => members.add(m));
			else if (path === 'members' && op === 'remove') (o.value ? memberIds(o.value).forEach((m) => members.delete(m)) : members.clear());
			else if (path === 'members' && op === 'replace') (members.clear(), memberIds(o.value).forEach((m) => members.add(m)));
			else if (path === 'displayName') name = String(o.value);
			else if (!path && o.value && typeof o.value === 'object') {
				const v = o.value as Obj;
				if (v.displayName) name = String(v.displayName);
				if (v.members) {
					if (op === 'replace') members.clear();
					memberIds(v.members).forEach((m) => members.add(m));
				}
			}
		}
		await upsertGroup(db, orgId, { id, externalId: x.g.external_id, name, memberIds: [...members] });
	} else if (method === 'DELETE') {
		await db.run('DELETE FROM directory_memberships WHERE org_id = ? AND group_id = ?', [orgId, id]);
		await db.run('DELETE FROM directory_groups WHERE org_id = ? AND id = ?', [orgId, id]);
		await afterWrite(db, orgId, origin);
		return { status: 204 };
	} else return err(405, 'Method not allowed');
	await afterWrite(db, orgId, origin);
	return { status: 200, body: toScim((await load(id))!) };
}
