import { json } from '@sveltejs/kit';
import { deleteUserSessions, updateUser, userByEmail } from '#lib/server/accounts.ts';
import { hashPassword, verifyPassword } from '#lib/server/crypto.ts';
import { db } from '#lib/server/db.ts';
import { badRequest, body, handler, HttpError, str } from '#lib/server/http.ts';

export const PATCH = handler(async (event) => {
	const user = event.locals.user;
	if (!user) throw new HttpError(401, 'Not signed in');
	const b = await body(event);
	const d = await db();
	if (b.name !== undefined) await updateUser(d, user.id, { name: str(b, 'name', { max: 120 }) });
	if (b.githubLogin !== undefined) await updateUser(d, user.id, { githubLogin: str(b, 'githubLogin', { max: 40 }) });
	if (b.newPassword !== undefined) {
		const current = await userByEmail(d, user.email);
		if (!verifyPassword(str(b, 'currentPassword', { max: 500 }), current?.password_hash ?? null)) throw badRequest('Your current password is wrong');
		const next = str(b, 'newPassword', { required: true, max: 500 });
		if (next.length < 8) throw badRequest('Use at least 8 characters');
		await updateUser(d, user.id, { passwordHash: hashPassword(next) });
		// Other devices sign in again with the new password.
		await deleteUserSessions(d, user.id, event.locals.sessionId ?? undefined);
	}
	return json({ ok: true });
});
