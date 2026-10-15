import { json } from '@sveltejs/kit';
import { deleteUserSessions } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { body, handler, HttpError, str } from '#lib/server/http.ts';
import { confirmEnroll } from '#lib/server/mfa.ts';

/**
 * Finishes setup with a code from the app. This session counts as verified from now on,
 * and every other session is signed out, so none of them predate the second factor.
 */
export const POST = handler(async (event) => {
	const user = event.locals.user;
	if (!user) throw new HttpError(401, 'Not signed in');
	const d = await db();
	const codes = await confirmEnroll(d, user.id, str(await body(event), 'code', { required: true, max: 20 }));
	if (event.locals.sessionId) {
		await d.run("UPDATE sessions SET auth_method = 'password+totp' WHERE id = ? AND auth_method = 'password'", [event.locals.sessionId]);
		await deleteUserSessions(d, user.id, event.locals.sessionId);
	}
	return json({ codes });
});
