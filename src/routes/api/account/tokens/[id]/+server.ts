import { json } from '@sveltejs/kit';
import { listPersonalTokens, revokePersonalToken } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { ctx, handler, isAdmin, notFound } from '#lib/server/http.ts';

/** Revokes a personal token: your own, or anyone's if you're an admin. */
export const DELETE = handler(async (event) => {
	const c = ctx(event.locals);
	const d = await db();
	const admin = isAdmin(c);
	const t = (await listPersonalTokens(d, c.org.id, admin ? undefined : c.user.id)).find((x) => x.id === event.params.id);
	if (!t || !(await revokePersonalToken(d, c.org.id, t.id, admin ? undefined : c.user.id))) throw notFound('That token doesn’t exist');
	const own = t.user.id === c.user.id;
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'token.revoked', subject: t.name, summary: `Revoked ${own ? 'their' : `${t.user.name || t.user.email}’s`} personal token “${t.name}”` });
	return json({ ok: true });
});
