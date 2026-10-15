import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { parsePolicy, savePolicy } from '#lib/server/reviews.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const id = await savePolicy(await db(), c.org.id, c.user.id, null, parsePolicy(await body(event)));
	return json({ id });
});
