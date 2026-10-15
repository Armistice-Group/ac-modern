import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { getReconciliation, reconciliationItems } from '#lib/server/reconcile.ts';
import { getResource } from '#lib/server/resources.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const c = ctx(locals);
	if (!isAdmin(c)) error(404, 'Not found');
	const d = await db();
	const run = await getReconciliation(d, c.org.id, params.run).catch(() => error(404, 'That reconciliation doesn’t exist'));
	if (run.resource.id !== params.id) error(404, 'That reconciliation doesn’t exist');
	const resource = await getResource(d, c.org.id, params.id);
	return { run, items: await reconciliationItems(d, c.org.id, run.id), roles: resource.roles.map((r) => ({ id: r.id, name: r.name, privileged: r.privileged })) };
};
