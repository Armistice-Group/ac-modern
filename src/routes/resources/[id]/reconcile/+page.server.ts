import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listReconciliations } from '#lib/server/reconcile.ts';
import { getResource } from '#lib/server/resources.ts';
import { INTEGRATIONS } from '#lib/integrations.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const c = ctx(locals);
	if (!isAdmin(c)) error(404, 'Not found');
	const d = await db();
	const resource = await getResource(d, c.org.id, params.id).catch(() => error(404, 'That resource doesn’t exist'));
	const mapped = resource.fulfillment === 'integration' && !!resource.integration && resource.roles.some((r) => resource.integrationMap[r.id]);
	return {
		resource: { id: resource.id, name: resource.name, color: resource.color },
		pullFrom: mapped && resource.integration ? INTEGRATIONS[resource.integration].name : null,
		runs: await listReconciliations(d, c.org.id, { resourceId: resource.id })
	};
};
