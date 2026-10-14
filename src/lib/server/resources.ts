import { decrypt, encrypt, newId } from './crypto.ts';
import type { Db } from './db.ts';
import { badRequest, notFound } from './http.ts';
import type { ApprovalPolicy, Fulfillment, IntegrationKind, LevelMapping, Resource, ResourceRole } from '#lib/types.ts';

const now = () => new Date().toISOString();

export const APPROVAL_POLICIES: ApprovalPolicy[] = ['none', 'manager', 'approvers', 'manager_then_approvers'];
export const FULFILLMENTS: Fulfillment[] = ['manual', 'webhook', 'integration'];
export const COLORS = ['violet', 'blue', 'cyan', 'green', 'amber', 'orange', 'red', 'pink', 'slate'];

interface Row {
	id: string;
	name: string;
	description: string;
	category: string;
	url: string;
	color: string;
	owner_id: string | null;
	approval: ApprovalPolicy;
	fulfillment: Fulfillment;
	webhook_url: string;
	webhook_secret: string;
	integration: IntegrationKind | '';
	integration_map: string;
	max_days: number | null;
	default_days: number | null;
	requestable: number;
	archived: number;
}

async function hydrate(db: Db, orgId: string, rows: Row[]): Promise<Resource[]> {
	if (!rows.length) return [];
	const roles = await db.all<{ id: string; resource_id: string; name: string; description: string; privileged: number }>(
		'SELECT id, resource_id, name, description, privileged FROM resource_roles WHERE org_id = ? AND archived = 0 ORDER BY position, name',
		[orgId]
	);
	const people = await db.all<{ resource_id: string; user_id: string; kind: string }>('SELECT resource_id, user_id, kind FROM resource_people WHERE org_id = ?', [orgId]);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		category: r.category,
		url: r.url,
		color: r.color,
		ownerId: r.owner_id,
		approval: r.approval,
		fulfillment: r.fulfillment,
		webhookUrl: r.webhook_url,
		hasWebhookSecret: !!r.webhook_secret,
		integration: r.integration,
		integrationMap: JSON.parse(r.integration_map || '{}'),
		maxDays: r.max_days,
		defaultDays: r.default_days,
		requestable: !!r.requestable,
		archived: !!r.archived,
		roles: roles.filter((x) => x.resource_id === r.id).map(({ id, name, description, privileged }) => ({ id, name, description, privileged: !!privileged })),
		approverIds: people.filter((p) => p.resource_id === r.id && p.kind === 'approver').map((p) => p.user_id),
		fulfillerIds: people.filter((p) => p.resource_id === r.id && p.kind === 'fulfiller').map((p) => p.user_id)
	}));
}

export async function listResources(db: Db, orgId: string, opts: { includeArchived?: boolean } = {}): Promise<Resource[]> {
	const rows = await db.all<Row>(`SELECT * FROM resources WHERE org_id = ? ${opts.includeArchived ? '' : 'AND archived = 0'} ORDER BY LOWER(name)`, [orgId]);
	return hydrate(db, orgId, rows);
}

export async function getResource(db: Db, orgId: string, id: string): Promise<Resource> {
	const row = await db.get<Row>('SELECT * FROM resources WHERE org_id = ? AND id = ?', [orgId, id]);
	if (!row) throw notFound('That resource doesn’t exist');
	return (await hydrate(db, orgId, [row]))[0];
}

/** The webhook signing secret, decrypted, for fulfillment calls. */
export async function webhookSecret(db: Db, orgId: string, id: string): Promise<string> {
	const row = await db.get<{ webhook_secret: string }>('SELECT webhook_secret FROM resources WHERE org_id = ? AND id = ?', [orgId, id]);
	return row?.webhook_secret ? decrypt(row.webhook_secret, `resource:${id}`) : '';
}

export interface ResourceInput {
	name: string;
	description: string;
	category: string;
	url: string;
	color: string;
	ownerId: string | null;
	approval: ApprovalPolicy;
	fulfillment: Fulfillment;
	webhookUrl: string;
	/** undefined keeps the stored secret; '' clears it. */
	webhookSecret?: string;
	integration?: IntegrationKind | '';
	/** Keyed by role id, or by the role's position ("#0") for roles being created. */
	integrationMap?: Record<string, LevelMapping>;
	maxDays: number | null;
	defaultDays: number | null;
	requestable: boolean;
	approverIds: string[];
	fulfillerIds: string[];
	/** Roles in display order. Existing roles keep their id; missing ones are archived. */
	roles: { id?: string; name: string; description: string; privileged: boolean }[];
}

export function validateResource(input: ResourceInput) {
	if (!input.name) throw badRequest('Give the resource a name');
	if (!input.roles.length) throw badRequest('Add at least one access level (e.g. “Member”)');
	const names = input.roles.map((r) => r.name.toLowerCase());
	if (names.some((n) => !n)) throw badRequest('Every access level needs a name');
	if (new Set(names).size !== names.length) throw badRequest('Access level names must be different');
	if (input.fulfillment === 'webhook') {
		try {
			const u = new URL(input.webhookUrl);
			if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
		} catch {
			throw badRequest('Enter the webhook URL that provisions access (https://…)');
		}
	}
	if (input.fulfillment === 'integration') {
		if (input.integration !== 'github' && input.integration !== 'google') throw badRequest('Choose GitHub or Google Workspace');
		const map = input.integrationMap ?? {};
		for (const [i, r] of input.roles.entries()) {
			const m = map[r.id ?? ''] ?? map[`#${i}`];
			if (!m) throw badRequest(`Say what “${r.name}” means in ${input.integration === 'github' ? 'GitHub' : 'Google Workspace'}`);
			if (input.integration === 'github' && !(m.type === 'github_org' || (m.type === 'github_team' && m.team))) throw badRequest(`Pick a GitHub team or org role for “${r.name}”`);
			if (input.integration === 'google' && !(m.type === 'google_account' || (m.type === 'google_group' && /@/.test(m.group)))) throw badRequest(`Enter the Google group address for “${r.name}”`);
		}
	}
	if (input.maxDays !== null && input.defaultDays !== null && input.defaultDays > input.maxDays) {
		throw badRequest('The default duration can’t be longer than the maximum');
	}
	if (input.url) {
		try {
			new URL(input.url);
		} catch {
			throw badRequest('The link must be a full URL (https://…)');
		}
	}
}

async function assertMembers(db: Db, orgId: string, ids: string[]) {
	if (!ids.length) return;
	const found = await db.all<{ user_id: string }>(`SELECT user_id FROM members WHERE org_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`, [orgId, ...ids]);
	if (found.length !== ids.length) throw badRequest('Some of the chosen people aren’t members of this organisation');
}

export async function saveResource(db: Db, orgId: string, id: string | null, input: ResourceInput): Promise<string> {
	validateResource(input);
	await assertMembers(db, orgId, [...new Set([...input.approverIds, ...input.fulfillerIds, ...(input.ownerId ? [input.ownerId] : [])])]);
	return db.tx(async (tx) => {
		const t = now();
		if (!id) {
			id = newId();
			await tx.run(
				`INSERT INTO resources (id, org_id, name, description, category, url, color, owner_id, approval, fulfillment, webhook_url, max_days, default_days, requestable, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[id, orgId, input.name, input.description, input.category, input.url, input.color, input.ownerId, input.approval, input.fulfillment, input.webhookUrl, input.maxDays, input.defaultDays, input.requestable, t, t]
			);
		} else {
			const { changes } = await tx.run(
				`UPDATE resources SET name = ?, description = ?, category = ?, url = ?, color = ?, owner_id = ?, approval = ?, fulfillment = ?, webhook_url = ?,
				 max_days = ?, default_days = ?, requestable = ?, updated_at = ? WHERE org_id = ? AND id = ?`,
				[input.name, input.description, input.category, input.url, input.color, input.ownerId, input.approval, input.fulfillment, input.webhookUrl, input.maxDays, input.defaultDays, input.requestable, t, orgId, id]
			);
			if (!changes) throw notFound('That resource doesn’t exist');
		}
		if (input.webhookSecret !== undefined) {
			await tx.run('UPDATE resources SET webhook_secret = ? WHERE id = ?', [input.webhookSecret ? encrypt(input.webhookSecret, `resource:${id}`) : '', id]);
		}

		await tx.run('DELETE FROM resource_people WHERE resource_id = ?', [id]);
		for (const u of input.approverIds) await tx.run("INSERT INTO resource_people (org_id, resource_id, user_id, kind) VALUES (?, ?, ?, 'approver')", [orgId, id, u]);
		for (const u of input.fulfillerIds) await tx.run("INSERT INTO resource_people (org_id, resource_id, user_id, kind) VALUES (?, ?, ?, 'fulfiller')", [orgId, id, u]);

		const existing = await tx.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ?', [id]);
		const keep = new Set<string>();
		const map: Record<string, LevelMapping> = {};
		for (const [i, role] of input.roles.entries()) {
			const mapped = input.integrationMap?.[role.id ?? ''] ?? input.integrationMap?.[`#${i}`];
			if (role.id && existing.some((e) => e.id === role.id)) {
				if (mapped) map[role.id] = mapped;
				keep.add(role.id);
				await tx.run('UPDATE resource_roles SET name = ?, description = ?, privileged = ?, position = ?, archived = 0 WHERE id = ?', [role.name, role.description, !!role.privileged, i, role.id]);
			} else {
				const roleId = newId();
				if (mapped) map[roleId] = mapped;
				await tx.run('INSERT INTO resource_roles (id, org_id, resource_id, name, description, privileged, position) VALUES (?, ?, ?, ?, ?, ?, ?)', [roleId, orgId, id, role.name, role.description, !!role.privileged, i]);
			}
		}
		await tx.run('UPDATE resources SET integration = ?, integration_map = ? WHERE id = ?', [
			input.fulfillment === 'integration' ? (input.integration ?? '') : '',
			input.fulfillment === 'integration' ? JSON.stringify(map) : '{}',
			id
		]);
		// Roles stay in the table (grants and history point at them); removed ones are archived.
		for (const e of existing) if (!keep.has(e.id)) await tx.run('UPDATE resource_roles SET archived = 1 WHERE id = ?', [e.id]);
		return id;
	});
}

export async function setArchived(db: Db, orgId: string, id: string, archived: boolean) {
	await db.run('UPDATE resources SET archived = ?, updated_at = ? WHERE org_id = ? AND id = ?', [archived, now(), orgId, id]);
}

export async function getRole(db: Db, orgId: string, resourceId: string, roleId: string): Promise<ResourceRole> {
	const r = await db.get<{ id: string; name: string; description: string; privileged: number }>(
		'SELECT id, name, description, privileged FROM resource_roles WHERE org_id = ? AND resource_id = ? AND id = ? AND archived = 0',
		[orgId, resourceId, roleId]
	);
	if (!r) throw badRequest('Pick an access level for this resource');
	return { ...r, privileged: !!r.privileged };
}

/** Resource ids where the user is owner, approver or fulfiller: they can see who has access there. */
export async function stewardedResourceIds(db: Db, orgId: string, userId: string): Promise<string[]> {
	const rows = await db.all<{ id: string }>(
		`SELECT id FROM resources WHERE org_id = ? AND owner_id = ?
		 UNION SELECT resource_id AS id FROM resource_people WHERE org_id = ? AND user_id = ?`,
		[orgId, userId, orgId, userId]
	);
	return rows.map((r) => r.id);
}

/** Parses the resource editor's JSON body. */
export function parseResourceInput(b: Record<string, unknown>): ResourceInput {
	const text = (k: string, max = 2000) => {
		const v = b[k];
		if (v === undefined || v === null) return '';
		if (typeof v !== 'string') throw badRequest(`${k} must be text`);
		if (v.length > max) throw badRequest(`${k} is too long`);
		return v.trim();
	};
	const num = (k: string) => {
		const v = b[k];
		if (v === undefined || v === null || v === '') return null;
		const n = Number(v);
		if (!Number.isInteger(n) || n < 1 || n > 3650) throw badRequest(`${k} must be 1–3650 days`);
		return n;
	};
	const list = (k: string) => {
		const v = b[k] ?? [];
		if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${k} must be a list`);
		return [...new Set(v as string[])];
	};
	const roles = b.roles ?? [];
	if (!Array.isArray(roles)) throw badRequest('roles must be a list');
	const approval = (b.approval ?? 'approvers') as ApprovalPolicy;
	if (!APPROVAL_POLICIES.includes(approval)) throw badRequest('Unknown approval policy');
	const fulfillment = (b.fulfillment ?? 'manual') as Fulfillment;
	if (!FULFILLMENTS.includes(fulfillment)) throw badRequest('Unknown fulfillment');
	const color = text('color') || 'violet';
	return {
		name: text('name', 80),
		description: text('description', 1000),
		category: text('category', 40) || 'app',
		url: text('url', 500),
		color: COLORS.includes(color) ? color : 'violet',
		ownerId: text('ownerId') || null,
		approval,
		fulfillment,
		webhookUrl: fulfillment === 'webhook' ? text('webhookUrl', 1000) : '',
		webhookSecret: typeof b.webhookSecret === 'string' ? b.webhookSecret : undefined,
		integration: b.integration === 'github' || b.integration === 'google' ? b.integration : '',
		integrationMap: parseMap(b.integrationMap),
		maxDays: num('maxDays'),
		defaultDays: num('defaultDays'),
		requestable: b.requestable !== false,
		approverIds: list('approverIds'),
		fulfillerIds: list('fulfillerIds'),
		roles: roles.map((r: Record<string, unknown>) => ({
			id: typeof r?.id === 'string' ? r.id : undefined,
			name: typeof r?.name === 'string' ? r.name.trim().slice(0, 60) : '',
			description: typeof r?.description === 'string' ? r.description.trim().slice(0, 300) : '',
			privileged: r?.privileged === true
		}))
	};
}

function parseMap(v: unknown): Record<string, LevelMapping> {
	if (!v || typeof v !== 'object') return {};
	const out: Record<string, LevelMapping> = {};
	for (const [k, raw] of Object.entries(v as Record<string, Record<string, unknown>>)) {
		const t = raw?.type;
		const str = (x: unknown) => (typeof x === 'string' ? x.trim().slice(0, 200) : '');
		if (t === 'github_org') out[k] = { type: t, role: raw.role === 'admin' ? 'admin' : 'member' };
		else if (t === 'github_team') out[k] = { type: t, team: str(raw.team), role: raw.role === 'maintainer' ? 'maintainer' : 'member' };
		else if (t === 'google_group') out[k] = { type: t, group: str(raw.group).toLowerCase(), role: raw.role === 'OWNER' ? 'OWNER' : raw.role === 'MANAGER' ? 'MANAGER' : 'MEMBER' };
		else if (t === 'google_account') out[k] = { type: t };
	}
	return out;
}
