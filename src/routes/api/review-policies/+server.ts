import { changeOrPropose, changeResponse } from '#lib/server/control-changes.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { effects } from '#lib/server/requests.ts';
import { parsePolicy } from '#lib/server/reviews.ts';

/** Adding a review policy only adds oversight, so it never waits for a second admin. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parsePolicy(await body(event));
	return changeResponse(await changeOrPropose(await db(), c.org.id, c.user.id, { kind: 'review_policy', action: 'create', targetId: null, payload: input, summary: `Add review policy “${input.name}”` }, effects(), false));
});
