import { listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { listGrants } from '#lib/server/grants.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listResources, stewardedResourceIds } from '#lib/server/resources.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const stewarded = await stewardedResourceIds(d, c.org.id, c.user.id);
	const mine = url.searchParams.get('mine') === '1' || (!admin && !stewarded.length);
	const resourceId = url.searchParams.get('resource') ?? '';
	const expiring = Number(url.searchParams.get('expiring')) || undefined;
	const q = url.searchParams.get('q') ?? '';
	// Point in time (end of that day): who had access then, for audit samples.
	const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('asOf') ?? '') && !mine ? url.searchParams.get('asOf')! : '';
	const asOf = asOfDate ? `${asOfDate}T23:59:59.999Z` : undefined;

	const grants = mine
		? await listGrants(d, c.org.id, { userId: c.user.id, q, resourceId: resourceId || undefined, expiringWithinDays: expiring })
		: await listGrants(d, c.org.id, { q, resourceId: resourceId || undefined, resourceIds: admin ? undefined : stewarded, expiringWithinDays: asOf ? undefined : expiring, asOf });

	const resources = await listResources(d, c.org.id);
	return {
		grants,
		mine,
		canSeeOthers: admin || stewarded.length > 0,
		stewarded,
		filters: { resourceId, expiring: expiring ?? null, q, asOf: asOfDate },
		resources: resources.filter((r) => admin || stewarded.includes(r.id) || mine).map((r) => ({ id: r.id, name: r.name, color: r.color, roles: r.roles })),
		people: admin ? (await listPeople(d, c.org.id)).map((p) => ({ id: p.id, name: p.name, email: p.email })) : []
	};
};
