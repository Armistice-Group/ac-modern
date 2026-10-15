import { changeOrPropose, changeResponse } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { describeRule, getRule, parseRule, validateRule } from '#lib/server/rules.ts';

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parseRule(await body(event));
	const d = await db();
	const before = await getRule(d, c.org.id, event.params.id!);
	await validateRule(d, c.org.id, input);
	const fx = effects();
	const summary =
		before.enabled !== input.enabled && (await describeRule(d, c.org.id, before)) === (await describeRule(d, c.org.id, input))
			? `${input.enabled ? 'Turn on' : 'Turn off'} auto-approval rule “${input.name}”`
			: `Change auto-approval rule “${input.name}”: ${await describeRule(d, c.org.id, input)}`;
	const r = await changeOrPropose(d, c.org.id, c.user.id, { kind: 'rule', action: 'update', targetId: before.id, payload: input, summary }, fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return changeResponse(r);
});

/** Deleting a rule only makes approval stricter, so it never waits for a second admin. */
export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const rule = await getRule(d, c.org.id, event.params.id!);
	return changeResponse(await changeOrPropose(d, c.org.id, c.user.id, { kind: 'rule', action: 'delete', targetId: rule.id, payload: null, summary: `Delete auto-approval rule “${rule.name}”` }, effects(), false));
});
