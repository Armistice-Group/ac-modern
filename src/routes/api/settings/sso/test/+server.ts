import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, badRequest, handler, HttpError } from '#lib/server/http.ts';
import { ssoSettings, testSso } from '#lib/server/sso.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const s = await ssoSettings(await db(), c.org.id);
	if (!s) throw badRequest('Save the SSO settings first');
	try {
		return json(await testSso(s));
	} catch (err) {
		throw new HttpError(502, `Discovery failed: ${(err as Error).message}`);
	}
});
