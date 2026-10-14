import { json } from '@sveltejs/kit';
import { applyAccessChange } from '#lib/server/changes.ts';
import { db } from '#lib/server/db.ts';
import { actor, badRequest, body, ctx, handler, ids, oneOf, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';

export const POST = handler(async (event) => {
	const c = ctx(event.locals);
	const b = await body(event);
	const add = b.add ?? [];
	if (!Array.isArray(add) || add.length > 50) throw badRequest('add must be a list of up to 50 items');
	const d = await db();
	const fx = effects();
	const result = await applyAccessChange(
		d,
		actor(c),
		{
			userId: event.params.id!,
			kind: oneOf(b, 'kind', ['onboarding', 'transfer'] as const),
			reason: str(b, 'reason', { required: true, max: 1000 }),
			add: add.map((a: Record<string, unknown>) => {
				if (typeof a?.resourceId !== 'string' || typeof a?.roleId !== 'string') throw badRequest('Each addition needs a resource and a level');
				const days = a.durationDays === null || a.durationDays === undefined || a.durationDays === '' ? null : Number(a.durationDays);
				if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw badRequest('Durations must be 1–3650 days');
				return { resourceId: a.resourceId, roleId: a.roleId, durationDays: days };
			}),
			remove: ids(b, 'remove'),
			title: typeof b.title === 'string' ? b.title.trim().slice(0, 120) : undefined,
			managerId: b.managerId === undefined ? undefined : str(b, 'managerId') || null
		},
		fx
	);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json(result);
});
