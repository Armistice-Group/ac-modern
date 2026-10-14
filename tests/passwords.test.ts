import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { config } from '../src/lib/server/config.ts';
import { addMember, createSession, createUser, sessionByToken, userByEmail } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { hashPassword, verifyPassword } from '../src/lib/server/crypto.ts';
import { outbox } from '../src/lib/server/notify.ts';
import { adminReset, cliReset, completeReset, requestReset, resetFor } from '../src/lib/server/passwords.ts';

process.env.ACM_SECRET_KEY = 'test-secret';
const tokenFrom = (text: string) => /reset-password\/([\w-]+)/.exec(text)![1];

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `own-${tag}@acme.test`, name: 'Owner', password: 'password123' });
	const mk = async (n: string, role: 'member' | 'admin' = 'member') => {
		const u = await createUser(db, { email: `${n}-${tag}@acme.test`, name: n, passwordHash: hashPassword('old-password') });
		await addMember(db, org.id, u.id, role);
		return u;
	};
	return { db, org, owner, mk, tag };
}

test('forgot password: link by email, single use, signs out everywhere; unknown emails look the same', async () => {
	const w = await world();
	const dev = await w.mk('dev');
	const session = await createSession(w.db, dev.id, w.org.id);
	const before = outbox.length;
	await requestReset(w.db, `nobody-${w.tag}@acme.test`, 'https://acm.test');
	assert.equal(outbox.length, before, 'no email for unknown addresses, and no error either');
	await requestReset(w.db, dev.email.toUpperCase(), 'https://acm.test');
	const mail = outbox.at(-1)!;
	assert.equal(mail.to, dev.email);
	const token = tokenFrom(mail.text);
	assert.equal((await resetFor(w.db, token))?.email, dev.email);
	await assert.rejects(completeReset(w.db, token, 'short'), /8 characters/);
	await completeReset(w.db, token, 'brand-new-pass');
	assert.ok(verifyPassword('brand-new-pass', (await userByEmail(w.db, dev.email))!.password_hash));
	assert.equal(await sessionByToken(w.db, session), undefined, 'old sessions signed out');
	await assert.rejects(completeReset(w.db, token, 'another-pass'), /expired or was already used/);

	// A newer link replaces the older one; expired links don't work.
	await requestReset(w.db, dev.email, 'https://acm.test');
	const first = tokenFrom(outbox.at(-1)!.text);
	await requestReset(w.db, dev.email, 'https://acm.test');
	assert.equal(await resetFor(w.db, first), undefined);
	const second = tokenFrom(outbox.at(-1)!.text);
	await w.db.run("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL");
	assert.equal(await resetFor(w.db, second), undefined);
});

test('admin-sent links: owners only for owners, never yourself, never cross-org in the cloud', async () => {
	const w = await world();
	const admin = await w.mk('ada', 'admin');
	const dev = await w.mk('dev');
	const A = (u: { id: string }, role: 'owner' | 'admin') => ({ orgId: w.org.id, userId: u.id, role });
	const r = await adminReset(w.db, A(admin, 'admin'), dev.id, 'https://acm.test');
	assert.equal(r.emailed, false);
	assert.match(r.link!, /reset-password\//, 'no SMTP: the admin gets the link to pass on');
	await assert.rejects(adminReset(w.db, A(admin, 'admin'), w.owner.id, 'https://acm.test'), /Only owners/);
	await assert.rejects(adminReset(w.db, A(admin, 'admin'), admin.id, 'https://acm.test'), /own password/);
	await adminReset(w.db, A(w.owner, 'owner'), admin.id, 'https://acm.test');

	// In the cloud, someone who also belongs to another org can't be reset by this org's admin.
	const { org: other } = await setupOrg({ orgName: 'Other', email: `x-${w.tag}@other.test`, name: 'X', password: 'password123' });
	await addMember(w.db, other.id, dev.id, 'owner');
	const mode = config.mode;
	(config as { mode: string }).mode = 'cloud';
	try {
		await assert.rejects(adminReset(w.db, A(admin, 'admin'), dev.id, 'https://acm.test'), /another organisation/);
	} finally {
		(config as { mode: string }).mode = mode;
	}
});

test('command line: sets or generates a password and signs out', async () => {
	const w = await world();
	const session = await createSession(w.db, w.owner.id, w.org.id);
	const r = await cliReset(w.db, w.owner.email);
	assert.ok(r.password.length >= 20);
	assert.ok(verifyPassword(r.password, (await userByEmail(w.db, w.owner.email))!.password_hash));
	assert.equal(await sessionByToken(w.db, session), undefined);
	await cliReset(w.db, w.owner.email, 'chosen-password');
	assert.ok(verifyPassword('chosen-password', (await userByEmail(w.db, w.owner.email))!.password_hash));
	await assert.rejects(cliReset(w.db, `ghost-${w.tag}@acme.test`), /No account/);
});
