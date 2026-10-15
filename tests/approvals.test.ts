import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createUser } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { createRequest, effects, flush, getRequest } from '../src/lib/server/requests.ts';
import { deleteRule, saveRule } from '../src/lib/server/rules.ts';
import { evidenceRows, outOfProcess } from '../src/lib/server/evidence.ts';
import { listEvents, requestTimeline } from '../src/lib/server/events.ts';
import { authenticatePersonal, authenticateToken, createPersonalToken } from '../src/lib/server/apitokens.ts';
import { handleMcp } from '../src/lib/server/mcp.ts';
import { connectSlack, setSlackFetch } from '../src/lib/server/slack.ts';
import { handleCommand, handleEvent, parseReply } from '../src/lib/server/slack-commands.ts';
import { handleInteraction } from '../src/lib/server/slack-interactions.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `own-${tag}@acme.test`, name: 'Owner', password: 'password123' });
	const mk = async (n: string) => {
		const u = await createUser(db, { email: `${n}-${tag}@acme.test`, name: n, passwordHash: null });
		await addMember(db, org.id, u.id, 'member');
		return u;
	};
	const approver = await mk('appr');
	const dev = await mk('dev');
	const sales = await mk('sales');
	const base: ResourceInput = {
		name: 'Grafana', description: 'Dashboards', category: 'app', url: '', color: 'violet', ownerId: owner.id, approval: 'approvers', fulfillment: 'manual', webhookUrl: '',
		maxDays: null, defaultDays: null, requestable: true, approverIds: [approver.id], fulfillerIds: [owner.id],
		roles: [{ name: 'Viewer', description: '', privileged: false }, { name: 'Admin', description: '', privileged: true }]
	};
	const resId = await saveResource(db, org.id, null, base);
	const roles = await db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [resId]);
	// A directory group "Engineering" with dev in it.
	const t = new Date().toISOString();
	await db.run('INSERT INTO directory_users (org_id, id, email, user_id, updated_at) VALUES (?, ?, ?, ?, ?)', [org.id, 'du-dev', dev.email, dev.id, t]);
	await db.run('INSERT INTO directory_groups (org_id, id, name, updated_at) VALUES (?, ?, ?, ?)', [org.id, 'g-eng', 'Engineering', t]);
	await db.run('INSERT INTO directory_memberships (org_id, group_id, user_id) VALUES (?, ?, ?)', [org.id, 'g-eng', 'du-dev']);
	const A = (u: { id: string }, admin = false) => ({ orgId: org.id, userId: u.id, admin });
	return { db, org, owner, approver, dev, sales, resId, roles, base, tag, A };
}

test('auto-approval rules: group and duration match, privileged never, all of it audited', async () => {
	const w = await world();
	const ruleId = await saveRule(w.db, w.org.id, w.owner.id, null, { name: 'Engineering dashboards', enabled: true, resourceIds: [w.resId], roleIds: [], groupIds: ['g-eng'], userIds: [], maxDays: 14 });
	const ask = (u: { id: string }, role: string, days: number | null) => createRequest(w.db, w.A(u), { userId: u.id, resourceId: w.resId, roleId: role, justification: 'Looking at latency', durationDays: days }, effects());

	const ok = await ask(w.dev, w.roles[0].id, 7);
	assert.equal(ok.status, 'pending_fulfillment', 'in the group, within 14 days');
	assert.deepEqual(ok.autoRule, { id: ruleId, name: 'Engineering dashboards', reason: 'in Engineering; 7 days (rule allows up to 14)' });
	const tl = await requestTimeline(w.db, w.org.id, ok.id);
	assert.ok(tl.some((e) => e.action === 'request.auto_approved' && /Engineering dashboards/.test(e.summary)));

	assert.equal((await ask(w.sales, w.roles[0].id, 7)).status, 'pending_approval', 'not in the group');
	assert.equal((await ask(w.dev, w.roles[1].id, 7)).status, 'pending_approval', 'privileged always needs a person');
	await assert.rejects(ask(w.dev, w.roles[0].id, 7), /already an open request/);

	const w2 = await world();
	await saveRule(w2.db, w2.org.id, w2.owner.id, null, { name: 'Short', enabled: true, resourceIds: [], roleIds: [], groupIds: [], userIds: [w2.sales.id], maxDays: 3 });
	const ask2 = (days: number | null) => createRequest(w2.db, w2.A(w2.sales), { userId: w2.sales.id, resourceId: w2.resId, roleId: w2.roles[0].id, justification: 'quick look', durationDays: days }, effects());
	const long = await ask2(30);
	assert.equal(long.status, 'pending_approval', 'longer than the rule allows');
	const forever = await ask2(null).catch((e) => e);
	assert.match(String(forever?.message), /already an open request/);

	// Evidence: flagged as auto-approved (not an exception); rule changes are control changes.
	const rows = await evidenceRows(w.db, w.org.id, { from: '2000-01-01', to: '2999-01-01' });
	const row = rows.find((r) => r.request.id === ok.id)!;
	assert.deepEqual(row.flags, ['auto_approved']);
	await saveRule(w.db, w.org.id, w.owner.id, ruleId, { name: 'Engineering dashboards', enabled: false, resourceIds: [w.resId], roleIds: [], groupIds: ['g-eng'], userIds: [], maxDays: 14 });
	await deleteRule(w.db, w.org.id, w.owner.id, ruleId);
	const changes = (await outOfProcess(w.db, w.org.id, '2000-01-01', '2999-01-01')).controlChanges.map((e) => e.summary);
	assert.ok(changes.some((s) => /Added auto-approval rule “Engineering dashboards”: Grafana \(any non-privileged level\) for people in Engineering, for up to 14 days/.test(s)), changes.join('\n'));
	assert.ok(changes.some((s) => /Turned off/.test(s)));
	assert.ok(changes.some((s) => /Deleted/.test(s)));

	await assert.rejects(saveRule(w.db, w.org.id, w.owner.id, null, { name: 'Bad', enabled: true, resourceIds: [], roleIds: [], groupIds: ['nope'], userIds: [], maxDays: null }), /group/);
});

test('MCP: personal tokens act as their member; approving needs the approve scope', async () => {
	const w = await world();
	const devTok = await createPersonalToken(w.db, w.org.id, w.dev.id, 'Claude Code', false, 30);
	const apprTok = await createPersonalToken(w.db, w.org.id, w.approver.id, 'Claude', true, null);
	const devAuth = (await authenticatePersonal(w.db, `Bearer ${devTok.token}`))!;
	const apprAuth = (await authenticatePersonal(w.db, `Bearer ${apprTok.token}`))!;
	assert.equal(devAuth.userId, w.dev.id);
	assert.equal(await authenticateToken(w.db, `Bearer ${devTok.token}`), null, 'a personal token can’t read the org API');

	let id = 0;
	const rpc = async (auth: typeof devAuth, method: string, params: Record<string, unknown> = {}) => (await handleMcp(w.db, auth, { jsonrpc: '2.0', id: ++id, method, params }, 'https://acm.test')) as any;
	const call = async (auth: typeof devAuth, name: string, args: Record<string, unknown> = {}) => {
		const r = await rpc(auth, 'tools/call', { name, arguments: args });
		return { text: r.result.content[0].text as string, isError: r.result.isError as boolean };
	};

	const init = await rpc(devAuth, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
	assert.equal(init.result.protocolVersion, '2025-06-18');
	assert.equal(await handleMcp(w.db, devAuth, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'x'), null);
	const devTools = (await rpc(devAuth, 'tools/list')).result.tools.map((t: { name: string }) => t.name);
	assert.ok(devTools.includes('request_access') && !devTools.includes('approve_request') && !devTools.includes('audit_log'));
	assert.ok((await rpc(apprAuth, 'tools/list')).result.tools.some((t: { name: string }) => t.name === 'approve_request'));

	assert.match((await call(devAuth, 'list_systems')).text, /Grafana.*\n.*\n  - Viewer\n  - Admin \[privileged\]/);
	assert.match((await call(devAuth, 'request_access', { system: 'grafana', justification: 'Debug alerts' })).text, /levels Viewer, Admin. Say which/);
	const made = await call(devAuth, 'request_access', { system: 'grafana', level: 'viewer', justification: 'Debug alerts', duration_days: 5 });
	assert.match(made.text, /Created request #1: Grafana \(Viewer\) for dev, 5 days. It’s waiting for approval/);
	assert.match((await call(apprAuth, 'pending_approvals')).text, /#1 Grafana \(Viewer\) for dev.*\n  reason: “Debug alerts”/);

	const denied = await call(devAuth, 'approve_request', { number: 1 });
	assert.ok(denied.isError);
	assert.match(denied.text, /can’t approve/);
	const approved = await call(apprAuth, 'approve_request', { number: 1, comment: 'ok' });
	assert.match(approved.text, /Approved #1/);
	const req = await getRequest(w.db, w.org.id, { number: 1 });
	assert.equal(req.status, 'pending_fulfillment');
	const tl = (await requestTimeline(w.db, w.org.id, req.id)).map((e) => e.summary);
	assert.ok(tl.some((s) => /Requested Grafana \(Viewer\) via MCP/.test(s)));
	assert.ok(tl.some((s) => /Approved .* as designated approver via MCP/.test(s)), tl.join('\n'));
	assert.match((await call(devAuth, 'get_request', { number: 1 })).text, /step 1: approved by appr as designated approver/);
	assert.match((await call(apprAuth, 'get_request', { number: 99 })).text, /doesn’t exist/);

	// A deactivated member's token stops working.
	await w.db.run("UPDATE members SET status = 'deactivated' WHERE org_id = ? AND user_id = ?", [w.org.id, w.dev.id]);
	assert.equal(await authenticatePersonal(w.db, `Bearer ${devTok.token}`), null);
});

test('Slack: /access opens a form that makes a request; thread replies approve and deny', async () => {
	const w = await world();
	const secret = 'shh';
	const slack: { method: string; body: Record<string, any> }[] = [];
	const ids: Record<string, string> = { [w.approver.email]: 'U_APPR', [w.dev.email]: 'U_DEV' };
	let ts = 100;
	setSlackFetch(async (input, init) => {
		const method = String(input).split('/api/')[1];
		const body = JSON.parse(String(init?.body ?? '{}'));
		slack.push({ method, body });
		if (method === 'auth.test') return respond(200, { ok: true, team_id: `T${w.tag}`, team: 'Acme' });
		if (method === 'users.lookupByEmail') return respond(200, ids[body.email] ? { ok: true, user: { id: ids[body.email] } } : { ok: false, error: 'users_not_found' });
		if (method === 'users.info') return respond(200, { ok: true, user: { profile: { email: Object.entries(ids).find(([, v]) => v === body.user)?.[0] } } });
		if (method === 'chat.postMessage') return respond(200, { ok: true, channel: `D_${body.channel}`, ts: `${++ts}.000` });
		return respond(200, { ok: true });
	});
	await connectSlack(w.db, w.org.id, { botToken: 'xoxb-1', signingSecret: secret });
	const sign = (raw: string) => {
		const t = String(Math.floor(Date.now() / 1000));
		return { timestamp: t, signature: `v0=${createHmac('sha256', secret).update(`v0:${t}:${raw}`).digest('hex')}` };
	};
	const command = (user: string, text: string) => {
		const raw = new URLSearchParams({ team_id: `T${w.tag}`, user_id: user, command: '/access', text, trigger_id: 'trig' }).toString();
		return handleCommand(w.db, raw, sign(raw), 'https://acm.test');
	};
	const interact = (payload: Record<string, unknown>) => {
		const raw = new URLSearchParams({ payload: JSON.stringify({ team: { id: `T${w.tag}` }, ...payload }) }).toString();
		return handleInteraction(w.db, raw, sign(raw), 'https://acm.test', async () => {});
	};
	const dm = async (user: string, text: string, thread?: string, channel = 'D_U_APPR') => {
		const raw = JSON.stringify({ type: 'event_callback', team_id: `T${w.tag}`, event: { type: 'message', channel_type: 'im', channel, user, text, ts: `${++ts}.5`, ...(thread ? { thread_ts: thread } : {}) } });
		const r = await handleEvent(w.db, raw, { ...sign(raw), retry: null }, 'https://acm.test');
		await r.work;
		return slack.filter((s) => s.method === 'chat.postMessage' && s.body.channel === channel).at(-1)!.body;
	};

	assert.equal((await command('U_DEV', 'mine')).status, 200);
	const unknown = await command('U_NOBODY', '');
	assert.match(JSON.stringify(unknown.body), /doesn’t match an active ac·modern account/);
	const forged = new URLSearchParams({ team_id: `T${w.tag}`, user_id: 'U_DEV', text: '' }).toString();
	assert.equal((await handleCommand(w.db, forged, { timestamp: String(Math.floor(Date.now() / 1000)), signature: 'v0=nope' }, 'x')).status, 401);

	// "/access grafana viewer" opens the form with Grafana — Viewer picked.
	await command('U_DEV', 'grafana viewer');
	const open = slack.find((s) => s.method === 'views.open')!;
	assert.equal(open.body.view.blocks[0].element.initial_option.value, `${w.resId}:${w.roles[0].id}`);
	const options = await interact({ type: 'block_suggestion', user: { id: 'U_DEV' }, value: 'graf' });
	assert.deepEqual((options.body as any).options.map((o: any) => o.text.text), ['Grafana — Viewer', 'Grafana — Admin (privileged)']);

	const values = (why: string, days: string | null) => ({ level: { level: { selected_option: { value: `${w.resId}:${w.roles[0].id}` } } }, days: { days: { value: days } }, why: { why: { value: why } } });
	const bad = await interact({ type: 'view_submission', user: { id: 'U_DEV' }, view: { callback_id: 'acm_request', state: { values: values('', null) } } });
	assert.deepEqual(Object.keys((bad.body as any).errors), ['why']);
	const good = await interact({ type: 'view_submission', user: { id: 'U_DEV' }, view: { callback_id: 'acm_request', state: { values: values('On call this week', '7') } } });
	assert.deepEqual(good.body, { response_action: 'clear' });
	await good.work;
	const req = await getRequest(w.db, w.org.id, { number: 1 });
	assert.equal(req.durationDays, 7);
	assert.ok((await requestTimeline(w.db, w.org.id, req.id)).some((e) => /Requested Grafana \(Viewer\) via Slack/.test(e.summary)));
	assert.match(slack.filter((s) => s.method === 'chat.postMessage' && s.body.channel === 'U_DEV').at(-1)!.body.text, /Request #1 for Grafana \(Viewer\). It’s waiting for approval/);

	// The approver's DM was remembered; "y" in its thread approves.
	const approval = slack.find((s) => s.method === 'chat.postMessage' && s.body.channel === 'U_APPR')!;
	assert.match(JSON.stringify(approval.body.blocks), /reply in this thread/);
	const row = await w.db.get<{ ts: string }>('SELECT ts FROM slack_messages WHERE request_id = ?', [req.id]);
	assert.match((await dm('U_DEV', 'y', row!.ts, 'D_U_DEV')).text, /Which request/, 'a thread in someone else’s DM isn’t theirs to answer');
	assert.match((await dm('U_DEV', 'approve 1', undefined, 'D_U_DEV')).text, /can’t approve your own access/);
	assert.match((await dm('U_APPR', 'sounds fine', row!.ts)).text, /Reply \*y\* to approve/);
	assert.match((await dm('U_APPR', 'y', row!.ts)).text, /You approved #1/);
	assert.equal((await getRequest(w.db, w.org.id, { id: req.id })).status, 'pending_fulfillment');
	assert.ok(slack.some((s) => s.method === 'chat.update' && s.body.ts === row!.ts), 'buttons taken off the original');
	assert.ok((await listEvents(w.db, w.org.id)).some((e) => e.action === 'request.approved' && /via Slack/.test(e.summary)));

	// Top level: "n 2" asks for a reason; "deny #2: …" denies.
	const r2 = await createRequest(w.db, w.A(w.dev), { userId: w.dev.id, resourceId: w.resId, roleId: w.roles[1].id, justification: 'admin please', durationDays: 1 }, effects());
	assert.match((await dm('U_APPR', 'n 2')).text, /Say why/);
	assert.match((await dm('U_APPR', 'y')).text, /Which request/);
	assert.match((await dm('U_APPR', 'deny #2: use the viewer role')).text, /You denied #2: “use the viewer role”/);
	assert.equal((await getRequest(w.db, w.org.id, { id: r2.id })).status, 'denied');

	// Retries are ignored, and Slack's URL check is answered.
	const retry = JSON.stringify({ type: 'event_callback', team_id: `T${w.tag}`, event: { type: 'message', channel_type: 'im', channel: 'D', user: 'U_APPR', text: 'y' } });
	assert.equal((await handleEvent(w.db, retry, { ...sign(retry), retry: '1' }, 'x')).work, undefined);
	assert.deepEqual((await handleEvent(w.db, JSON.stringify({ type: 'url_verification', challenge: 'abc' }), { timestamp: null, signature: null, retry: null }, 'x')).body, { challenge: 'abc' });
});

test('reply parsing is strict about what counts as a decision', () => {
	assert.deepEqual(parseReply('y'), { decision: 'approved', number: null, note: '' });
	assert.deepEqual(parseReply('Yes, looks right'), { decision: 'approved', number: null, note: 'looks right' });
	assert.deepEqual(parseReply('approve 42'), { decision: 'approved', number: 42, note: '' });
	assert.deepEqual(parseReply('n: wrong team'), { decision: 'denied', number: null, note: 'wrong team' });
	assert.deepEqual(parseReply('deny #7 — use read-only'), { decision: 'denied', number: 7, note: 'use read-only' });
	assert.equal(parseReply('ok will look later').decision, null);
	assert.equal(parseReply('nothing to see').decision, null);
	assert.equal(parseReply('yesterday maybe').decision, null);
});
