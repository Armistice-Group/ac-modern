import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, adminCtx, body, handler, ids, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { createReview } from '#lib/server/reviews.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const fx = effects();
	const due = str(b, 'dueAt');
	const id = await createReview(d, actor(c), { name: str(b, 'name', { required: true, max: 120 }), dueAt: due ? new Date(due).toISOString() : null, resourceIds: ids(b, 'resourceIds') }, fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ id });
});
