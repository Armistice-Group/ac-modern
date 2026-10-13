import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, setDb, type Db } from '../src/lib/server/db.ts';
import { addMember, createUser, updateMember } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { complete, createRequest, decide, effects, getRequest, runWebhook, cancel } from '../src/lib/server/requests.ts';
import { listGrants, offboard, recordGrant, sweepExpiry } from '../src/lib/server/grants.ts';
import { createReview, decideItem, reviewItems } from '../src/lib/server/reviews.ts';
import { listEvents } from '../src/lib/server/events.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

async function world(url = process.env.TEST_DATABASE_URL || ':memory:') {
	const db = await openDb(url);
	setDb(db);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `owner${Math.random()}@acme.test`, name: 'Olive Owner', password: 'password123' });
	const mk = async (name: string) => {
		const u = await createUser(db, { email: `${name.toLowerCase()}${Math.random()}@acme.test`, name, passwordHash: null });
		await addMember(db, org.id, u.id, 'member');
		return u;
	};
	const manager = await mk('Mona');
	const dev = await mk('Dev');
	const it = await mk('Ivan');
	await updateMember(db, org.id, dev.id, { managerId: manager.id });
	const base: ResourceInput = {
		name: 'GitHub',
		description: '',
		category: 'app',
		url: '',
		color: 'violet',
		ownerId: owner.id,
		approval: 'manager_then_approvers',
		fulfillment: 'manual',
		webhookUrl: '',
		maxDays: null,
		defaultDays: null,
		requestable: true,
		approverIds: [owner.id],
		fulfillerIds: [it.id],
		roles: [{ name: 'Member', description: '' }, { name: 'Admin', description: '' }]
	};
	const resId = await saveResource(db, org.id, null, base);
	const roles = await db.all<{ id: string; name: string }>('SELECT id, name FROM resource_roles WHERE resource_id = ? ORDER BY position', [resId]);
	const actor = (u: { id: string }, admin = false) => ({ orgId: org.id, userId: u.id, admin });
	return { db, org, owner, manager, dev, it, resId, roles, base, actor };
}

test('request → manager → approver → fulfil → grant', async () => {
	const w = await world();
	const fx = effects();
	const req = await createRequest(w.db, w.actor(w.dev), { userId: w.dev.id, resourceId: w.resId, roleId: w.roles[0].id, justification: 'Need to push code', durationDays: 30 }, fx);
	assert.equal(req.status, 'pending_approval');
	assert.equal(req.number, 1);
	assert.ok(fx.notices.some((n) => n.to.includes(w.manager.id)), 'manager is asked first');

	await assert.rejects(decide(w.db, w.actor(w.dev), req.id, 'approved', '', effects()), /own access/);
	await assert.rejects(decide(w.db, w.actor(w.it), req.id, 'approved', '', effects()), /not an approver/);
	await decide(w.db, w.actor(w.manager), req.id, 'approved', '', effects());
	assert.equal((await getRequest(w.db, w.org.id, { id: req.id })).step, 2);
	await decide(w.db, w.actor(w.owner, true), req.id, 'approved', 'ok', effects());
	assert.equal((await getRequest(w.db, w.org.id, { id: req.id })).status, 'pending_fulfillment');

	await assert.rejects(complete(w.db, w.actor(w.dev), req.id, '', effects()), /not a fulfiller/);
	await complete(w.db, w.actor(w.it), req.id, 'invited to org', effects());
	const grants = await listGrants(w.db, w.org.id, { userId: w.dev.id });
	assert.equal(grants.length, 1);
	assert.ok(grants[0].expiresAt);

	// Duplicate open request is refused; access with an end date can be extended.
	const again = await createRequest(w.db, w.actor(w.dev), { userId: w.dev.id, resourceId: w.resId, roleId: w.roles[0].id, justification: 'More time', durationDays: 60 }, effects());
	await assert.rejects(
		createRequest(w.db, w.actor(w.dev), { userId: w.dev.id, resourceId: w.resId, roleId: w.roles[0].id, justification: 'More time', durationDays: 60 }, effects()),
		/already an open request/
	);
	await cancel(w.db, w.actor(w.dev), again.id, '');
	const events = await listEvents(w.db, w.org.id);
	assert.ok(events.some((e) => e.action === 'grant.created'));
});

test('deny needs a reason; one-person team can self-approve', async () => {
	const w = await world();
	const req = await createRequest(w.db, w.actor(w.dev), { userId: w.dev.id, resourceId: w.resId, roleId: w.roles[1].id, justification: 'admin pls', durationDays: null }, effects());
	await assert.rejects(decide(w.db, w.actor(w.manager), req.id, 'denied', '', effects()), /note/);
	await decide(w.db, w.actor(w.manager), req.id, 'denied', 'Use Member', effects());
	assert.equal((await getRequest(w.db, w.org.id, { id: req.id })).status, 'denied');

	// Owner requesting for themselves on an approvers-only resource with only themselves as approver.
	const solo = await saveResource(w.db, w.org.id, null, { ...w.base, name: 'AWS', approval: 'approvers', approverIds: [w.owner.id], fulfillerIds: [w.owner.id], ownerId: w.owner.id });
	const role = (await w.db.get<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ?', [solo]))!;
	// Other admins don't exist besides the owner, so the owner is the last resort.
	const r2 = await createRequest(w.db, w.actor(w.owner, true), { userId: w.owner.id, resourceId: solo, roleId: role.id, justification: 'break glass', durationDays: 1 }, effects());
	await decide(w.db, w.actor(w.owner, true), r2.id, 'approved', '', effects()).catch(() => {});
	// Admins can't approve their own as admin, but as last-resort approver they can.
	assert.equal((await getRequest(w.db, w.org.id, { id: r2.id })).status, 'pending_fulfillment');
});

test('expiry opens a removal; offboarding removes everything; reviews revoke', async () => {
	const w = await world();
	const g1 = await recordGrant(w.db, w.actor(w.owner, true), { userId: w.dev.id, resourceId: w.resId, roleId: w.roles[0].id, expiresAt: '2000-01-01', note: '', source: 'import' });
	const fx = effects();
	assert.equal(await sweepExpiry(w.db, w.org.id, 3, fx), 1);
	assert.equal((await listGrants(w.db, w.org.id, { userId: w.dev.id }))[0].status, 'pending_revoke');
	const revoke = (await w.db.get<{ id: string }>("SELECT id FROM requests WHERE grant_id = ? AND kind = 'revoke'", [g1]))!;
	await complete(w.db, w.actor(w.it), revoke.id, '', effects());
	assert.equal((await listGrants(w.db, w.org.id, { userId: w.dev.id })).length, 0);

	await recordGrant(w.db, w.actor(w.owner, true), { userId: w.dev.id, resourceId: w.resId, roleId: w.roles[1].id, expiresAt: null, note: '', source: 'import' });
	await recordGrant(w.db, w.actor(w.owner, true), { userId: w.manager.id, resourceId: w.resId, roleId: w.roles[0].id, expiresAt: null, note: '', source: 'import' });
	const reviewId = await createReview(w.db, w.actor(w.owner, true), { name: 'Q4', dueAt: null, resourceIds: [] }, effects());
	const items = await reviewItems(w.db, w.org.id, reviewId);
	assert.equal(items.length, 2);
	await assert.rejects(decideItem(w.db, w.actor(w.dev), items[0].id, 'keep', '', effects()), /assigned/);
	const devItem = items.find((i) => i.grant.user.id === w.dev.id)!;
	await decideItem(w.db, w.actor(w.owner, true), devItem.id, 'revoke', 'not needed', effects());
	assert.equal((await listGrants(w.db, w.org.id, { userId: w.dev.id }))[0].status, 'pending_revoke');

	const n = await offboard(w.db, w.actor(w.owner, true), w.manager.id, 'left', effects());
	assert.equal(n, 1);
	const status = await w.db.get<{ status: string }>('SELECT status FROM members WHERE user_id = ?', [w.manager.id]);
	assert.equal(status!.status, 'deactivated');
});

test('webhook fulfilment completes on 2xx and falls back to manual on failure', async () => {
	const w = await world();
	let calls = 0;
	let fail = false;
	const server = createServer((req, res) => {
		calls++;
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			assert.ok(req.headers['x-acm-signature']);
			assert.equal(JSON.parse(body).event, 'access.grant');
			res.writeHead(fail ? 500 : 200).end('{}');
		});
	});
	await new Promise<void>((r) => server.listen(0, r));
	const port = (server.address() as { port: number }).port;
	const id = await saveResource(w.db, w.org.id, null, { ...w.base, name: 'Hooked', approval: 'none', fulfillment: 'webhook', webhookUrl: `http://127.0.0.1:${port}/hook`, webhookSecret: 's3cret' });
	const role = (await w.db.get<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ?', [id]))!;
	const fx = effects();
	const req = await createRequest(w.db, w.actor(w.dev), { userId: w.dev.id, resourceId: id, roleId: role.id, justification: '', durationDays: null }, fx);
	assert.deepEqual(fx.webhooks, [req.id]);
	assert.equal(await runWebhook(w.db, w.org.id, req.id, 'http://x'), true);
	assert.equal((await getRequest(w.db, w.org.id, { id: req.id })).status, 'completed');

	fail = true;
	const role2 = (await w.db.get<{ id: string }>("SELECT id FROM resource_roles WHERE resource_id = ? AND name = 'Admin'", [id]))!;
	const req2 = await createRequest(w.db, w.actor(w.dev), { userId: w.dev.id, resourceId: id, roleId: role2.id, justification: '', durationDays: null }, effects());
	assert.equal(await runWebhook(w.db, w.org.id, req2.id, 'http://x'), false);
	assert.equal((await getRequest(w.db, w.org.id, { id: req2.id })).status, 'pending_fulfillment');
	assert.equal(calls, 2);
	server.close();
});

test('organisations can’t see or act on each other’s data', async () => {
	const a = await world();
	const req = await createRequest(a.db, a.actor(a.dev), { userId: a.dev.id, resourceId: a.resId, roleId: a.roles[0].id, justification: 'mine', durationDays: 1 }, effects());
	const { user: intruder, org: other } = await setupOrg({ orgName: 'Other', email: `x${Math.random()}@other.test`, name: 'X', password: 'password123' });
	const actor = { orgId: other.id, userId: intruder.id, admin: true };
	await assert.rejects(getRequest(a.db, other.id, { id: req.id }), /doesn’t exist/);
	await assert.rejects(decide(a.db, actor, req.id, 'approved', '', effects()), /doesn’t exist/);
	await assert.rejects(createRequest(a.db, actor, { userId: intruder.id, resourceId: a.resId, roleId: a.roles[0].id, justification: 'steal', durationDays: 1 }, effects()), /doesn’t exist/);
	assert.equal((await listGrants(a.db, other.id)).length, 0);
	assert.equal((await listEvents(a.db, other.id)).every((e) => e.action === 'org.created'), true);
});
