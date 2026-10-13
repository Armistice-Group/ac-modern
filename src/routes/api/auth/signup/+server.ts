import { json } from '@sveltejs/kit';
import { addMember, createOrg, setSessionOrg } from '#lib/server/accounts.ts';
import { emailAllowed, setupOrg, startSession, throttled } from '#lib/server/auth.ts';
import { isCloud } from '#lib/server/config.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { badRequest, body, forbidden, handler, HttpError, str } from '#lib/server/http.ts';

/** Cloud: create an organisation (and an account, when not signed in). */
export const POST = handler(async (event) => {
	if (!isCloud()) throw forbidden('Sign-up is only available on the hosted version');
	if (throttled(`signup:${event.locals.ip}`)) throw new HttpError(429, 'Too many sign-ups from this address. Try again later.');
	const b = await body(event);
	const orgName = str(b, 'orgName', { required: true, max: 80 });
	const d = await db();

	if (event.locals.user) {
		const user = event.locals.user;
		const org = await d.tx(async (tx) => {
			const org = await createOrg(tx, orgName);
			await addMember(tx, org.id, user.id, 'owner');
			await record(tx, { orgId: org.id, actorId: user.id, action: 'org.created', subject: org.name, summary: `Created ${org.name}` });
			return org;
		});
		await setSessionOrg(d, event.locals.sessionId!, org.id);
		return json({ ok: true });
	}

	const email = str(b, 'email', { required: true });
	if (!emailAllowed(email)) throw forbidden('Sign-ups from that email domain aren’t open');
	const password = str(b, 'password', { required: true, max: 500 });
	if (password.length < 8) throw badRequest('Use at least 8 characters for the password');
	const { user, org } = await setupOrg({ orgName, name: str(b, 'name', { max: 120 }), email, password });
	await startSession(event.cookies, user.id, org.id, event.locals.secure);
	return json({ ok: true });
});
