import { json } from '@sveltejs/kit';
import { portal } from '#lib/server/billing.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, handler } from '#lib/server/http.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	return json({ url: await portal(await db(), c.org.id, event.locals.origin) });
});
