import { json } from '@sveltejs/kit';
import { addMember, createUser, inviteByToken, markInviteAccepted, setSessionOrg, userByEmail } from '#lib/server/accounts.ts';
import { startSession, throttled } from '#lib/server/auth.ts';
import { hashPassword, verifyPassword } from '#lib/server/crypto.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { badRequest, body, handler, HttpError, notFound, str } from '#lib/server/http.ts';

/** Accepts an invite: as the signed-in user, by signing in, or by creating the account. */
export const POST = handler(async (event) => {
	const b = await body(event);
	if (throttled(`invite:${event.locals.ip}`)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
	const d = await db();
	const invite = await inviteByToken(d, str(b, 'token', { required: true }));
	if (!invite) throw notFound('This invite has expired or was already used');

	let userId: string;
	const existing = await userByEmail(d, invite.email);
	if (event.locals.user?.email === invite.email) {
		userId = event.locals.user.id;
	} else if (existing) {
		if (!verifyPassword(str(b, 'password', { required: true, max: 500 }), existing.password_hash)) throw new HttpError(401, 'Wrong password');
		userId = existing.id;
	} else {
		const password = str(b, 'password', { required: true, max: 500 });
		if (password.length < 8) throw badRequest('Use at least 8 characters for the password');
		userId = (await createUser(d, { email: invite.email, name: str(b, 'name', { max: 120 }), passwordHash: hashPassword(password) })).id;
	}

	await d.tx(async (tx) => {
		await addMember(tx, invite.org_id, userId, invite.role);
		await markInviteAccepted(tx, invite.id);
		await record(tx, { orgId: invite.org_id, actorId: userId, action: 'member.joined', subject: invite.email, summary: `${invite.email} joined as ${invite.role}` });
	});
	if (event.locals.user?.id === userId && event.locals.sessionId) await setSessionOrg(d, event.locals.sessionId, invite.org_id);
	else await startSession(event.cookies, userId, invite.org_id, event.locals.secure);
	return json({ ok: true });
});
