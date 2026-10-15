import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createSession, createUser, orgSettings, saveOrgSettings, sessionByToken, sessionWithinLimits } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { getResource, saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { complete, effects } from '../src/lib/server/requests.ts';
import { listGrants, offboard, recordGrant } from '../src/lib/server/grants.ts';
import { listEvents } from '../src/lib/server/events.ts';
import { escalateRemovals, leavers, leaversCsv } from '../src/lib/server/leavers.ts';
import { cancelChange, changeOrPropose, decideChange, listChanges } from '../src/lib/server/control-changes.ts';
import { listRules } from '../src/lib/server/rules.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `own-${tag}@acme.test`, name: 'Olive', password: 'password123' });
	const mk = async (n: string, role: 'member' | 'admin' = 'member') => {
		const u = await createUser(db, { email: `${n}-${tag}@acme.test`, name: n, passwordHash: null });
		await addMember(db, org.id, u.id, role);
		return u;
	};
	const admin2 = await mk('Ada', 'admin');
	const dev = await mk('Dev');
	const base: ResourceInput = {
		name: 'AWS', description: '', category: 'infra', url: '', color: 'amber', ownerId: owner.id, approval: 'approvers', fulfillment: 'manual', webhookUrl: '',
		maxDays: null, defaultDays: null, requestable: true, approverIds: [owner.id], fulfillerIds: [admin2.id],
		roles: [{ name: 'ReadOnly', description: '', privileged: false }, { name: 'Admin', description: '', privileged: true }]
	};
	const aws = await saveResource(db, org.id, null, base);
	const roles = await db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [aws]);
	const A = (u: { id: string }, admin = false) => ({ orgId: org.id, userId: u.id, admin });
	return { db, org, owner, admin2, dev, aws, roles, base, A, mk };
}

test('leavers: time from last day to removal, against the target; overdue removals escalate daily', async () => {
	const w = await world();
	await saveOrgSettings(w.db, w.org.id, { removalSlaHours: 24 });
	await recordGrant(w.db, w.A(w.owner, true), { userId: w.dev.id, resourceId: w.aws, roleId: w.roles[0].id, expiresAt: null, note: 'baseline', source: 'import' });
	await recordGrant(w.db, w.A(w.owner, true), { userId: w.dev.id, resourceId: w.aws, roleId: w.roles[1].id, expiresAt: null, note: 'baseline', source: 'import' });
	const lastDay = new Date(Date.now() - 2 * 3_600_000).toISOString();
	assert.equal(await offboard(w.db, w.A(w.owner, true), w.dev.id, 'resigned', effects(), 'offboarding', lastDay), 2);

	const range = ['2000-01-01', '2999-01-01'] as const;
	let r = await leavers(w.db, w.org.id, ...range);
	assert.equal(r.rows.length, 1);
	assert.deepEqual([r.rows[0].removals, r.rows[0].removed, r.rows[0].pending, r.rows[0].onTime], [2, 0, 2, null], 'in progress, not late yet');
	assert.equal(r.rows[0].leftAt, lastDay);

	// Two days later the removals are past the target: escalated once, then again a day later.
	const later = new Date(Date.now() + 48 * 3_600_000).toISOString();
	const fx = effects();
	assert.equal(await escalateRemovals(w.db, w.org.id, fx, later), 2);
	assert.ok(fx.notices.some((n) => n.to.includes(w.admin2.id) && /2 access removals past 24 hours/.test(n.subject)));
	assert.equal(await escalateRemovals(w.db, w.org.id, effects(), new Date(Date.parse(later) + 3_600_000).toISOString()), 0, 'not again within a day');
	assert.equal(await escalateRemovals(w.db, w.org.id, effects(), new Date(Date.parse(later) + 25 * 3_600_000).toISOString()), 2);
	assert.ok((await listEvents(w.db, w.org.id)).some((e) => e.action === 'request.overdue'));
	r = await leavers(w.db, w.org.id, ...range, later);
	assert.equal(r.rows[0].onTime, false);

	// Done now: within 24 hours of the last day.
	for (const q of await w.db.all<{ id: string }>("SELECT id FROM requests WHERE user_id = ? AND kind = 'revoke'", [w.dev.id])) await complete(w.db, w.A(w.admin2, true), q.id, 'removed', effects());
	r = await leavers(w.db, w.org.id, ...range);
	assert.deepEqual([r.rows[0].removed, r.rows[0].pending, r.rows[0].stillActive, r.rows[0].onTime], [2, 0, 0, true]);
	assert.match(leaversCsv(r.rows, r.slaHours), /"Dev","dev-[a-z0-9]+@acme.test","[^"]+","[^"]+","offboarded","Olive","2","2","0","[^"]+","2(\.\d)?","yes","0","0"/);

	// Deactivated in the IdP without offboarding: access still active is flagged.
	const left = await w.mk('Lou');
	await recordGrant(w.db, w.A(w.owner, true), { userId: left.id, resourceId: w.aws, roleId: w.roles[0].id, expiresAt: null, note: 'baseline import', source: 'import' });
	await w.db.run("UPDATE members SET status = 'deactivated' WHERE user_id = ?", [left.id]);
	await w.db.run("INSERT INTO events (id, org_id, at, actor_id, action, subject, summary, data) VALUES ('e-lou', ?, ?, NULL, 'member.deactivated', ?, 'Lou deactivated by the directory', ?)", [
		w.org.id,
		new Date(Date.now() - 30 * 3_600_000).toISOString(),
		left.email,
		JSON.stringify({ userId: left.id })
	]);
	const lou = (await leavers(w.db, w.org.id, ...range)).rows.find((x) => x.userId === left.id)!;
	assert.deepEqual([lou.how, lou.stillActive, lou.onTime, lou.by], ['deactivated', 1, false, 'Identity provider']);
});

test('second admin: control changes wait for a different admin; tightening and unrelated edits don’t', async () => {
	const w = await world();
	await saveOrgSettings(w.db, w.org.id, { requireSecondAdmin: true });
	const fx = effects();
	const rule = { name: 'Everyone, ReadOnly', enabled: true, resourceIds: [w.aws], roleIds: [], groupIds: [], userIds: [], maxDays: null };
	const r = await changeOrPropose(w.db, w.org.id, w.owner.id, { kind: 'rule', action: 'create', targetId: null, payload: rule, summary: 'Add rule' }, fx);
	assert.equal(r.applied, false);
	assert.equal((await listRules(w.db, w.org.id)).length, 0, 'not applied yet');
	assert.ok(fx.notices.some((n) => n.to.includes(w.admin2.id) && !n.to.includes(w.owner.id)));
	const change = (r as { change: { id: string } }).change;
	await assert.rejects(decideChange(w.db, w.org.id, w.owner.id, change.id, 'approved', '', effects()), /Another admin/);
	await decideChange(w.db, w.org.id, w.admin2.id, change.id, 'approved', '', effects());
	const rules = await listRules(w.db, w.org.id);
	assert.equal(rules.length, 1);
	const events = await listEvents(w.db, w.org.id);
	assert.ok(events.some((e) => e.action === 'rule.created' && e.actor?.id === w.owner.id), 'applied as the person who asked');
	assert.ok(events.some((e) => e.action === 'change.approved' && e.actor?.id === w.admin2.id));

	// Changing who approves a system waits; rejecting needs a reason.
	const before = await getResource(w.db, w.org.id, w.aws);
	const p = await changeOrPropose(w.db, w.org.id, w.admin2.id, { kind: 'resource', action: 'update', targetId: w.aws, payload: { ...w.base, approval: 'none' }, summary: 'AWS: no approval' }, effects());
	assert.equal(p.applied, false);
	const pid = (p as { change: { id: string } }).change.id;
	await assert.rejects(decideChange(w.db, w.org.id, w.owner.id, pid, 'rejected', '', effects()), /Say why/);
	await decideChange(w.db, w.org.id, w.owner.id, pid, 'rejected', 'AWS needs an approver', effects());
	assert.equal((await getResource(w.db, w.org.id, w.aws)).approval, before.approval);

	// Withdrawn by whoever asked; ungated changes apply at once.
	const q = await changeOrPropose(w.db, w.org.id, w.owner.id, { kind: 'settings', action: 'update', targetId: null, payload: { allowAdminOverride: true }, summary: 'override' }, effects());
	const qid = (q as { change: { id: string } }).change.id;
	await assert.rejects(cancelChange(w.db, w.org.id, w.admin2.id, qid), /whoever asked/);
	await cancelChange(w.db, w.org.id, w.owner.id, qid);
	assert.equal((await orgSettings(w.db, w.org.id)).allowAdminOverride, undefined);
	assert.deepEqual((await listChanges(w.db, w.org.id)).map((c) => c.status).sort(), ['approved', 'cancelled', 'rejected']);
	const direct = await changeOrPropose(w.db, w.org.id, w.owner.id, { kind: 'rule', action: 'delete', targetId: rules[0].id, payload: null, summary: 'delete' }, effects(), false);
	assert.equal(direct.applied, true);

	// With one admin there's nobody to approve.
	await w.db.run("UPDATE members SET role = 'member' WHERE user_id = ?", [w.admin2.id]);
	await assert.rejects(changeOrPropose(w.db, w.org.id, w.owner.id, { kind: 'settings', action: 'update', targetId: null, payload: { allowAdminOverride: true }, summary: 'x' }, effects()), /only one/);
});

test('sessions end after the org’s lifetime or idle timeout', async () => {
	const w = await world();
	const token = await createSession(w.db, w.dev.id, w.org.id);
	const s = (await sessionByToken(w.db, token))!;
	const t0 = Date.parse(s.created_at);
	assert.equal(await sessionWithinLimits(w.db, s, {}, t0 + 29 * 86_400_000), true, 'default 30 days');
	assert.equal(await sessionWithinLimits(w.db, s, { sessionMaxHours: 12 }, t0 + 13 * 3_600_000), false);
	assert.equal(await sessionWithinLimits(w.db, s, { sessionIdleMinutes: 30 }, t0 + 20 * 60_000), true);
	const seen = (await sessionByToken(w.db, token))!;
	assert.equal(seen.last_seen_at, new Date(t0 + 20 * 60_000).toISOString(), 'activity is recorded');
	assert.equal(await sessionWithinLimits(w.db, seen, { sessionIdleMinutes: 30 }, t0 + 45 * 60_000), true, '25 minutes since last seen');
	assert.equal(await sessionWithinLimits(w.db, (await sessionByToken(w.db, token))!, { sessionIdleMinutes: 30 }, t0 + 120 * 60_000), false);
});

test('access as of a date includes access removed since, and not access granted later', async () => {
	const w = await world();
	const g = await recordGrant(w.db, w.A(w.owner, true), { userId: w.dev.id, resourceId: w.aws, roleId: w.roles[0].id, expiresAt: null, note: 'baseline import', source: 'import' });
	await w.db.run("UPDATE grants SET granted_at = '2026-01-10T00:00:00.000Z', status = 'revoked', revoked_at = '2026-03-05T00:00:00.000Z' WHERE id = ?", [g]);
	const g2 = await recordGrant(w.db, w.A(w.owner, true), { userId: w.dev.id, resourceId: w.aws, roleId: w.roles[1].id, expiresAt: null, note: 'baseline import', source: 'import' });
	await w.db.run("UPDATE grants SET granted_at = '2026-04-01T00:00:00.000Z' WHERE id = ?", [g2]);
	const at = (d: string) => listGrants(w.db, w.org.id, { asOf: d }).then((x) => x.map((y) => y.role.name).sort());
	assert.deepEqual(await at('2026-02-01T00:00:00.000Z'), ['ReadOnly']);
	assert.deepEqual(await at('2026-03-20T00:00:00.000Z'), []);
	assert.deepEqual(await at('2026-05-01T00:00:00.000Z'), ['Admin']);
});
