import { json } from '@sveltejs/kit';
import { startSession, throttled } from '#lib/server/auth.ts';
import { db } from '#lib/server/db.ts';
import { body, handler, HttpError, str } from '#lib/server/http.ts';
import { readTicket, recordMfaFailure, verifyMfa } from '#lib/server/mfa.ts';

/** The second step of a password sign-in: a code from the authenticator app, or a recovery code. */
export const POST = handler(async (event) => {
	const b = await body(event);
	const { userId, orgId } = readTicket(str(b, 'ticket', { required: true, max: 1000 }));
	if (throttled(`mfa:${event.locals.ip}`) || throttled(`mfa:${userId}`)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
	const d = await db();
	const how = await verifyMfa(d, userId, str(b, 'code', { required: true, max: 40 }));
	if (!how) {
		await recordMfaFailure(d, userId);
		throw new HttpError(401, 'That code didn’t work. Use the newest code from your app, or a recovery code.');
	}
	await startSession(event.cookies, userId, orgId, event.locals.secure, 'password+totp');
	return json({ ok: true, recovery: how === 'recovery' });
});
