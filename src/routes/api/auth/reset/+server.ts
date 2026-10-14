import { json } from '@sveltejs/kit';
import { membershipsOf } from '#lib/server/accounts.ts';
import { startSession, throttled } from '#lib/server/auth.ts';
import { db } from '#lib/server/db.ts';
import { body, handler, HttpError, str } from '#lib/server/http.ts';
import { completeReset } from '#lib/server/passwords.ts';

export const POST = handler(async (event) => {
	if (throttled(`reset:${event.locals.ip}`)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
	const b = await body(event);
	const d = await db();
	const { userId } = await completeReset(d, str(b, 'token', { required: true, max: 200 }), str(b, 'password', { required: true, max: 500 }));
	const orgs = await membershipsOf(d, userId);
	await startSession(event.cookies, userId, orgs[0]?.orgId ?? null, event.locals.secure);
	return json({ ok: true });
});
