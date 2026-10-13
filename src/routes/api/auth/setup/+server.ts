import { json } from '@sveltejs/kit';
import { countOrgs } from '#lib/server/accounts.ts';
import { setupOrg, startSession } from '#lib/server/auth.ts';
import { isCloud } from '#lib/server/config.ts';
import { db } from '#lib/server/db.ts';
import { badRequest, body, conflict, handler, str } from '#lib/server/http.ts';

/** Self-hosted first run: the organisation and its owner. */
export const POST = handler(async (event) => {
	if (isCloud()) throw badRequest('Use /signup to create an organisation');
	if ((await countOrgs(await db())) > 0) throw conflict('ac·modern is already set up');
	const b = await body(event);
	const password = str(b, 'password', { required: true, max: 500 });
	if (password.length < 8) throw badRequest('Use at least 8 characters for the password');
	const { user, org } = await setupOrg({ orgName: str(b, 'orgName', { required: true, max: 80 }), name: str(b, 'name', { max: 120 }), email: str(b, 'email', { required: true }), password });
	await startSession(event.cookies, user.id, org.id, event.locals.secure);
	return json({ ok: true });
});
