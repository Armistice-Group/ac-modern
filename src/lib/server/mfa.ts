import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, conflict, HttpError } from './http.ts';

/**
 * Two-step verification for password sign-in: TOTP (RFC 6238: HMAC-SHA1, 30-second steps,
 * 6 digits) with ten single-use recovery codes. SSO sign-ins skip it; the IdP does MFA.
 * Secrets are stored encrypted; recovery codes hashed. A code can't be used twice.
 */

const STEP = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(s: string): Buffer {
	const clean = s.toUpperCase().replace(/[\s=-]/g, '');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const i = B32.indexOf(ch);
		if (i < 0) throw new Error('Invalid base32');
		value = (value << 5) | i;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const h = createHmac('sha1', secret).update(msg).digest();
	const o = h[h.length - 1] & 15;
	const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
	return String(n % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP);

/** The step a code matches, allowing one step of clock drift either way, or null. */
export function matchTotp(secret: Buffer, code: string, ms = Date.now()): number | null {
	const c = code.replace(/\s/g, '');
	if (!/^\d{6}$/.test(c)) return null;
	const now = stepAt(ms);
	for (const s of [now, now - 1, now + 1]) {
		const want = Buffer.from(hotp(secret, s));
		if (timingSafeEqual(want, Buffer.from(c))) return s;
	}
	return null;
}

const ctx = (userId: string) => `user:${userId}:totp`;

export function otpauthUri(email: string, secret: string): string {
	const label = encodeURIComponent(`ac·modern:${email}`);
	return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('ac·modern')}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

export async function qrSvg(text: string): Promise<string> {
	const QR = await import('qrcode');
	return QR.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}

interface MfaRow {
	email: string;
	totp_secret: string | null;
	totp_pending: string | null;
	totp_enabled_at: string | null;
	totp_last_step: number;
	mfa_recovery: string;
}

const row = (db: Db, userId: string) =>
	db.get<MfaRow>('SELECT email, totp_secret, totp_pending, totp_enabled_at, totp_last_step, mfa_recovery FROM users WHERE id = ?', [userId]);

export async function mfaStatus(db: Db, userId: string): Promise<{ enabled: boolean; enabledAt: string | null; recoveryLeft: number; pending: boolean }> {
	const r = await row(db, userId);
	return {
		enabled: !!r?.totp_enabled_at,
		enabledAt: r?.totp_enabled_at ?? null,
		recoveryLeft: r ? (JSON.parse(r.mfa_recovery) as string[]).length : 0,
		pending: !!r?.totp_pending
	};
}

/** Records an event in every organisation the person belongs to. */
async function recordForUser(db: Db, userId: string, actorId: string | null, action: string, summary: string) {
	const orgs = await db.all<{ org_id: string }>('SELECT org_id FROM members WHERE user_id = ?', [userId]);
	const who = await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId]);
	for (const o of orgs) await record(db, { orgId: o.org_id, actorId, action, subject: who?.email ?? '', summary });
}

/** Starts setup: a new secret, kept pending until they prove they can read codes from it. */
export async function beginEnroll(db: Db, userId: string) {
	const r = await row(db, userId);
	if (!r) throw badRequest('Unknown user');
	if (r.totp_enabled_at) throw conflict('Two-step verification is already on');
	const secret = base32Encode(randomBytes(20));
	await db.run('UPDATE users SET totp_pending = ? WHERE id = ?', [encrypt(secret, ctx(userId)), userId]);
	const uri = otpauthUri(r.email, secret);
	return { secret, uri, svg: await qrSvg(uri) };
}

function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
	const codes = Array.from({ length: 10 }, () => {
		const t = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
		return `${t.slice(0, 5)}-${t.slice(5)}`;
	});
	return { codes, hashes: codes.map((c) => sha256(c)) };
}

/** Confirms setup with a code from the app; returns the recovery codes (shown once). */
export async function confirmEnroll(db: Db, userId: string, code: string, ms = Date.now()): Promise<string[]> {
	const r = await row(db, userId);
	if (!r?.totp_pending) throw badRequest('Start setting up two-step verification first');
	const secret = decrypt(r.totp_pending, ctx(userId));
	const step = matchTotp(base32Decode(secret), code, ms);
	if (step === null) throw badRequest('That code didn’t match. Check the time on your phone, and use the newest code.');
	const { codes, hashes } = newRecoveryCodes();
	await db.run('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ?, mfa_recovery = ? WHERE id = ?', [
		new Date(ms).toISOString(),
		step,
		JSON.stringify(hashes),
		userId
	]);
	await recordForUser(db, userId, userId, 'mfa.enabled', 'Turned on two-step verification');
	return codes;
}

/**
 * Checks a sign-in code: a TOTP code (each one works once) or a recovery code (used up).
 * Returns how it was verified, or null.
 */
export async function verifyMfa(db: Db, userId: string, code: string, ms = Date.now()): Promise<'totp' | 'recovery' | null> {
	const r = await row(db, userId);
	if (!r?.totp_secret || !r.totp_enabled_at) return null;
	const c = code.trim().toLowerCase();
	if (/^\d{3}\s?\d{3}$/.test(c)) {
		const step = matchTotp(base32Decode(decrypt(r.totp_secret, ctx(userId))), c, ms);
		if (step === null || step <= Number(r.totp_last_step)) return null;
		// Only if nobody used this step meanwhile.
		const { changes } = await db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', [step, userId, step]);
		return changes ? 'totp' : null;
	}
	const hashes = JSON.parse(r.mfa_recovery) as string[];
	const h = sha256(c.replace(/\s/g, ''));
	if (!hashes.includes(h)) return null;
	const left = hashes.filter((x) => x !== h);
	const { changes } = await db.run('UPDATE users SET mfa_recovery = ? WHERE id = ? AND mfa_recovery = ?', [JSON.stringify(left), userId, r.mfa_recovery]);
	if (!changes) return null;
	await recordForUser(db, userId, userId, 'mfa.recovery_used', `Signed in with a recovery code (${left.length} left)`);
	return 'recovery';
}

export async function regenerateRecovery(db: Db, userId: string, code: string, ms = Date.now()): Promise<string[]> {
	if (!(await verifyMfa(db, userId, code, ms))) throw badRequest('That code didn’t match');
	const { codes, hashes } = newRecoveryCodes();
	await db.run('UPDATE users SET mfa_recovery = ? WHERE id = ?', [JSON.stringify(hashes), userId]);
	await recordForUser(db, userId, userId, 'mfa.recovery_regenerated', 'Made new two-step recovery codes');
	return codes;
}

export async function disableMfa(db: Db, userId: string, code: string, ms = Date.now()) {
	if (!(await verifyMfa(db, userId, code, ms))) throw badRequest('That code didn’t match');
	await clear(db, userId);
	await recordForUser(db, userId, userId, 'mfa.disabled', 'Turned off two-step verification');
}

const clear = (db: Db, userId: string) =>
	db.run("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = 0, mfa_recovery = '[]' WHERE id = ?", [userId]);

/** An admin clears someone's two-step setup (lost phone and codes). They set it up again at next sign-in. */
export async function resetMfa(db: Db, orgId: string, actorId: string, userId: string) {
	const r = await row(db, userId);
	if (!r?.totp_enabled_at) throw conflict('They don’t have two-step verification on');
	await clear(db, userId);
	await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
	await record(db, { orgId, actorId, action: 'mfa.reset', subject: r.email, summary: `Reset two-step verification for ${r.email} (signed out everywhere)` });
}

// ── The second step of sign-in ───────────────────────────────────────────────

const TICKET_TTL_MS = 5 * 60_000;

/** After a correct password: proof of the first step, to trade for a session with a code. */
export function mfaTicket(userId: string, orgId: string | null, ms = Date.now()): string {
	return encrypt(JSON.stringify({ u: userId, o: orgId, x: ms + TICKET_TTL_MS, n: randomToken(8) }), 'mfa-ticket');
}

export function readTicket(ticket: string, ms = Date.now()): { userId: string; orgId: string | null } {
	let t: { u: string; o: string | null; x: number };
	try {
		t = JSON.parse(decrypt(ticket, 'mfa-ticket'));
	} catch {
		throw new HttpError(401, 'Sign in again');
	}
	if (t.x < ms) throw new HttpError(401, 'That took too long. Sign in again.');
	return { userId: t.u, orgId: t.o };
}

/** Logs a failed code in each of their organisations. */
export const recordMfaFailure = (db: Db, userId: string) => recordForUser(db, userId, userId, 'auth.mfa_failed', 'Wrong two-step code at sign-in');

/** Whether the person has two-step verification on. */
export async function hasMfa(db: Db, userId: string): Promise<boolean> {
	return !!(await db.get<{ totp_enabled_at: string | null }>('SELECT totp_enabled_at FROM users WHERE id = ? AND totp_enabled_at IS NOT NULL', [userId]));
}
