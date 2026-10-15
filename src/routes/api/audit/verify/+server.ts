import { json } from '@sveltejs/kit';
import { sealDays, verifyAndRecord } from '#lib/server/audit.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, handler } from '#lib/server/http.ts';

/** Seals anything due, then recomputes every sealed day. The check itself is logged. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	await sealDays(d, c.org.id);
	return json(await verifyAndRecord(d, c.org.id, c.user.id));
});
