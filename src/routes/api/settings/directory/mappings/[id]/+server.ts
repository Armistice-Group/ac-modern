import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { reconcile, removeMapping } from '#lib/server/directory.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	await removeMapping(d, c.org.id, event.params.id!);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: 'Removed a directory group mapping' });
	const fx = effects();
	const result = await reconcile(d, c.org.id, fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json(result);
});
