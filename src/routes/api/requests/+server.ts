import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, body, ctx, handler, int, str } from '#lib/server/http.ts';
import { createRequest, effects, flush } from '#lib/server/requests.ts';

export const POST = handler(async (event) => {
	const c = ctx(event.locals);
	const b = await body(event);
	const d = await db();
	const fx = effects();
	const req = await createRequest(
		d,
		actor(c),
		{
			userId: str(b, 'userId') || c.user.id,
			resourceId: str(b, 'resourceId', { required: true }),
			roleId: str(b, 'roleId', { required: true }),
			justification: str(b, 'justification', { max: 2000 }),
			durationDays: int(b, 'durationDays', { min: 1, max: 3650 })
		},
		fx
	);
	await flush(d, c.org.id, fx, event.locals.origin);
	// The webhook may have completed it already.
	const { getRequest } = await import('#lib/server/requests.ts');
	return json(await getRequest(d, c.org.id, { id: req.id }));
});
