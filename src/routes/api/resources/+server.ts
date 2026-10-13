import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { parseResourceInput, saveResource } from '#lib/server/resources.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parseResourceInput(await body(event));
	const d = await db();
	const id = await saveResource(d, c.org.id, null, input);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'resource.created', subject: input.name, summary: `Added resource ${input.name}` });
	return json({ id });
});
