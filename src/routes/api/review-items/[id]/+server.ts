import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, body, ctx, handler, oneOf, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { decideItem } from '#lib/server/reviews.ts';

export const POST = handler(async (event) => {
	const c = ctx(event.locals);
	const b = await body(event);
	const d = await db();
	const fx = effects();
	await decideItem(d, actor(c), event.params.id!, oneOf(b, 'decision', ['keep', 'revoke'] as const), str(b, 'note', { max: 1000 }), fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ ok: true });
});
