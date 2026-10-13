import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import { listResources } from '#lib/server/resources.ts';
import { listPeople } from '#lib/server/accounts.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	const counts = await d.all<{ resource_id: string; n: number }>(
		"SELECT resource_id, CAST(COUNT(*) AS INTEGER) AS n FROM grants WHERE org_id = ? AND status <> 'revoked' GROUP BY resource_id",
		[c.org.id]
	);
	const open = await d.all<{ resource_id: string; n: number }>(
		"SELECT resource_id, CAST(COUNT(*) AS INTEGER) AS n FROM requests WHERE org_id = ? AND status IN ('pending_approval', 'pending_fulfillment') GROUP BY resource_id",
		[c.org.id]
	);
	const people = await listPeople(d, c.org.id, { includeDeactivated: true });
	return {
		resources: await listResources(d, c.org.id, { includeArchived: true }),
		grants: Object.fromEntries(counts.map((r) => [r.resource_id, Number(r.n)])),
		open: Object.fromEntries(open.map((r) => [r.resource_id, Number(r.n)])),
		people: people.map((p) => ({ id: p.id, name: p.name, email: p.email }))
	};
};
