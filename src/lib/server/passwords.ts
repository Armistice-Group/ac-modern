import { deleteUserSessions, membershipsOf, normEmail, updateUser, userByEmail } from './accounts.ts';
import { isCloud } from './config.ts';
import { hashPassword, newId, randomToken, sha256 } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, forbidden, notFound } from './http.ts';
import { sendEmail } from './notify.ts';
import type { Role } from '#lib/types.ts';

/**
 * Password resets. A reset is a single-use link (token stored hashed) that expires: an hour
 * when you ask for it yourself, a day when an admin sends it. Using it sets the password
 * and signs out every other session.
 */

const HOUR = 3_600_000;
export const MIN_PASSWORD = 8;

async function issue(db: Db, userId: string, createdBy: string | null, ttlMs: number): Promise<string> {
	const token = randomToken(32);
	const now = Date.now();
	// One live link at a time: a new one replaces any older ones.
	await db.run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [new Date(now).toISOString(), userId]);
	await db.run('INSERT INTO password_resets (id, user_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
		newId(),
		userId,
		sha256(token),
		createdBy,
		new Date(now).toISOString(),
		new Date(now + ttlMs).toISOString()
	]);
	return token;
}

const emailText = (link: string, ttl: string, byAdmin?: string) =>
	`${byAdmin ? `${byAdmin} sent you a link to set a new ac·modern password.` : 'Someone (hopefully you) asked to reset your ac·modern password.'}\n\n${link}\n\nThe link works once and expires in ${ttl}. If you didn’t ask for this, ignore it: your password hasn’t changed.\n\n— ac·modern`;

/**
 * "Forgot password". Answers the same whether or not the address has an account, so it
 * can't be used to find out who does. Without SMTP on a self-hosted install, the link is
 * written to the server log for the operator.
 */
export async function requestReset(db: Db, email: string, origin: string): Promise<void> {
	const user = await userByEmail(db, normEmail(email));
	if (!user) return;
	const token = await issue(db, user.id, null, HOUR);
	const link = `${origin}/reset-password/${token}`;
	const sent = await sendEmail(user.email, 'Reset your ac·modern password', emailText(link, 'an hour')).catch((err) => {
		console.warn(`[ac-modern] Reset email to ${user.email} failed: ${(err as Error).message}`);
		return false;
	});
	if (!sent && !isCloud()) console.log(`[ac-modern] Password reset requested for ${user.email} (no SMTP configured): ${link}`);
	for (const m of await membershipsOf(db, user.id)) await record(db, { orgId: m.orgId, actorId: user.id, action: 'auth.reset_requested', subject: user.email, summary: `Password reset requested for ${user.email}` });
}

/**
 * An admin sends someone in their organisation a reset link. Only owners can do it for
 * owners, and in the cloud never for someone who also belongs to another organisation (the
 * password is theirs across all of them). Without SMTP the admin gets the link to pass on.
 */
export async function adminReset(db: Db, actor: { orgId: string; userId: string; role: Role }, userId: string, origin: string): Promise<{ emailed: boolean; link?: string }> {
	if (userId === actor.userId) throw badRequest('Change your own password under Your account');
	const target = await db.get<{ email: string; name: string; role: Role; status: string }>(
		'SELECT u.email, u.name, m.role, m.status FROM users u JOIN members m ON m.user_id = u.id AND m.org_id = ? WHERE u.id = ?',
		[actor.orgId, userId]
	);
	if (!target) throw notFound('That person isn’t in this organisation');
	if (target.status !== 'active') throw badRequest('Reactivate them first');
	if (target.role === 'owner' && actor.role !== 'owner') throw forbidden('Only owners can reset an owner’s password');
	const elsewhere = (await membershipsOf(db, userId)).filter((m) => m.orgId !== actor.orgId);
	if (isCloud() && elsewhere.length) throw forbidden(`${target.email} also belongs to another organisation, so only they can reset their password (from the sign-in page)`);
	const admin = await db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [actor.userId]);
	const token = await issue(db, userId, actor.userId, 24 * HOUR);
	const link = `${origin}/reset-password/${token}`;
	const emailed = await sendEmail(target.email, 'Set your ac·modern password', emailText(link, 'a day', admin?.name || admin?.email)).catch(() => false);
	await record(db, { orgId: actor.orgId, actorId: actor.userId, action: 'auth.reset_sent', subject: target.email, summary: `Sent ${target.name || target.email} a password reset link${emailed ? '' : ' (shown to the admin; no email configured)'}` });
	return emailed ? { emailed } : { emailed, link };
}

/** Who a live reset link is for, if it's still good. */
export async function resetFor(db: Db, token: string) {
	return db.get<{ id: string; user_id: string; email: string }>(
		`SELECT r.id, r.user_id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
		 WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`,
		[sha256(token), new Date().toISOString()]
	);
}

/** Uses a reset link: sets the password, burns the link, signs out everywhere. */
export async function completeReset(db: Db, token: string, password: string): Promise<{ userId: string }> {
	if (password.length < MIN_PASSWORD) throw badRequest(`Use at least ${MIN_PASSWORD} characters`);
	const r = await resetFor(db, token);
	if (!r) throw badRequest('This link has expired or was already used. Ask for a new one.');
	const { changes } = await db.run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', [new Date().toISOString(), r.id]);
	if (!changes) throw badRequest('This link was already used');
	await updateUser(db, r.user_id, { passwordHash: hashPassword(password) });
	await deleteUserSessions(db, r.user_id);
	for (const m of await membershipsOf(db, r.user_id)) await record(db, { orgId: m.orgId, actorId: r.user_id, action: 'auth.password_reset', subject: r.email, summary: `${r.email} set a new password from a reset link` });
	return { userId: r.user_id };
}

/** Command-line break-glass: sets a password directly (generated when none is given). */
export async function cliReset(db: Db, email: string, password?: string): Promise<{ email: string; password: string }> {
	const user = await userByEmail(db, normEmail(email));
	if (!user) throw notFound(`No account for ${email}`);
	const pw = password ?? randomToken(18);
	if (pw.length < MIN_PASSWORD) throw badRequest(`Use at least ${MIN_PASSWORD} characters`);
	await updateUser(db, user.id, { passwordHash: hashPassword(pw) });
	await deleteUserSessions(db, user.id);
	await db.run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [new Date().toISOString(), user.id]);
	for (const m of await membershipsOf(db, user.id))
		await record(db, { orgId: m.orgId, actorId: null, action: 'auth.password_reset', subject: user.email, summary: `${user.email}’s password was reset from the server command line` });
	return { email: user.email, password: pw };
}

