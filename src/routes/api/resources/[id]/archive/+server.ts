import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { getResource, setArchived } from '#lib/server/resources.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const archived = (await body(event)).archived !== false;
	const d = await db();
	const r = await getResource(d, c.org.id, event.params.id!);
	await setArchived(d, c.org.id, r.id, archived);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: archived ? 'resource.archived' : 'resource.restored', subject: r.name, summary: `${archived ? 'Archived' : 'Restored'} resource ${r.name}` });
	return json({ ok: true });
});
