import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, ids, int, notFound, str } from './http.ts';
import type { ApprovalRule, AutoRuleMatch } from '#lib/types.ts';

/**
 * Auto-approval rules. A request that matches every condition of an enabled rule skips
 * approval, and records which rule approved it and why, so the evidence shows a rule
 * (set by an admin, itself audited) rather than a missing approval. Privileged levels
 * never match: they always go to a person.
 */

interface Row {
	id: string;
	name: string;
	enabled: number;
	resource_ids: string;
	role_ids: string;
	group_ids: string;
	user_ids: string;
	max_days: number | null;
	created_at: string;
	updated_at: string;
}

const toRule = (r: Row): ApprovalRule => ({
	id: r.id,
	name: r.name,
	enabled: !!r.enabled,
	resourceIds: JSON.parse(r.resource_ids),
	roleIds: JSON.parse(r.role_ids),
	groupIds: JSON.parse(r.group_ids),
	userIds: JSON.parse(r.user_ids),
	maxDays: r.max_days === null ? null : Number(r.max_days),
	createdAt: r.created_at,
	updatedAt: r.updated_at
});

export async function listRules(db: Db, orgId: string): Promise<ApprovalRule[]> {
	return (await db.all<Row>('SELECT * FROM approval_rules WHERE org_id = ? ORDER BY created_at', [orgId])).map(toRule);
}

export async function getRule(db: Db, orgId: string, id: string): Promise<ApprovalRule> {
	const row = await db.get<Row>('SELECT * FROM approval_rules WHERE org_id = ? AND id = ?', [orgId, id]);
	if (!row) throw notFound('That rule doesn’t exist');
	return toRule(row);
}

export type RuleInput = Pick<ApprovalRule, 'name' | 'enabled' | 'resourceIds' | 'roleIds' | 'groupIds' | 'userIds' | 'maxDays'>;

/** Names for the ids a rule refers to, for summaries and the audit log. */
async function names(db: Db, orgId: string, r: RuleInput) {
	const pick = async (sql: string, ids: string[]) =>
		ids.length ? (await db.all<{ id: string; name: string }>(`${sql} AND id IN (${ids.map(() => '?').join(',')})`, [orgId, ...ids])) : [];
	const resources = await pick('SELECT id, name FROM resources WHERE org_id = ?', r.resourceIds);
	const roles = r.roleIds.length
		? await db.all<{ id: string; name: string }>(
				`SELECT rr.id, r.name || ' (' || rr.name || ')' AS name FROM resource_roles rr JOIN resources r ON r.id = rr.resource_id WHERE r.org_id = ? AND rr.id IN (${r.roleIds.map(() => '?').join(',')})`,
				[orgId, ...r.roleIds]
			)
		: [];
	const groups = await pick('SELECT id, name FROM directory_groups WHERE org_id = ?', r.groupIds);
	const people = r.userIds.length
		? await db.all<{ id: string; name: string }>(
				`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name FROM users u JOIN members m ON m.user_id = u.id AND m.org_id = ? WHERE u.id IN (${r.userIds.map(() => '?').join(',')})`,
				[orgId, ...r.userIds]
			)
		: [];
	return { resources, roles, groups, people };
}

/** The rule in words: "Auto-approves Grafana, Linear for people in Engineering, for up to 14 days." */
export async function describeRule(db: Db, orgId: string, r: RuleInput): Promise<string> {
	const n = await names(db, orgId, r);
	const list = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ');
	const what = n.roles.length ? list(n.roles) : n.resources.length ? `${list(n.resources)} (any non-privileged level)` : 'every system (non-privileged levels)';
	const who = [n.groups.length ? `people in ${list(n.groups)}` : '', n.people.length ? list(n.people) : ''].filter(Boolean).join(' or ') || 'everyone';
	return `${what} for ${who}${r.maxDays ? `, for up to ${r.maxDays} days` : ''}`;
}

export function parseRule(b: Record<string, unknown>): RuleInput {
	return {
		name: str(b, 'name', { required: true, max: 80 }),
		enabled: b.enabled !== false,
		resourceIds: ids(b, 'resourceIds'),
		roleIds: ids(b, 'roleIds'),
		groupIds: ids(b, 'groupIds'),
		userIds: ids(b, 'userIds'),
		maxDays: int(b, 'maxDays', { min: 1, max: 3650 })
	};
}

export async function validateRule(db: Db, orgId: string, r: RuleInput) {
	if (!r.name.trim()) throw badRequest('Name the rule, e.g. “Engineering tools”');
	if (r.maxDays !== null && (!Number.isInteger(r.maxDays) || r.maxDays < 1)) throw badRequest('Maximum duration must be at least a day');
	const n = await names(db, orgId, r);
	if (n.resources.length !== r.resourceIds.length) throw badRequest('One of the systems doesn’t exist');
	if (n.roles.length !== r.roleIds.length) throw badRequest('One of the access levels doesn’t exist');
	if (n.groups.length !== r.groupIds.length) throw badRequest('One of the groups doesn’t exist');
	if (n.people.length !== r.userIds.length) throw badRequest('One of the people isn’t a member');
	if (r.roleIds.length && r.resourceIds.length) {
		const owners = await db.all<{ resource_id: string }>(`SELECT resource_id FROM resource_roles WHERE id IN (${r.roleIds.map(() => '?').join(',')})`, r.roleIds);
		if (owners.some((o) => !r.resourceIds.includes(o.resource_id))) throw badRequest('An access level belongs to a system the rule doesn’t cover');
	}
}

export async function saveRule(db: Db, orgId: string, actorId: string, id: string | null, input: RuleInput): Promise<string> {
	await validateRule(db, orgId, input);
	const t = new Date().toISOString();
	const description = await describeRule(db, orgId, input);
	const cols = [input.name.trim(), input.enabled, JSON.stringify(input.resourceIds), JSON.stringify(input.roleIds), JSON.stringify(input.groupIds), JSON.stringify(input.userIds), input.maxDays];
	const data = { ...input, name: input.name.trim(), description };
	if (id) {
		const before = await getRule(db, orgId, id);
		await db.run('UPDATE approval_rules SET name = ?, enabled = ?, resource_ids = ?, role_ids = ?, group_ids = ?, user_ids = ?, max_days = ?, updated_at = ? WHERE org_id = ? AND id = ?', [
			...cols,
			t,
			orgId,
			id
		]);
		const conditions = (r: RuleInput) => JSON.stringify([r.name.trim(), r.resourceIds, r.roleIds, r.groupIds, r.userIds, r.maxDays]);
		const toggled = before.enabled !== input.enabled && conditions(before) === conditions(input);
		await record(db, {
			orgId,
			actorId,
			action: 'rule.updated',
			subject: input.name.trim(),
			summary: toggled ? `${input.enabled ? 'Turned on' : 'Turned off'} auto-approval rule “${input.name.trim()}”` : `Changed auto-approval rule “${input.name.trim()}”: ${description}${input.enabled ? '' : ' (off)'}`,
			data: { ...data, before: { ...before, description: await describeRule(db, orgId, before) } }
		});
		return id;
	}
	const nid = newId();
	await db.run(
		'INSERT INTO approval_rules (id, org_id, name, enabled, resource_ids, role_ids, group_ids, user_ids, max_days, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
		[nid, orgId, ...cols, actorId, t, t]
	);
	await record(db, { orgId, actorId, action: 'rule.created', subject: input.name.trim(), summary: `Added auto-approval rule “${input.name.trim()}”: ${description}`, data });
	return nid;
}

export async function deleteRule(db: Db, orgId: string, actorId: string, id: string) {
	const rule = await getRule(db, orgId, id);
	await db.run('DELETE FROM approval_rules WHERE org_id = ? AND id = ?', [orgId, id]);
	await record(db, { orgId, actorId, action: 'rule.deleted', subject: rule.name, summary: `Deleted auto-approval rule “${rule.name}”`, data: { ...rule, description: await describeRule(db, orgId, rule) } });
}

/** Directory groups an ac·modern user is in (through directory sync). */
export async function groupsOf(db: Db, orgId: string, userId: string): Promise<{ id: string; name: string }[]> {
	return db.all<{ id: string; name: string }>(
		`SELECT g.id, g.name FROM directory_memberships dm
		 JOIN directory_users du ON du.org_id = dm.org_id AND du.id = dm.user_id
		 JOIN directory_groups g ON g.org_id = dm.org_id AND g.id = dm.group_id
		 WHERE dm.org_id = ? AND du.user_id = ?`,
		[orgId, userId]
	);
}

/**
 * The first enabled rule a request matches, and why. Privileged levels never match; the
 * caller checks that.
 */
export async function matchRule(db: Db, orgId: string, q: { userId: string; resourceId: string; roleId: string; days: number | null }): Promise<AutoRuleMatch | null> {
	const rules = (await listRules(db, orgId)).filter((r) => r.enabled);
	if (!rules.length) return null;
	let groups: { id: string; name: string }[] | null = null;
	for (const r of rules) {
		if (r.resourceIds.length && !r.resourceIds.includes(q.resourceId)) continue;
		if (r.roleIds.length && !r.roleIds.includes(q.roleId)) continue;
		if (r.maxDays !== null && (q.days === null || q.days > r.maxDays)) continue;
		const why: string[] = [];
		if (r.groupIds.length || r.userIds.length) {
			groups ??= await groupsOf(db, orgId, q.userId);
			const inGroup = groups.find((g) => r.groupIds.includes(g.id));
			if (inGroup) why.push(`in ${inGroup.name}`);
			else if (r.userIds.includes(q.userId)) why.push('named in the rule');
			else continue;
		}
		if (r.maxDays !== null) why.push(`${q.days} day${q.days === 1 ? '' : 's'} (rule allows up to ${r.maxDays})`);
		return { id: r.id, name: r.name, reason: why.join('; ') || 'covers everyone' };
	}
	return null;
}
