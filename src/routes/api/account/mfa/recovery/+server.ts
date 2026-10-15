import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { body, handler, HttpError, str } from '#lib/server/http.ts';
import { regenerateRecovery } from '#lib/server/mfa.ts';

/** New recovery codes (the old ones stop working), with a current code. */
export const POST = handler(async (event) => {
	const user = event.locals.user;
	if (!user) throw new HttpError(401, 'Not signed in');
	return json({ codes: await regenerateRecovery(await db(), user.id, str(await body(event), 'code', { required: true, max: 40 })) });
});
