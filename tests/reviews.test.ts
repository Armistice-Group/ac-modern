import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createUser, updateMember } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { complete, effects } from '../src/lib/server/requests.ts';
import { recordGrant } from '../src/lib/server/grants.ts';
import { listEvents } from '../src/lib/server/events.ts';
import {
	advance,
	decideItem,
	getReview,
	listPolicies,
	listReviews,
	periodLabel,
	reassignItems,
	remindReviewers,
	reviewCsv,
	reviewItems,
	runReviewSchedule,
	savePolicy
} from '../src/lib/server/reviews.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `own-${tag}@acme.test`, name: 'Olive', password: 'password123' });
	const mk = async (n: string) => {
		const u = await createUser(db, { email: `${n}-${tag}@acme.test`, name: n, passwordHash: null });
		await addMember(db, org.id, u.id, 'member');
		return u;
	};
	const boss = await mk('Boss');
	const dev = await mk('Dev');
	const ops = await mk('Ops');
	await updateMember(db, org.id, dev.id, { managerId: boss.id });
	const base: ResourceInput = {
		name: 'AWS', description: '', category: 'infra', url: '', color: 'amber', ownerId: ops.id, approval: 'approvers', fulfillment: 'manual', webhookUrl: '',
		maxDays: null, defaultDays: null, requestable: true, approverIds: [ops.id], fulfillerIds: [owner.id],
		roles: [{ name: 'ReadOnly', description: '', privileged: false }, { name: 'Admin', description: '', privileged: true }]
	};
	const aws = await saveResource(db, org.id, null, base);
	const roles = await db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [aws]);
	const A = (u: { id: string }, admin = false) => ({ orgId: org.id, userId: u.id, admin });
	const grant = (u: { id: string }, role: number) => recordGrant(db, A(owner, true), { userId: u.id, resourceId: aws, roleId: roles[role].id, expiresAt: null, note: 'baseline', source: 'import' });
	return { db, org, owner, boss, dev, ops, aws, roles, A, grant };
}

test('schedule arithmetic: months keep their day, periods are named', () => {
	assert.equal(advance('2026-01-31T09:00:00.000Z', 'monthly'), '2026-02-28T09:00:00.000Z');
	assert.equal(advance('2026-11-15T09:00:00.000Z', 'quarterly'), '2027-02-15T09:00:00.000Z');
	assert.equal(advance('2026-03-01T09:00:00.000Z', 'annual'), '2027-03-01T09:00:00.000Z');
	assert.equal(periodLabel('2026-10-14T00:00:00Z', 'quarterly'), 'Q4 2026');
	assert.equal(periodLabel('2026-10-14T00:00:00Z', 'monthly'), 'October 2026');
	assert.equal(periodLabel('2026-10-14T00:00:00Z', 'semiannual'), 'H2 2026');
});

test('review policies start reviews on schedule, once, with the right scope and reviewers', async () => {
	const w = await world();
	await w.grant(w.dev, 0);
	await w.grant(w.dev, 1);
	await w.grant(w.ops, 1); // the owner's own admin access
	await savePolicy(w.db, w.org.id, w.owner.id, null, { name: 'Monthly privileged review', enabled: true, frequency: 'monthly', scope: 'privileged', resourceIds: [], reviewer: 'manager', dueDays: 7, nextRunAt: '2026-10-01T09:00:00.000Z' });
	await savePolicy(w.db, w.org.id, w.owner.id, null, { name: 'Quarterly review', enabled: true, frequency: 'quarterly', scope: 'all', resourceIds: [w.aws], reviewer: 'owner', dueDays: 14, nextRunAt: '2026-12-01T09:00:00.000Z' });

	const fx = effects();
	await runReviewSchedule(w.db, w.org.id, fx, '2026-10-14T10:00:00.000Z');
	await runReviewSchedule(w.db, w.org.id, effects(), '2026-10-14T10:05:00.000Z');
	const reviews = await listReviews(w.db, w.org.id);
	assert.deepEqual(reviews.map((r) => r.name), ['Monthly privileged review: October 2026'], 'only the due policy ran, and only once');
	const policies = await listPolicies(w.db, w.org.id);
	assert.equal(policies[0].nextRunAt, '2026-11-01T09:00:00.000Z');
	assert.equal(policies[0].lastRunAt, '2026-10-14T10:00:00.000Z');

	const r = reviews[0];
	assert.equal(r.dueAt, '2026-10-21T10:00:00.000Z');
	const items = await reviewItems(w.db, w.org.id, r.id);
	assert.equal(items.length, 2, 'privileged grants only');
	const devItem = items.find((i) => i.grant.user.id === w.dev.id)!;
	const opsItem = items.find((i) => i.grant.user.id === w.ops.id)!;
	assert.deepEqual([devItem.reviewerId, devItem.capacity], [w.boss.id, 'manager']);
	assert.notEqual(opsItem.reviewerId, w.ops.id, 'nobody reviews their own access');
	assert.equal(opsItem.capacity, 'admin');
	assert.ok(fx.notices.some((n) => n.to.includes(w.boss.id) && /Access review/.test(n.subject)));
	await assert.rejects(decideItem(w.db, w.A(w.ops), opsItem.id, 'keep', '', effects()), /assigned to someone else/);

	// Reminder before the due date, then weekly escalation to admins once it's late.
	let rx = effects();
	await remindReviewers(w.db, w.org.id, rx, '2026-10-17T00:00:00.000Z');
	assert.equal(rx.notices.length, 0, 'not yet');
	await remindReviewers(w.db, w.org.id, rx, '2026-10-19T00:00:00.000Z');
	assert.deepEqual(rx.notices.map((n) => n.to).flat().sort(), [w.boss.id, w.owner.id].sort());
	rx = effects();
	await remindReviewers(w.db, w.org.id, rx, '2026-10-20T00:00:00.000Z');
	assert.equal(rx.notices.length, 0, 'reminded once');
	await remindReviewers(w.db, w.org.id, rx, '2026-10-22T00:00:00.000Z');
	assert.ok(rx.notices.some((n) => /Overdue/.test(n.subject) && n.to.includes(w.owner.id) && /Boss: 1/.test(n.text)), JSON.stringify(rx.notices));
	rx = effects();
	await remindReviewers(w.db, w.org.id, rx, '2026-10-25T00:00:00.000Z');
	assert.equal(rx.notices.length, 0, 'weekly, not daily');
	assert.ok((await listEvents(w.db, w.org.id)).some((e) => e.action === 'review.overdue'));

	// Reassign the manager's item; revoke it; the removal is linked and counted when done.
	assert.equal(await reassignItems(w.db, w.A(w.owner, true), r.id, w.boss.id, w.ops.id, effects()), 1);
	await decideItem(w.db, w.A(w.ops), devItem.id, 'revoke', 'no longer on call', effects());
	let item = (await reviewItems(w.db, w.org.id, r.id)).find((i) => i.id === devItem.id)!;
	assert.equal(item.removal?.status, 'pending_fulfillment');
	const removal = (await w.db.get<{ id: string }>('SELECT id FROM requests WHERE number = ? AND org_id = ?', [item.removal!.number, w.org.id]))!;
	await complete(w.db, w.A(w.owner, true), removal.id, 'deleted IAM user', effects());
	item = (await reviewItems(w.db, w.org.id, r.id)).find((i) => i.id === devItem.id)!;
	assert.equal(item.removal?.status, 'completed');
	const after = await getReview(w.db, w.org.id, r.id);
	assert.deepEqual([after.revoked, after.removed], [1, 1]);
	const csv = reviewCsv(after, await reviewItems(w.db, w.org.id, r.id));
	assert.match(csv, /^"Monthly privileged review: October 2026","Monthly privileged review",/m);
	assert.match(csv, /"AWS","Admin","yes","Dev","dev-[a-z0-9]+@acme.test",[^\n]*"Ops","Admin","revoke","Ops","[^"]+","yes","no longer on call","#\d+","completed","20/);
	assert.match(csv, /"Ops","ops-[a-z0-9]+@acme.test",[^\n]*"Olive","Admin","undecided"/);
});

test('scheduled reviews with nothing in scope are skipped and logged', async () => {
	const w = await world();
	await savePolicy(w.db, w.org.id, w.owner.id, null, { name: 'Empty', enabled: true, frequency: 'monthly', scope: 'privileged', resourceIds: [], reviewer: 'owner', dueDays: 7, nextRunAt: '2026-01-01T00:00:00.000Z' });
	await runReviewSchedule(w.db, w.org.id, effects(), '2026-03-15T00:00:00.000Z');
	assert.equal((await listReviews(w.db, w.org.id)).length, 0);
	assert.equal((await listPolicies(w.db, w.org.id))[0].nextRunAt, '2026-04-01T00:00:00.000Z', 'missed periods don’t pile up');
	assert.ok((await listEvents(w.db, w.org.id)).some((e) => e.action === 'review.skipped'));
});
