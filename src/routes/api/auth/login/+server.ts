import { json } from '@sveltejs/kit';
import { membershipsOf, userByEmail } from '#lib/server/accounts.ts';
import { startSession, throttled } from '#lib/server/auth.ts';
import { verifyPassword } from '#lib/server/crypto.ts';
import { hasMfa, mfaTicket } from '#lib/server/mfa.ts';
import { ssoSettings } from '#lib/server/sso.ts';
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
	// Start in an org that accepts passwords; if none does, point them at SSO.
	let start: string | null = orgs[0]?.orgId ?? null;
	if (orgs.length) {
		const open = [];
		for (const m of orgs) if (m.role === 'owner' || !(await ssoSettings(d, m.orgId))?.required) open.push(m.orgId);
		if (!open.length) throw new HttpError(403, `${orgs[0].orgName} signs in with single sign-on`, { sso: `/auth/oidc/start?org=${orgs[0].orgId}` });
		start = open[0];
	}
	// Two-step verification: the password alone doesn't start a session.
	if (await hasMfa(d, user.id)) return json({ mfa: true, ticket: mfaTicket(user.id, start) });
	await startSession(event.cookies, user.id, start, event.locals.secure);
	return json({ ok: true });
});
