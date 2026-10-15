import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { offboard } from '#lib/server/grants.ts';
import { actor, adminCtx, badRequest, body, handler, str } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const fx = effects();
	const left = str(b, 'leftAt');
	const leftAt = left ? new Date(left.length === 10 ? `${left}T23:59:59.999Z` : left) : null;
	if (leftAt && Number.isNaN(leftAt.getTime())) throw badRequest('Last day must be a date');
	const removals = await offboard(d, actor(c), event.params.id!, str(b, 'note', { max: 1000 }), fx, 'offboarding', leftAt?.toISOString() ?? null);
	await flush(d, c.org.id, fx, event.locals.origin);
	return json({ removals });
});
