import { listPeople, orgSettings } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { listGrants } from '#lib/server/grants.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listRequests } from '#lib/server/requests.ts';
import { listResources } from '#lib/server/resources.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const [resources, grants, open, people, settings] = await Promise.all([
		listResources(d, c.org.id),
		listGrants(d, c.org.id, { userId: c.user.id }),
		listRequests(d, c.org.id, { userId: c.user.id, statuses: ['pending_approval', 'pending_fulfillment'], kind: 'grant' }),
		listPeople(d, c.org.id),
		orgSettings(d, c.org.id)
	]);
	const reports = people.filter((p) => p.managerId === c.user.id).map((p) => p.id);
	return {
		resources: resources.filter((r) => r.requestable || admin),
		held: grants.map((g) => ({ roleId: g.role.id, resourceId: g.resource.id, expiresAt: g.expiresAt, status: g.status })),
		open: open.map((r) => ({ number: r.number, resourceId: r.resource.id, roleName: r.role.name })),
		people: people.map((p) => ({ id: p.id, name: p.name, email: p.email })),
		canRequestFor: admin || settings.allowOnBehalf ? ('all' as const) : reports
	};
};
