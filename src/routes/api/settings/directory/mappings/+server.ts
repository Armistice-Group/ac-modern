import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { addMapping, reconcile } from '#lib/server/directory.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler, oneOf, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const target = oneOf(b, 'target', ['admin', 'access'] as const);
	const groupId = str(b, 'groupId', { required: true });
	await addMapping(d, c.org.id, { groupId, target, resourceId: str(b, 'resourceId'), roleId: str(b, 'roleId') });
	const g = await d.get<{ name: string }>('SELECT name FROM directory_groups WHERE org_id = ? AND id = ?', [c.org.id, groupId]);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: g?.name ?? groupId, summary: `Mapped directory group ${g?.name} to ${target === 'admin' ? 'ac·modern admins' : 'an access level'}` });
	const fx = effects();
	const result = await reconcile(d, c.org.id, fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json(result);
});
