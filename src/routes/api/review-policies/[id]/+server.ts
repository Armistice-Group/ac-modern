import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { deletePolicy, parsePolicy, savePolicy } from '#lib/server/reviews.ts';

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	await savePolicy(await db(), c.org.id, c.user.id, event.params.id!, parsePolicy(await body(event)));
	return json({ ok: true });
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	await deletePolicy(await db(), c.org.id, c.user.id, event.params.id!);
	return json({ ok: true });
});
