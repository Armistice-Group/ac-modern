import { changeOrPropose, changeResponse } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { describeRule, parseRule, validateRule } from '#lib/server/rules.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parseRule(await body(event));
	const d = await db();
	await validateRule(d, c.org.id, input);
	const fx = effects();
	const r = await changeOrPropose(d, c.org.id, c.user.id, { kind: 'rule', action: 'create', targetId: null, payload: input, summary: `Add auto-approval rule “${input.name}”: ${await describeRule(d, c.org.id, input)}` }, fx);
	await flush(d, c.org.id, fx, event.locals.origin);
	return changeResponse(r);
});
