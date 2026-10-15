import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, adminCtx, body, handler, oneOf, str } from '#lib/server/http.ts';
import { resolveItem } from '#lib/server/reconcile.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	await resolveItem(await db(), actor(c), event.params.id!, {
		resolution: oneOf(b, 'resolution', ['recorded', 'removed_in_system', 'service_account', 'closed', 'kept'] as const),
		note: str(b, 'note', { max: 1000 }),
		roleId: str(b, 'roleId') || null
	});
	return json({ ok: true });
});
