import { json } from '@sveltejs/kit';
import { membership, setSessionOrg } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { body, forbidden, handler, HttpError, str } from '#lib/server/http.ts';

export const POST = handler(async (event) => {
	const { user, sessionId } = event.locals;
	if (!user || !sessionId) throw new HttpError(401, 'Not signed in');
	const orgId = str(await body(event), 'orgId', { required: true });
	const d = await db();
	if (!(await membership(d, orgId, user.id))) throw forbidden('You’re not a member of that organisation');
	await setSessionOrg(d, sessionId, orgId);
	return json({ ok: true });
});
