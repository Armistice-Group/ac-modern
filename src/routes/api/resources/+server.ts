import { changeOrPropose, changeResponse } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';
import { parseResourceInput, validateResource } from '#lib/server/resources.ts';

/** A new system with no approval step is a control change; others are added straight away. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parseResourceInput(await body(event));
	validateResource(input);
	const d = await db();
	const fx = effects();
	const r = await changeOrPropose(d, c.org.id, c.user.id, { kind: 'resource', action: 'create', targetId: null, payload: input, summary: `Add system ${input.name} with no approval step` }, fx, input.approval === 'none');
	await flush(d, c.org.id, fx, event.locals.origin);
	return changeResponse(r);
});
