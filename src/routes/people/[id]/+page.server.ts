import { error } from '@sveltejs/kit';
import { getPerson, listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { listGrants } from '#lib/server/grants.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listRequests } from '#lib/server/requests.ts';
import { listResources } from '#lib/server/resources.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const person = await getPerson(d, c.org.id, params.id).catch(() => error(404, 'That person isn’t in this organisation'));
	// Managers see their own reports; everything else is admin-only.
	if (!admin && person.managerId !== c.user.id) error(404, 'That person isn’t in this organisation');
	const people = await listPeople(d, c.org.id);
	const others = await d.all<{ user_id: string; resource_id: string; role_id: string }>(
		"SELECT user_id, resource_id, role_id FROM grants WHERE org_id = ? AND status = 'active' AND user_id <> ?",
		[c.org.id, person.id]
	);
	return {
		admin,
		resources: (await listResources(d, c.org.id)).map((r) => ({ id: r.id, name: r.name, color: r.color, roles: r.roles, maxDays: r.maxDays, defaultDays: r.defaultDays })),
		othersAccess: others.map((g) => ({ userId: g.user_id, resourceId: g.resource_id, roleId: g.role_id })),
		person,
		people: people.filter((p) => p.id !== person.id).map((p) => ({ id: p.id, name: p.name, email: p.email })),
		reports: people.filter((p) => p.managerId === person.id).map((p) => ({ id: p.id, name: p.name, email: p.email })),
		grants: await listGrants(d, c.org.id, { userId: person.id }),
		requests: await listRequests(d, c.org.id, { userId: person.id, limit: 20 }),
		myRole: c.role
	};
};
