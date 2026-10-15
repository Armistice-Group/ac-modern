import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { parseRule, saveRule } from '#lib/server/rules.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const id = await saveRule(await db(), c.org.id, c.user.id, null, parseRule(await body(event)));
	return json({ id });
});
