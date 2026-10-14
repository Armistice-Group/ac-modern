import { json } from '@sveltejs/kit';
import { revokeToken } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	if (await revokeToken(d, c.org.id, event.params.id!)) await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: 'Revoked an API token' });
	return json({ ok: true });
});
