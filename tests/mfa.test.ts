import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { createSession, saveOrgSettings } from '../src/lib/server/accounts.ts';
import { authenticate, setupOrg } from '../src/lib/server/auth.ts';
import { listEvents } from '../src/lib/server/events.ts';
import { base32Decode, base32Encode, beginEnroll, confirmEnroll, disableMfa, hasMfa, hotp, matchTotp, mfaStatus, mfaTicket, readTicket, regenerateRecovery, resetMfa, stepAt, verifyMfa } from '../src/lib/server/mfa.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
	const secret = Buffer.from('12345678901234567890');
	const vectors: [number, string][] = [
		[59, '94287082'],
		[1111111109, '07081804'],
		[1111111111, '14050471'],
		[1234567890, '89005924'],
		[2000000000, '69279037'],
		[20000000000, '65353130']
	];
	for (const [t, code] of vectors) assert.equal(hotp(secret, stepAt(t * 1000), 8), code, `T=${t}`);
	assert.equal(base32Encode(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
	assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), secret);
	// One step of drift either way is fine; two isn't.
	const t = 1_700_000_000_000;
	assert.equal(matchTotp(secret, hotp(secret, stepAt(t) - 1), t), stepAt(t) - 1);
	assert.equal(matchTotp(secret, hotp(secret, stepAt(t) + 1), t), stepAt(t) + 1);
	assert.equal(matchTotp(secret, hotp(secret, stepAt(t) - 2), t), null);
	assert.equal(matchTotp(secret, 'abcdef', t), null);
});

test('enrol, sign in with a code, no replays, single-use recovery codes, required by the org', async () => {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const { user, org } = await setupOrg({ orgName: 'Acme', email: `mfa${Math.random()}@acme.test`, name: 'Mo', password: 'password123' });
	const codeAt = (secret: string, ms: number) => hotp(base32Decode(secret), stepAt(ms));
	let now = Date.now();

	const setup = await beginEnroll(db, user.id);
	assert.match(setup.uri, /^otpauth:\/\/totp\/.*secret=[A-Z2-7]{32}&issuer=/);
	assert.match(setup.svg, /^<svg/);
	assert.equal(await hasMfa(db, user.id), false, 'pending until confirmed');
	await assert.rejects(confirmEnroll(db, user.id, '000000', now), /didn’t match/);
	const recovery = await confirmEnroll(db, user.id, codeAt(setup.secret, now), now);
	assert.equal(recovery.length, 10);
	assert.equal((await mfaStatus(db, user.id)).enabled, true);
	assert.ok((await listEvents(db, org.id)).some((e) => e.action === 'mfa.enabled'));

	// Sign-in: the ticket carries the first step; a code finishes it.
	const ticket = mfaTicket(user.id, org.id, now);
	assert.deepEqual(readTicket(ticket, now), { userId: user.id, orgId: org.id });
	assert.throws(() => readTicket(ticket, now + 6 * 60_000), /too long/);
	assert.throws(() => readTicket('forged', now), /Sign in again/);
	now += 30_000;
	assert.equal(await verifyMfa(db, user.id, '123456', now), null, 'wrong code');
	const code = codeAt(setup.secret, now);
	assert.equal(await verifyMfa(db, user.id, code, now), 'totp');
	assert.equal(await verifyMfa(db, user.id, code, now), null, 'the same code can’t be used twice');
	assert.equal(await verifyMfa(db, user.id, codeAt(setup.secret, now - 30_000), now), null, 'nor an older one');

	assert.equal(await verifyMfa(db, user.id, recovery[0].toUpperCase(), now), 'recovery');
	assert.equal(await verifyMfa(db, user.id, recovery[0], now), null, 'recovery codes work once');
	assert.equal((await mfaStatus(db, user.id)).recoveryLeft, 9);
	assert.ok((await listEvents(db, org.id)).some((e) => e.action === 'mfa.recovery_used'));
	now += 30_000;
	const fresh = await regenerateRecovery(db, user.id, codeAt(setup.secret, now), now);
	assert.equal(await verifyMfa(db, user.id, recovery[1], now), null, 'old codes stop working');
	assert.notDeepEqual(fresh, recovery);

	// requireMfa: a password session without two-step verification has to set it up.
	await saveOrgSettings(db, org.id, { requireMfa: true });
	const locals = {} as App.Locals;
	const cookies = (token: string) => ({ get: () => token }) as never;
	await authenticate(cookies(await createSession(db, user.id, org.id, 'password+totp')), locals);
	assert.equal(locals.mfaSetupRequired, false);
	await assert.rejects(disableMfa(db, user.id, 'nope'), /didn’t match/);
	await resetMfa(db, org.id, user.id, user.id);
	assert.equal(await hasMfa(db, user.id), false);
	assert.ok((await listEvents(db, org.id)).some((e) => e.action === 'mfa.reset'));
	await authenticate(cookies(await createSession(db, user.id, org.id, 'password')), locals);
	assert.equal(locals.mfaSetupRequired, true, 'password session, no second factor');
	await authenticate(cookies(await createSession(db, user.id, org.id, 'sso')), locals);
	assert.equal(locals.mfaSetupRequired, false, 'SSO relies on the IdP');
	await saveOrgSettings(db, org.id, { requireMfa: false });
	await authenticate(cookies(await createSession(db, user.id, org.id, 'password')), locals);
	assert.equal(locals.mfaSetupRequired, false);
});
