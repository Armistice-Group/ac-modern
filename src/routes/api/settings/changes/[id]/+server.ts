import { json } from '@sveltejs/kit';
import { cancelChange, decideChange } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler, oneOf, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';

/** Another admin approves or rejects a proposed control change. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const fx = effects();
	await decideChange(d, c.org.id, c.user.id, event.params.id!, oneOf(b, 'decision', ['approved', 'rejected'] as const), str(b, 'note', { max: 1000 }), fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ ok: true });
});

/** Whoever proposed it withdraws it. */
export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	await cancelChange(await db(), c.org.id, c.user.id, event.params.id!);
	return json({ ok: true });
});
