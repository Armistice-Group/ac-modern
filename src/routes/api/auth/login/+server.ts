import { json } from '@sveltejs/kit';
import { membershipsOf, userByEmail } from '#lib/server/accounts.ts';
import { startSession, throttled } from '#lib/server/auth.ts';
import { verifyPassword } from '#lib/server/crypto.ts';
import { db } from '#lib/server/db.ts';
import { body, handler, HttpError, str } from '#lib/server/http.ts';

export const POST = handler(async (event) => {
	const b = await body(event);
	const email = str(b, 'email', { required: true });
	const password = str(b, 'password', { required: true, max: 500 });
	if (throttled(`login:${event.locals.ip}`) || throttled(`login:${email.toLowerCase()}`)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
	const d = await db();
	const user = await userByEmail(d, email);
	if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Wrong email or password');
	const orgs = await membershipsOf(d, user.id);
	await startSession(event.cookies, user.id, orgs[0]?.orgId ?? null, event.locals.secure);
	return json({ ok: true });
});
