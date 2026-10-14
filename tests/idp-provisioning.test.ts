import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createUser } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { createRequest, effects, flush, getRequest, setAutomationFetch, startRevoke } from '../src/lib/server/requests.ts';
import { saveIntegration } from '../src/lib/server/integrations.ts';
import { requestTimeline } from '../src/lib/server/events.ts';
import { entraTargets } from '../src/lib/server/idp/entra.ts';
import type { IntegrationKind, LevelMapping } from '../src/lib/types.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

const respond = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function world(kind: IntegrationKind, config: Record<string, string>, map: Record<string, LevelMapping>) {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `own-${tag}@acme.test`, name: 'Owner', password: 'password123' });
	await saveIntegration(db, org.id, kind, config);
	const input: ResourceInput = {
		name: 'App', description: '', category: 'app', url: '', color: 'violet', ownerId: owner.id, approval: 'none', fulfillment: 'integration', integration: kind, integrationMap: map,
		webhookUrl: '', maxDays: null, defaultDays: null, requestable: true, approverIds: [], fulfillerIds: [owner.id],
		roles: [{ name: 'User', description: '', privileged: false }, { name: 'Admin', description: '', privileged: false }]
	};
	const id = await saveResource(db, org.id, null, input);
	const roles = await db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [id]);
	const mk = async (n: string) => {
		const u = await createUser(db, { email: `${n}-${tag}@acme.test`, name: n, passwordHash: null });
		await addMember(db, org.id, u.id, 'member');
		return u;
	};
	const A = (u: { id: string }, admin = false) => ({ orgId: org.id, userId: u.id, admin });
	const grant = async (u: { id: string }, role: number) => {
		const fx = effects();
		const r = await createRequest(db, A(u), { userId: u.id, resourceId: id, roleId: roles[role].id, justification: '', durationDays: null }, fx);
		await flush(db, org.id, fx, 'http://x');
		return getRequest(db, org.id, { id: r.id });
	};
	const revoke = async (u: { id: string }, role: number) => {
		const g = (await db.get<{ id: string }>("SELECT id FROM grants WHERE user_id = ? AND role_id = ? AND status = 'active'", [u.id, roles[role].id]))!;
		const fx = effects();
		const r = await db.tx((tx) => startRevoke(tx, A(owner, true), g.id, 'manual', '', fx));
		await flush(db, org.id, fx, 'http://x');
		return getRequest(db, org.id, { id: r!.id });
	};
	const note = async (requestId: string) => String((await requestTimeline(db, org.id, requestId)).find((e) => e.action.startsWith('grant.'))?.data.note ?? '');
	return { db, org, tag, mk, grant, revoke, note };
}

test('Okta: group by login, app by email search; missing person fails grant but not removal', async () => {
	const calls: string[] = [];
	let tag = '';
	setAutomationFetch(async (input, init) => {
		const url = new URL(String(input));
		const m = init?.method ?? 'GET';
		calls.push(`${m} ${decodeURIComponent(url.pathname + url.search)}${init?.body ? ` ${init.body}` : ''}`);
		if (m === 'GET' && decodeURIComponent(url.pathname) === `/api/v1/users/dev-${tag}@acme.test`) return respond(200, { id: '00u_dev' });
		if (m === 'GET' && url.pathname.startsWith('/api/v1/users/')) return respond(404, { errorSummary: 'Not found' });
		if (m === 'GET' && url.pathname === '/api/v1/users') return respond(200, url.searchParams.get('search')?.includes(`ann-${tag}`) ? [{ id: '00u_ann' }] : []);
		return respond(m === 'POST' ? 200 : 204);
	});
	const w = await world('okta', { domain: 'acme.okta.com', apiToken: 't' }, { '#0': { type: 'okta_group', id: '00g_eng', name: 'Engineering' }, '#1': { type: 'okta_app', id: '0oa_sf', name: 'Salesforce' } });
	tag = w.tag;
	const dev = await w.mk('dev');
	const r1 = await w.grant(dev, 0);
	assert.equal(r1.status, 'completed');
	assert.ok(calls.includes('PUT /api/v1/groups/00g_eng/users/00u_dev'));
	assert.match(await w.note(r1.id), /added to group Engineering/);
	assert.equal((await w.revoke(dev, 0)).status, 'completed');
	assert.ok(calls.includes('DELETE /api/v1/groups/00g_eng/users/00u_dev'));

	const ann = await w.mk('ann');
	assert.equal((await w.grant(ann, 1)).status, 'completed');
	assert.ok(calls.some((c) => c.startsWith('POST /api/v1/apps/0oa_sf/users') && c.includes('"id":"00u_ann"')));
	assert.equal((await w.revoke(ann, 1)).status, 'completed');
	assert.ok(calls.includes('DELETE /api/v1/apps/0oa_sf/users/00u_ann'));

	const ghost = await w.mk('ghost');
	const r3 = await w.grant(ghost, 0);
	assert.equal(r3.status, 'pending_fulfillment');
	assert.ok((await requestTimeline(w.db, w.org.id, r3.id)).some((e) => /has no Okta account/.test(e.summary)));
});

test('Authentik: add_user / remove_user by user pk', async () => {
	const calls: string[] = [];
	let tag = '';
	setAutomationFetch(async (input, init) => {
		const url = new URL(String(input));
		calls.push(`${init?.method ?? 'GET'} ${url.pathname}${init?.body ? ` ${init.body}` : ''}`);
		if (url.pathname === '/api/v3/core/users/') return respond(200, { results: url.searchParams.get('email') === `dev-${tag}@acme.test` ? [{ pk: 12, email: `dev-${tag}@acme.test` }] : [] });
		return respond(204);
	});
	const w = await world('authentik', { url: 'https://auth.acme.test/', token: 't' }, { '#0': { type: 'authentik_group', id: 'uuid-eng', name: 'eng' }, '#1': { type: 'authentik_group', id: 'uuid-adm', name: 'admins' } });
	tag = w.tag;
	const dev = await w.mk('dev');
	assert.equal((await w.grant(dev, 1)).status, 'completed');
	assert.ok(calls.includes('POST /api/v3/core/groups/uuid-adm/add_user/ {"pk":12}'));
	assert.equal((await w.revoke(dev, 1)).status, 'completed');
	assert.ok(calls.includes('POST /api/v3/core/groups/uuid-adm/remove_user/ {"pk":12}'));
});

test('Entra: add member $ref (already a member is fine), remove; dynamic groups aren’t offered', async () => {
	const calls: string[] = [];
	let already = false;
	setAutomationFetch(async (input, init) => {
		const url = new URL(String(input));
		const m = init?.method ?? 'GET';
		if (url.host === 'login.microsoftonline.com') return respond(200, { access_token: 'tok' });
		calls.push(`${m} ${decodeURIComponent(url.pathname)}${init?.body ? ` ${init.body}` : ''}`);
		if (m === 'GET' && url.pathname.startsWith('/v1.0/users/')) return respond(200, { id: 'u-1' });
		if (m === 'POST' && already) return respond(400, { error: { message: 'One or more added object references already exist for the following modified properties: members.' } });
		return respond(204);
	});
	const w = await world('entra', { tenantId: 't', clientId: 'c', clientSecret: 's' }, { '#0': { type: 'entra_group', id: 'g-1', name: 'App users' }, '#1': { type: 'entra_group', id: 'g-2', name: 'App admins' } });
	const dev = await w.mk('dev');
	assert.equal((await w.grant(dev, 0)).status, 'completed');
	assert.ok(calls.some((c) => c.startsWith('POST /v1.0/groups/g-1/members/$ref') && c.includes('directoryObjects/u-1')));
	already = true;
	assert.equal((await w.grant(dev, 1)).status, 'completed', 'already a member');
	assert.equal((await w.revoke(dev, 0)).status, 'completed');
	assert.ok(calls.includes('DELETE /v1.0/groups/g-1/members/u-1/$ref'));

	const t = await entraTargets({ tenantId: 't', clientId: 'c', clientSecret: 's' }, async (input) => {
		const url = new URL(String(input));
		if (url.host === 'login.microsoftonline.com') return respond(200, { access_token: 'tok' });
		return respond(200, {
			value: [
				{ id: 'a', displayName: 'Assigned', securityEnabled: true, groupTypes: [] },
				{ id: 'd', displayName: 'Dynamic', securityEnabled: true, groupTypes: ['DynamicMembership'] },
				{ id: 'm', displayName: 'Distribution list', securityEnabled: false, mailEnabled: true, groupTypes: [] }
			]
		});
	});
	assert.deepEqual(t.groups.map((g) => g.id), ['a']);
});

test('every level must be mapped', async () => {
	setAutomationFetch(async () => respond(204));
	await assert.rejects(world('okta', { domain: 'x', apiToken: 't' }, { '#0': { type: 'okta_group', id: 'g', name: 'g' } }), /Admin/);
	await assert.rejects(world('entra', { tenantId: 't', clientId: 'c', clientSecret: 's' }, { '#0': { type: 'entra_group', id: '', name: '' }, '#1': { type: 'entra_group', id: 'g', name: 'g' } }), /User/);
});
