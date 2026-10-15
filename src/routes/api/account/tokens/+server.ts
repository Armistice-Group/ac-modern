import { json } from '@sveltejs/kit';
import { createPersonalToken } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { body, ctx, handler, int, str } from '#lib/server/http.ts';

/** A personal token for an MCP client, acting as the signed-in member. */
export const POST = handler(async (event) => {
	const c = ctx(event.locals);
	const b = await body(event);
	const name = str(b, 'name', { required: true, max: 80 });
	const canApprove = b.canApprove === true;
	const d = await db();
	const t = await createPersonalToken(d, c.org.id, c.user.id, name, canApprove, int(b, 'expiresDays', { min: 1, max: 365 }));
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'token.created', subject: name, summary: `Created personal token “${name}” for MCP${canApprove ? ' (can approve and deny)' : ''}`, data: { canApprove } });
	return json(t);
});
