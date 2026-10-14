import { json } from '@sveltejs/kit';
import { throttled } from '#lib/server/auth.ts';
import { db } from '#lib/server/db.ts';
import { body, handler, HttpError, notFound, str } from '#lib/server/http.ts';
import { orgForEmail, ssoSettings } from '#lib/server/sso.ts';

/** Cloud login: which SSO handles this email? */
export const POST = handler(async (event) => {
	if (throttled(`sso:${event.locals.ip}`)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
	const email = str(await body(event), 'email', { required: true });
	const d = await db();
	const orgId = await orgForEmail(d, email);
	const s = orgId ? await ssoSettings(d, orgId) : null;
	if (!s) throw notFound('Single sign-on isn’t set up for that email domain. Sign in with your password instead.');
	return json({ name: s.name, url: `/auth/oidc/start?email=${encodeURIComponent(email)}` });
});
