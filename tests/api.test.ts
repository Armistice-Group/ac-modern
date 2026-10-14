import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { authenticateToken, createToken, revokeToken } from '../src/lib/server/apitokens.ts';
import { handleV1 } from '../src/lib/server/api-v1.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

test('API tokens: scoped to their org, revocable, expiring; lists paginate', async () => {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user, org } = await setupOrg({ orgName: 'Acme', email: `o-${tag}@acme.test`, name: 'O', password: 'password123' });
	const { token, id } = await createToken(db, org.id, 'Vanta', user.id, 30);
	assert.deepEqual((await authenticateToken(db, `Bearer ${token}`))?.orgId, org.id);
	assert.equal(await authenticateToken(db, 'Bearer acm_wrong'), null);
	assert.equal(await authenticateToken(db, null), null);
	await db.run("UPDATE api_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [id]);
	assert.equal(await authenticateToken(db, `Bearer ${token}`), null, 'expired');
	const second = await createToken(db, org.id, 'Drata', user.id, null);
	assert.ok(await revokeToken(db, org.id, second.id));
	assert.equal(await authenticateToken(db, `Bearer ${second.token}`), null, 'revoked');

	for (let i = 0; i < 5; i++) await db.run("INSERT INTO events (id, org_id, at, action, summary) VALUES (?, ?, ?, 'test.event', ?)", [`e${tag}${i}`, org.id, `2026-0${i + 1}-01T00:00:00.000Z`, `event ${i}`]);
	const p1 = (await handleV1(db, org.id, ['events'], new URLSearchParams('limit=2&action=test'))).body as { data: { summary: string }[]; next_cursor: string };
	assert.deepEqual(p1.data.map((e) => e.summary), ['event 4', 'event 3']);
	const p3 = (await handleV1(db, org.id, ['events'], new URLSearchParams(`limit=2&action=test&cursor=${Buffer.from('4').toString('base64url')}`))).body as { data: unknown[]; next_cursor: string | null };
	assert.equal(p3.data.length, 1);
	assert.equal(p3.next_cursor, null);
	const ranged = (await handleV1(db, org.id, ['events'], new URLSearchParams('from=2026-02-01&to=2026-03-01&action=test'))).body as { data: unknown[] };
	assert.equal(ranged.data.length, 2, 'to= a date includes that day');
	assert.equal((await handleV1(db, org.id, ['nope'], new URLSearchParams())).status, 404);
});
