import { listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import { listResources } from '#lib/server/resources.ts';
import { describeRule, listRules } from '#lib/server/rules.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	const rules = [];
	for (const r of await listRules(d, c.org.id)) rules.push({ ...r, description: await describeRule(d, c.org.id, r) });
	const resources = (await listResources(d, c.org.id)).map((r) => ({ id: r.id, name: r.name, color: r.color, approval: r.approval, roles: r.roles.map((x) => ({ id: x.id, name: x.name, privileged: x.privileged })) }));
	const groups = await d.all<{ id: string; name: string; members: number }>(
		`SELECT g.id, g.name, COUNT(dm.user_id) AS members FROM directory_groups g LEFT JOIN directory_memberships dm ON dm.org_id = g.org_id AND dm.group_id = g.id
		 WHERE g.org_id = ? GROUP BY g.id, g.name ORDER BY g.name`,
		[c.org.id]
	);
	const people = (await listPeople(d, c.org.id)).filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name, email: p.email }));
	return { rules, resources, groups: groups.map((g) => ({ ...g, members: Number(g.members) })), people };
};
