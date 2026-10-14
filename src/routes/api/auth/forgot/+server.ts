import { json } from '@sveltejs/kit';
import { throttled } from '#lib/server/auth.ts';
import { db } from '#lib/server/db.ts';
import { body, handler, HttpError, str } from '#lib/server/http.ts';
import { requestReset } from '#lib/server/passwords.ts';

/** Always answers the same, whether or not the address has an account. */
export const POST = handler(async (event) => {
	const email = str(await body(event), 'email', { required: true, max: 200 });
	if (throttled(`forgot:${event.locals.ip}`) || throttled(`forgot:${email.toLowerCase()}`)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
	await requestReset(await db(), email, event.locals.origin);
	return json({ ok: true });
});
