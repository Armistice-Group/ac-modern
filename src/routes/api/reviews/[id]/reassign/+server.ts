import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, adminCtx, body, handler, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { reassignItems } from '#lib/server/reviews.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const fx = effects();
	const n = await reassignItems(d, actor(c), event.params.id!, str(b, 'from') || null, str(b, 'to', { required: true }), fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ count: n });
});
