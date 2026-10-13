import { error } from '@sveltejs/kit';
import { listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { listGrants } from '#lib/server/grants.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listRequests } from '#lib/server/requests.ts';
import { getResource, stewardedResourceIds } from '#lib/server/resources.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	if (!admin && !(await stewardedResourceIds(d, c.org.id, c.user.id)).includes(params.id)) error(404, 'Not found');
	const resource = await getResource(d, c.org.id, params.id).catch(() => error(404, 'That resource doesn’t exist'));
	return {
		resource,
		admin,
		people: (await listPeople(d, c.org.id)).map((p) => ({ id: p.id, name: p.name, email: p.email })),
		grants: await listGrants(d, c.org.id, { resourceId: resource.id }),
		requests: await listRequests(d, c.org.id, { resourceIds: [resource.id], limit: 10 }),
		origin: locals.origin
	};
};
