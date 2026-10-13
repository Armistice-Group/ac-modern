import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, body, ctx, forbidden, handler, isAdmin, notFound, str } from '#lib/server/http.ts';
import { effects, flush, startRevoke } from '#lib/server/requests.ts';
import { stewardedResourceIds } from '#lib/server/resources.ts';

/** Starts removing a grant: its holder giving it up, or an admin/resource owner taking it away. */
export const POST = handler(async (event) => {
	const c = ctx(event.locals);
	const b = await body(event);
	const d = await db();
	const g = await d.get<{ user_id: string; resource_id: string }>('SELECT user_id, resource_id FROM grants WHERE org_id = ? AND id = ?', [c.org.id, event.params.id!]);
	if (!g) throw notFound('That access grant doesn’t exist');
	const own = g.user_id === c.user.id;
	const steward = (await stewardedResourceIds(d, c.org.id, c.user.id)).includes(g.resource_id);
	if (!own && !steward && !isAdmin(c)) throw forbidden('Only admins and the resource’s owners can revoke this');
	const fx = effects();
	const req = await d.tx((tx) => startRevoke(tx, actor(c), event.params.id!, own ? 'request' : 'manual', str(b, 'note', { max: 1000 }), fx));
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ number: req?.number ?? null });
});
