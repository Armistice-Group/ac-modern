import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { offboard } from '#lib/server/grants.ts';
import { actor, adminCtx, body, handler, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const fx = effects();
	const removals = await offboard(d, actor(c), event.params.id!, str(b, 'note', { max: 1000 }), fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ removals });
});
