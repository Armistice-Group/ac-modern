import { json } from '@sveltejs/kit';
import { revokeInvite } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, handler } from '#lib/server/http.ts';

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	await revokeInvite(await db(), c.org.id, event.params.id!);
	return json({ ok: true });
});
