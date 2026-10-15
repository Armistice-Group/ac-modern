import { changeOrPropose, changeResponse } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { describePolicy, getPolicy, parsePolicy } from '#lib/server/reviews.ts';

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parsePolicy(await body(event));
	const d = await db();
	const before = await getPolicy(d, c.org.id, event.params.id!);
	const fx = effects();
	const summary =
		before.enabled !== input.enabled && (await describePolicy(d, c.org.id, before)) === (await describePolicy(d, c.org.id, input))
			? `${input.enabled ? 'Turn on' : 'Pause'} review policy “${input.name}”`
			: `Change review policy “${input.name}”: ${await describePolicy(d, c.org.id, input)}`;
	const r = await changeOrPropose(d, c.org.id, c.user.id, { kind: 'review_policy', action: 'update', targetId: before.id, payload: input, summary }, fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return changeResponse(r);
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const p = await getPolicy(d, c.org.id, event.params.id!);
	const fx = effects();
	const r = await changeOrPropose(d, c.org.id, c.user.id, { kind: 'review_policy', action: 'delete', targetId: p.id, payload: null, summary: `Delete review policy “${p.name}”` }, fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return changeResponse(r);
});
