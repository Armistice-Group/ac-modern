import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, badRequest, handler } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { getPolicy, runPolicy } from '#lib/server/reviews.ts';

/** Starts the policy's review now, without moving its schedule. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const fx = effects();
	const id = await runPolicy(d, c.org.id, await getPolicy(d, c.org.id, event.params.id!), fx, c.user.id);
	if (!id) throw badRequest('Nothing in scope to review yet');
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ id });
});
