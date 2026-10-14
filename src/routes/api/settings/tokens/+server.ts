import { json } from '@sveltejs/kit';
import { createToken } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler, int, str } from '#lib/server/http.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const name = str(b, 'name', { required: true, max: 80 });
	const d = await db();
	const t = await createToken(d, c.org.id, name, c.user.id, int(b, 'expiresDays', { min: 1, max: 730 }));
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: name, summary: `Created API token “${name}”` });
	return json(t);
});
