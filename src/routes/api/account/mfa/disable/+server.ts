import { json } from '@sveltejs/kit';
import { membershipsOf, orgSettings } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { badRequest, body, handler, HttpError, str } from '#lib/server/http.ts';
import { disableMfa } from '#lib/server/mfa.ts';

/** Turns it off, with a current code; not while an organisation of theirs requires it. */
export const POST = handler(async (event) => {
	const user = event.locals.user;
	if (!user) throw new HttpError(401, 'Not signed in');
	const d = await db();
	for (const m of await membershipsOf(d, user.id)) if ((await orgSettings(d, m.orgId)).requireMfa) throw badRequest(`${m.orgName} requires two-step verification`);
	await disableMfa(d, user.id, str(await body(event), 'code', { required: true, max: 40 }));
	return json({ ok: true });
});
