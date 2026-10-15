import { listChanges } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	return { me: c.user.id, pending: await listChanges(d, c.org.id, { status: 'pending' }), recent: (await listChanges(d, c.org.id, { limit: 50 })).filter((x) => x.status !== 'pending') };
};
