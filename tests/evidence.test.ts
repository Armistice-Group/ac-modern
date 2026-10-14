import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createUser, saveOrgSettings, updateMember } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { complete, createRequest, decide, effects, getRequest } from '../src/lib/server/requests.ts';
import { recordGrant, listGrants } from '../src/lib/server/grants.ts';
import { applyAccessChange } from '../src/lib/server/changes.ts';
import { evidenceRows, outOfProcess, ticket } from '../src/lib/server/evidence.ts';
import { record } from '../src/lib/server/events.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `o${Math.random()}@acme.test`, name: 'Olive Owner', password: 'password123' });
	const mk = async (name: string, role: 'member' | 'admin' = 'member') => {
		const u = await createUser(db, { email: `${name}${Math.random()}@acme.test`, name, passwordHash: null });
		await addMember(db, org.id, u.id, role);
		return u;
	};
	const manager = await mk('Mona');
	const sysOwner = await mk('Sid');
	const dev = await mk('Dev');
	const admin = await mk('Ada', 'admin');
	await updateMember(db, org.id, dev.id, { managerId: manager.id });
	const base = (o: Partial<ResourceInput>): ResourceInput => ({
		name: 'DB',
		description: '',
		category: 'data',
		url: '',
		color: 'green',
		ownerId: sysOwner.id,
		approval: 'none',
		fulfillment: 'manual',
		webhookUrl: '',
		maxDays: null,
		defaultDays: null,
		requestable: true,
		approverIds: [],
		fulfillerIds: [admin.id],
		roles: [
			{ name: 'Read', description: '', privileged: false },
			{ name: 'Admin', description: '', privileged: true }
		],
		...o
	});
	const res = async (o: Partial<ResourceInput>) => {
		const id = await saveResource(db, org.id, null, base(o));
		const roles = await db.all<{ id: string; name: string }>('SELECT id, name FROM resource_roles WHERE resource_id = ? ORDER BY position', [id]);
		return { id, read: roles[0].id, admin: roles[1].id };
	};
	const A = (u: { id: string }, isAdmin = false) => ({ orgId: org.id, userId: u.id, admin: isAdmin });
	return { db, org, owner, manager, sysOwner, dev, admin, res, A };
}

test('privileged levels always need the system owner; approvals record capacity', async () => {
	const w = await world();
	const r = await w.res({ approval: 'none' });
	// Standard level: pre-approved by policy.
	const easy = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r.id, roleId: r.read, justification: '', durationDays: null }, effects());
	assert.equal(easy.status, 'pending_fulfillment');
	assert.equal(easy.policy, 'none');
	// Privileged level on the same resource: elevated to an approver step, justification required.
	await assert.rejects(createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r.id, roleId: r.admin, justification: '', durationDays: null }, effects()), /why/);
	const priv = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r.id, roleId: r.admin, justification: 'migration', durationDays: 1 }, effects());
	assert.equal(priv.status, 'pending_approval');
	assert.equal(priv.policy, 'approvers');
	assert.equal(priv.privileged, true);
	// Admins can't approve on someone's behalf unless the org allows overrides.
	await assert.rejects(decide(w.db, w.A(w.admin, true), priv.id, 'approved', '', effects()), /not an approver/);
	await decide(w.db, w.A(w.sysOwner), priv.id, 'approved', 'ok for 1 day', effects());
	const [row] = (await evidenceRows(w.db, w.org.id, { from: '2000-01-01', to: '2100-01-01' })).filter((x) => x.request.id === priv.id);
	assert.equal(row.approvals[0].capacity, 'system_owner');
	assert.equal(row.approvals[0].approver.name, 'Sid');
	assert.deepEqual(row.flags, []);

	// With overrides allowed, an admin can, and it's flagged.
	await saveOrgSettings(w.db, w.org.id, { allowAdminOverride: true });
	const r2 = await w.res({ name: 'Repo', approval: 'manager' });
	const q = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r2.id, roleId: r2.read, justification: 'code', durationDays: null }, effects());
	await decide(w.db, w.A(w.admin, true), q.id, 'approved', '', effects());
	const flagged = (await evidenceRows(w.db, w.org.id, { from: '2000-01-01', to: '2100-01-01', exceptions: true })).map((x) => x.request.id);
	assert.deepEqual(flagged, [q.id]);
});

test('manager-then-owner records both capacities; one person covering both steps records both', async () => {
	const w = await world();
	const r = await w.res({ approval: 'manager_then_approvers', approverIds: [w.manager.id] });
	const q = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r.id, roleId: r.read, justification: 'need it', durationDays: null }, effects());
	await decide(w.db, w.A(w.manager), q.id, 'approved', '', effects());
	assert.equal((await getRequest(w.db, w.org.id, { id: q.id })).status, 'pending_fulfillment');
	const t = await ticket(w.db, w.org.id, q.number);
	assert.deepEqual(t.approvals.map((a) => [a.step, a.capacity]), [[1, 'manager'], [2, 'approver']]);
	// Setup after approval, by someone else.
	await complete(w.db, w.A(w.admin, true), q.id, 'done', effects());
	const done = await ticket(w.db, w.org.id, q.number);
	assert.ok(done.fulfilledAt! >= done.approvedAt!);
	assert.equal(done.fulfilledBy?.name, 'Ada');
	// The fingerprint changes when the record does.
	await record(w.db, { orgId: w.org.id, actorId: w.owner.id, action: 'request.comment', requestId: q.id, summary: 'late note' });
	assert.notEqual((await ticket(w.db, w.org.id, q.number)).fingerprint, done.fingerprint);
});

test('categories: new hire, permission change, extension; snapshot survives renames', async () => {
	const w = await world();
	const r = await w.res({ approval: 'manager', maxDays: 30 });
	const first = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r.id, roleId: r.read, justification: 'start', durationDays: 30 }, effects());
	assert.equal(first.category, 'new_hire', 'joined today');
	await w.db.run("UPDATE members SET joined_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?", [w.dev.id]);
	await decide(w.db, w.A(w.manager), first.id, 'approved', '', effects());
	await complete(w.db, w.A(w.admin, true), first.id, '', effects());
	const ext = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r.id, roleId: r.read, justification: 'more time', durationDays: 30 }, effects());
	assert.equal(ext.category, 'extension');
	const up = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: r.id, roleId: r.admin, justification: 'need admin', durationDays: 7 }, effects());
	assert.equal(up.category, 'change');
	assert.equal(up.policy, 'manager_then_approvers', 'privileged adds an owner step to manager approval');

	await w.db.run("UPDATE resource_roles SET name = 'Renamed' WHERE id = ?", [r.admin]);
	await w.db.run("UPDATE users SET name = 'Someone else' WHERE id = ?", [w.dev.id]);
	const t = await ticket(w.db, w.org.id, up.number);
	assert.equal(t.snapshot.role?.name, 'Admin');
	assert.equal(t.snapshot.user?.name, 'Dev');
	assert.equal(t.snapshot.manager?.name, 'Mona');
});

test('onboarding and transfers create grouped requests; recorded access needs a reason', async () => {
	const w = await world();
	const a = await w.res({ name: 'A', approval: 'manager' });
	const b = await w.res({ name: 'B', approval: 'approvers', approverIds: [w.sysOwner.id] });
	// Their manager can onboard them; a random member can't.
	await assert.rejects(applyAccessChange(w.db, w.A(w.sysOwner), { userId: w.dev.id, kind: 'onboarding', reason: 'New engineer', add: [{ resourceId: a.id, roleId: a.read, durationDays: null }], remove: [] }, effects()), /manager/);
	const on = await applyAccessChange(
		w.db,
		w.A(w.manager),
		{ userId: w.dev.id, kind: 'onboarding', reason: 'New backend engineer', add: [{ resourceId: a.id, roleId: a.read, durationDays: null }, { resourceId: b.id, roleId: b.read, durationDays: null }], remove: [] },
		effects()
	);
	assert.equal(on.created.length, 2);
	const rows = await evidenceRows(w.db, w.org.id, { from: '2000-01-01', to: '2100-01-01', categories: ['new_hire'] });
	assert.equal(rows.length, 2);
	assert.ok(rows.every((r) => r.request.batchId === on.batchId && r.request.justification === 'New backend engineer'));

	await assert.rejects(recordGrant(w.db, w.A(w.owner, true), { userId: w.dev.id, resourceId: b.id, roleId: b.admin, expiresAt: null, note: '', source: 'import' }), /came from/);
	const g = await recordGrant(w.db, w.A(w.owner, true), { userId: w.dev.id, resourceId: b.id, roleId: b.admin, expiresAt: null, note: 'Pre-existing', source: 'import' });
	const tr = await applyAccessChange(
		w.db,
		w.A(w.owner, true),
		{ userId: w.dev.id, kind: 'transfer', reason: 'Moving to support', add: [], remove: [g], title: 'Support engineer', managerId: w.sysOwner.id },
		effects()
	);
	assert.equal(tr.created.length, 1);
	assert.equal((await listGrants(w.db, w.org.id, { userId: w.dev.id }))[0].status, 'pending_revoke');
	const removal = (await evidenceRows(w.db, w.org.id, { from: '2000-01-01', to: '2100-01-01', categories: ['removal'] }))[0];
	assert.equal(removal.request.reason, 'transfer');
	const oop = await outOfProcess(w.db, w.org.id, '2000-01-01', '2100-01-01');
	assert.equal(oop.recorded.length, 1);
});
