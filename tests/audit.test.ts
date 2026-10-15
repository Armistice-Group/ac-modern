import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { newId } from '../src/lib/server/crypto.ts';
import { deliverStream, getStream, listAnchors, saveStream, sealDays, testStream, verifyAuditLog, verifyAndRecord } from '../src/lib/server/audit.ts';
import { listEvents } from '../src/lib/server/events.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user, org } = await setupOrg({ orgName: 'Acme', email: `own-${tag}@acme.test`, name: 'Olive', password: 'password123' });
	// Move the org's own creation event out of the way, then lay down a known history.
	await db.run("UPDATE events SET at = '2026-03-01T08:00:00.000Z' WHERE org_id = ?", [org.id]);
	const add = (at: string, summary: string, data: Record<string, unknown> = {}) =>
		db.run('INSERT INTO events (id, org_id, at, actor_id, action, request_id, subject, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
			newId(),
			org.id,
			at,
			user.id,
			'request.created',
			null,
			'GitHub',
			summary,
			JSON.stringify(data)
		]);
	await add('2026-03-01T09:00:00.000Z', 'Requested GitHub (Member)', { days: 30 });
	await add('2026-03-01T10:00:00.000Z', 'Approved GitHub (Member)');
	await add('2026-03-03T11:00:00.000Z', 'Removed GitHub (Member)', { reason: 'expired' });
	return { db, org, user, add };
}

test('daily seals: empty days included, chain verifies, tampering is found', async () => {
	const w = await world();
	assert.equal(await sealDays(w.db, w.org.id, '2026-03-04T06:00:00.000Z'), 3);
	assert.equal(await sealDays(w.db, w.org.id, '2026-03-04T07:00:00.000Z'), 0, 'already sealed');
	const anchors = await listAnchors(w.db, w.org.id);
	assert.deepEqual(anchors.map((a) => [a.day, a.count]), [['2026-03-01', 3], ['2026-03-02', 0], ['2026-03-03', 1]]);
	assert.equal(anchors[1].prevDigest, anchors[0].digest);

	let v = await verifyAuditLog(w.db, w.org.id);
	assert.equal(v.ok, true);
	assert.equal(v.days, 3);
	assert.equal(v.lastSealed, '2026-03-03');

	// Edit an old event: its day no longer matches.
	await w.db.run("UPDATE events SET summary = 'Approved GitHub (Owner)' WHERE org_id = ? AND summary = 'Approved GitHub (Member)'", [w.org.id]);
	v = await verifyAuditLog(w.db, w.org.id);
	assert.equal(v.ok, false);
	assert.deepEqual(v.broken.map((b) => b.day), ['2026-03-01']);
	assert.match(v.broken[0].reason, /changed after it was sealed/);
	await w.db.run("UPDATE events SET summary = 'Approved GitHub (Member)' WHERE org_id = ? AND summary = 'Approved GitHub (Owner)'", [w.org.id]);

	// Delete one, back-date one into a sealed day, and rewrite an anchor: all found.
	await w.db.run("DELETE FROM events WHERE org_id = ? AND summary LIKE 'Removed%'", [w.org.id]);
	await w.add('2026-03-02T12:00:00.000Z', 'Back-dated grant');
	await w.db.run("UPDATE audit_anchors SET digest = ? WHERE org_id = ? AND day = '2026-03-01'", ['f'.repeat(64), w.org.id]);
	v = await verifyAuditLog(w.db, w.org.id);
	assert.deepEqual(
		v.broken.map((b) => b.day),
		['2026-03-01', '2026-03-02', '2026-03-03']
	);
	assert.match(v.broken.find((b) => b.day === '2026-03-02')!.reason, /chain/);
	await w.add('2026-02-20T00:00:00.000Z', 'Before the first seal');
	assert.match((await verifyAuditLog(w.db, w.org.id)).broken[0].reason, /dated before the first sealed day/);

	const recorded = await verifyAndRecord(w.db, w.org.id, w.user.id);
	assert.equal(recorded.ok, false);
	assert.ok((await listEvents(w.db, w.org.id)).some((e) => e.action === 'audit.verified' && /failed/.test(e.summary)));
});

test('streaming: signed batches in order, retried after a failure, cursor advances', async () => {
	const w = await world();
	for (let i = 0; i < 150; i++) await w.add(`2026-03-05T00:00:${String(Math.floor(i / 10)).padStart(2, '0')}.${String(i % 10).padStart(3, '0')}Z`, `Event ${i}`);
	const received: { summary: string }[] = [];
	let failNext = 1;
	let secret = '';
	let tests = 0;
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const ts = String(req.headers['x-acm-timestamp']);
			const want = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
			if (req.headers['x-acm-signature'] !== want) return res.writeHead(401).end('bad signature');
			const payload = JSON.parse(body);
			if (payload.test) return tests++, res.writeHead(204).end();
			if (failNext-- > 0) return res.writeHead(500).end('down for maintenance');
			received.push(...payload.events);
			res.writeHead(200).end('{}');
		});
	});
	await new Promise<void>((r) => server.listen(0, r));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ingest`;
	try {
		secret = (await saveStream(w.db, w.org.id, url)).secret!;
		assert.match(secret, /^acm_whsec_/);
		await testStream(w.db, w.org.id);
		assert.equal(tests, 1);

		assert.equal(await deliverStream(w.db, w.org.id), 0, 'first batch refused');
		let s = (await getStream(w.db, w.org.id))!;
		assert.match(s.lastError, /500 down for maintenance/);
		assert.equal(s.behind, 154);

		assert.equal(await deliverStream(w.db, w.org.id), 154);
		s = (await getStream(w.db, w.org.id))!;
		assert.equal(s.lastError, '');
		assert.equal(s.behind, 0);
		assert.ok(s.lastDeliveredAt);
		assert.equal(received.length, 154, 'nothing lost or repeated');
		const nums = received.filter((e) => e.summary.startsWith('Event ')).map((e) => Number(e.summary.slice(6)));
		assert.deepEqual(nums, [...Array(150).keys()], 'in order');

		await w.add('2026-03-06T00:00:00.000Z', 'Later');
		assert.equal(await deliverStream(w.db, w.org.id), 1);
		assert.equal(received.at(-1)!.summary, 'Later');

		// Keeping the URL keeps the secret; rotating changes it.
		assert.equal((await saveStream(w.db, w.org.id, url)).secret, null);
		const rotated = (await saveStream(w.db, w.org.id, url, true)).secret!;
		assert.notEqual(rotated, secret);
		await assert.rejects(testStream(w.db, w.org.id), /401/);
		secret = rotated;
		await testStream(w.db, w.org.id);
		await assert.rejects(saveStream(w.db, w.org.id, 'ftp://example.com'), /https/);
	} finally {
		server.close();
	}
});
