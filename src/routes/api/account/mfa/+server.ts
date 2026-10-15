import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { handler, HttpError } from '#lib/server/http.ts';
import { beginEnroll } from '#lib/server/mfa.ts';

/** Starts setup: a new secret and its QR code. Nothing changes until it's confirmed. */
export const POST = handler(async (event) => {
	const user = event.locals.user;
	if (!user) throw new HttpError(401, 'Not signed in');
	return json(await beginEnroll(await db(), user.id));
});
