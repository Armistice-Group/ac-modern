import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, handler } from '#lib/server/http.ts';
import { adminReset } from '#lib/server/passwords.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	return json(await adminReset(await db(), { orgId: c.org.id, userId: c.user.id, role: c.role }, event.params.id!, event.locals.origin));
});
