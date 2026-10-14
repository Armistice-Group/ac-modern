import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createUser, updateUser } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { createRequest, effects, flush, getRequest, setAutomationFetch, startRevoke } from '../src/lib/server/requests.ts';
import { saveIntegration } from '../src/lib/server/integrations.ts';
import { connectSlack, setSlackFetch } from '../src/lib/server/slack.ts';
import { handleInteraction } from '../src/lib/server/slack-interactions.ts';
import { requestTimeline } from '../src/lib/server/events.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

const respond = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
	const base = (o: Partial<ResourceInput>): ResourceInput => ({
		name: 'R', description: '', category: 'app', url: '', color: 'violet', ownerId: owner.id, approval: 'none', fulfillment: 'manual', webhookUrl: '',
		maxDays: null, defaultDays: null, requestable: true, approverIds: [], fulfillerIds: [owner.id],
		roles: [{ name: 'Member', description: '', privileged: false }, { name: 'Admin', description: '', privileged: true }], ...o
	});
	return { db, org, owner, mk, base, tag, A: (u: { id: string }, admin = false) => ({ orgId: org.id, userId: u.id, admin }) };
}

test('GitHub: team by username, invitation by email, removal; failures go to people', async () => {
	const w = await world();
	const calls: string[] = [];
	let fail = false;
	setAutomationFetch(async (input, init) => {
		const url = new URL(String(input));
		calls.push(`${init?.method ?? 'GET'} ${url.pathname}${init?.body ? ` ${init.body}` : ''}`);
		if (fail) return respond(500, { message: 'GitHub is down' });
		if (url.pathname === '/orgs/acme/teams/platform') return respond(200, { id: 42 });
		if (url.pathname === '/orgs/acme/invitations' && (init?.method ?? 'GET') === 'GET') return respond(200, [{ id: 7, email: `ivy-${w.tag}@acme.test` }]);
		return respond(init?.method === 'DELETE' ? 204 : 200, {});
	});
	await saveIntegration(w.db, w.org.id, 'github', { org: 'acme', token: 't' });
	const id = await saveResource(w.db, w.org.id, null, w.base({ name: 'GitHub', fulfillment: 'integration', integration: 'github', integrationMap: { '#0': { type: 'github_team', team: 'platform', role: 'member' }, '#1': { type: 'github_org', role: 'admin' } } }));
	const roles = await w.db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [id]);

	const dev = await w.mk('dev');
	await updateUser(w.db, dev.id, { githubLogin: '@devhub' });
	let fx = effects();
	const r = await createRequest(w.db, w.A(dev), { userId: dev.id, resourceId: id, roleId: roles[0].id, justification: '', durationDays: null }, fx);
	await flush(w.db, w.org.id, fx, 'http://x');
	assert.equal((await getRequest(w.db, w.org.id, { id: r.id })).status, 'completed');
	assert.ok(calls.includes('PUT /orgs/acme/teams/platform/memberships/devhub {"role":"member"}'), calls.join('\n'));
	const note = (await requestTimeline(w.db, w.org.id, r.id)).find((e) => e.action === 'grant.created')!.data.note;
	assert.match(String(note), /added to team platform/);

	// Removal by username.
	fx = effects();
	const g = (await w.db.get<{ id: string }>('SELECT id FROM grants WHERE user_id = ?', [dev.id]))!;
	const rm = await w.db.tx((tx) => startRevoke(tx, w.A(w.owner, true), g.id, 'manual', '', fx));
	await flush(w.db, w.org.id, fx, 'http://x');
	assert.equal((await getRequest(w.db, w.org.id, { id: rm!.id })).status, 'completed');
	assert.ok(calls.includes('DELETE /orgs/acme/teams/platform/memberships/devhub'));

	// No username: an email invitation to the team; removal cancels it.
	const ivy = await w.mk('ivy');
	fx = effects();
	const r2 = await createRequest(w.db, w.A(ivy), { userId: ivy.id, resourceId: id, roleId: roles[0].id, justification: '', durationDays: null }, fx);
	await flush(w.db, w.org.id, fx, 'http://x');
	assert.ok(calls.some((c) => c.startsWith('POST /orgs/acme/invitations') && c.includes('"team_ids":[42]')));
	const g2 = (await w.db.get<{ id: string }>('SELECT id FROM grants WHERE user_id = ?', [ivy.id]))!;
	fx = effects();
	await w.db.tx((tx) => startRevoke(tx, w.A(w.owner, true), g2.id, 'manual', '', fx));
	await flush(w.db, w.org.id, fx, 'http://x');
	assert.ok(calls.includes('DELETE /orgs/acme/invitations/7'));
	void r2;

	// GitHub failing: the request waits for a person, with the reason logged.
	fail = true;
	const zed = await w.mk('zed');
	fx = effects();
	const r3 = await createRequest(w.db, w.A(zed), { userId: zed.id, resourceId: id, roleId: roles[0].id, justification: '', durationDays: null }, fx);
	await flush(w.db, w.org.id, fx, 'http://x');
	assert.equal((await getRequest(w.db, w.org.id, { id: r3.id })).status, 'pending_fulfillment');
	assert.ok((await requestTimeline(w.db, w.org.id, r3.id)).some((e) => e.action === 'request.webhook_failed' && /GitHub is down/.test(e.summary)));
});

test('Google Workspace: group membership and account suspension', async () => {
	const w = await world();
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const calls: string[] = [];
	setAutomationFetch(async (input, init) => {
		const url = new URL(String(input));
		if (url.host === 'oauth2.googleapis.com') return respond(200, { access_token: 'g' });
		calls.push(`${init?.method} ${decodeURIComponent(url.pathname)} ${init?.body ?? ''}`.trim());
		return respond(init?.method === 'DELETE' ? 204 : 200, {});
	});
	await saveIntegration(w.db, w.org.id, 'google', { serviceAccountJson: JSON.stringify({ client_email: 'sa@x', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), adminEmail: 'admin@acme.test' });
	const id = await saveResource(w.db, w.org.id, null, w.base({ name: 'Drive', fulfillment: 'integration', integration: 'google', integrationMap: { '#0': { type: 'google_group', group: 'eng@acme.test', role: 'MEMBER' }, '#1': { type: 'google_account' } } }));
	const roles = await w.db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [id]);
	const dev = await w.mk('dev');
	const fx = effects();
	await createRequest(w.db, w.A(dev), { userId: dev.id, resourceId: id, roleId: roles[0].id, justification: '', durationDays: null }, fx);
	await flush(w.db, w.org.id, fx, 'http://x');
	assert.ok(calls.some((c) => c.startsWith('POST /admin/directory/v1/groups/eng@acme.test/members') && c.includes('"role":"MEMBER"')));
	const g = (await w.db.get<{ id: string }>('SELECT id FROM grants WHERE user_id = ?', [dev.id]))!;
	const fx2 = effects();
	await w.db.tx((tx) => startRevoke(tx, w.A(w.owner, true), g.id, 'manual', '', fx2));
	await flush(w.db, w.org.id, fx2, 'http://x');
	assert.ok(calls.some((c) => c === `DELETE /admin/directory/v1/groups/eng@acme.test/members/dev-${w.tag}@acme.test`));
	// Mapping is required for every level.
	await assert.rejects(saveResource(w.db, w.org.id, null, w.base({ name: 'X', fulfillment: 'integration', integration: 'google', integrationMap: { '#0': { type: 'google_account' } } })), /Admin/);
});

test('Slack: approvers get buttons; signed clicks approve; deny asks why; strangers are refused', async () => {
	const w = await world();
	const approver = await w.mk('appr');
	const dev = await w.mk('dev');
	const stranger = await w.mk('stranger');
	const slack: { method: string; body: Record<string, unknown> }[] = [];
	const slackIds: Record<string, string> = { [approver.email]: 'U_APPR', [dev.email]: 'U_DEV', [stranger.email]: 'U_STR' };
	setSlackFetch(async (input, init) => {
		const method = String(input).split('/api/')[1];
		const body = JSON.parse(String(init?.body ?? '{}'));
		slack.push({ method, body });
		if (method === 'auth.test') return respond(200, { ok: true, team_id: `T${w.tag}`, team: 'Acme' });
		if (method === 'users.lookupByEmail') return respond(200, slackIds[body.email] ? { ok: true, user: { id: slackIds[body.email] } } : { ok: false, error: 'users_not_found' });
		if (method === 'users.info') return respond(200, { ok: true, user: { profile: { email: Object.entries(slackIds).find(([, v]) => v === body.user)?.[0] } } });
		return respond(200, { ok: true });
	});
	const secret = 'shh';
	await connectSlack(w.db, w.org.id, { botToken: 'xoxb-1', signingSecret: secret });
	const id = await saveResource(w.db, w.org.id, null, w.base({ name: 'AWS', approval: 'approvers', approverIds: [approver.id] }));
	const roles = await w.db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [id]);
	const fx = effects();
	const r = await createRequest(w.db, w.A(dev), { userId: dev.id, resourceId: id, roleId: roles[0].id, justification: 'need it', durationDays: null }, fx);
	await flush(w.db, w.org.id, fx, 'http://x');
	const dm = slack.find((s) => s.method === 'chat.postMessage' && s.body.channel === 'U_APPR');
	assert.ok(JSON.stringify(dm?.body.blocks).includes('"action_id":"approve"'));

	const posts: unknown[] = [];
	const click = (user: string, action: string, ts = Math.floor(Date.now() / 1000), sig?: string) => {
		const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: `T${w.tag}` }, user: { id: user }, trigger_id: 'tr', response_url: 'https://hooks.slack.test/r', actions: [{ action_id: action, value: r.id }] }) }).toString();
		const signature = sig ?? `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
		return handleInteraction(w.db, raw, { timestamp: String(ts), signature }, 'http://x', async (_u, b) => posts.push(b));
	};
	assert.equal((await click('U_APPR', 'approve', undefined, 'v0=forged')).status, 401);
	assert.equal((await click('U_APPR', 'approve', Math.floor(Date.now() / 1000) - 3600)).status, 401, 'replayed');
	await click('U_STR', 'approve');
	assert.match(JSON.stringify(posts.at(-1)), /not an approver/);
	assert.equal((await getRequest(w.db, w.org.id, { id: r.id })).status, 'pending_approval');
	await click('U_APPR', 'approve');
	assert.equal((await getRequest(w.db, w.org.id, { id: r.id })).status, 'pending_fulfillment');
	assert.ok((await requestTimeline(w.db, w.org.id, r.id)).some((e) => e.action === 'request.approved' && /via Slack/.test(e.summary)));

	// Deny: the button opens a modal; submitting it denies with the reason.
	const r2 = await createRequest(w.db, w.A(dev), { userId: dev.id, resourceId: id, roleId: roles[1].id, justification: 'admin pls', durationDays: 1 }, effects());
	const ts = Math.floor(Date.now() / 1000);
	const submit = new URLSearchParams({
		payload: JSON.stringify({ type: 'view_submission', team: { id: `T${w.tag}` }, user: { id: 'U_APPR' }, view: { callback_id: 'acm_deny', private_metadata: JSON.stringify({ requestId: r2.id }), state: { values: { reason: { reason: { value: 'Use read-only' } } } } } })
	}).toString();
	const res = await handleInteraction(w.db, submit, { timestamp: String(ts), signature: `v0=${createHmac('sha256', secret).update(`v0:${ts}:${submit}`).digest('hex')}` }, 'http://x', async () => {});
	assert.equal(res.status, 200);
	assert.equal((await getRequest(w.db, w.org.id, { id: r2.id })).status, 'denied');
});
