import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { deleteRule, parseRule, saveRule } from '#lib/server/rules.ts';

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	await saveRule(await db(), c.org.id, c.user.id, event.params.id!, parseRule(await body(event)));
	return json({ ok: true });
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	await deleteRule(await db(), c.org.id, c.user.id, event.params.id!);
	return json({ ok: true });
});
