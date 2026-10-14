import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { rotateScimToken } from '#lib/server/directory.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const token = await rotateScimToken(d, c.org.id);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: 'Generated a new SCIM token' });
	return json({ token });
});
