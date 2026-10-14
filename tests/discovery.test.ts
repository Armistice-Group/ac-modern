import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createUser } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveIntegration } from '../src/lib/server/integrations.ts';
import { discoverApps, importApps } from '../src/lib/server/discovery.ts';
import { listGrants } from '../src/lib/server/grants.ts';
import { getResource } from '../src/lib/server/resources.ts';
import { outOfProcess } from '../src/lib/server/evidence.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

const respond = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `own-${tag}@acme.test`, name: 'Owner', password: 'password123' });
	const people: Record<string, string> = {};
	for (const n of ['ann', 'bob', 'cat']) {
		const u = await createUser(db, { email: `${n}-${tag}@acme.test`, name: n, passwordHash: null });
		await addMember(db, org.id, u.id, 'member');
		people[n] = u.id;
	}
	const email = (n: string) => `${n}-${tag}@acme.test`;
	return { db, org, owner, people, email, tag };
}

test('Authentik scan: group bindings become provisioned levels, members become recorded access', async () => {
	const w = await world();
	await saveIntegration(w.db, w.org.id, 'authentik', { url: 'https://sso.acme.test', token: 't' });
	const page = (results: unknown[]) => respond({ results, pagination: { next: 0 } });
	const fake: typeof fetch = async (input) => {
		const u = new URL(String(input));
		assert.equal(u.host, 'sso.acme.test');
		if (u.pathname === '/api/v3/core/applications/') {
			assert.equal(u.searchParams.get('superuser_full_list'), 'true');
			return page([
				{ pk: 'app-grafana', name: 'Grafana', slug: 'grafana', launch_url: 'https://grafana.acme.test', meta_description: 'Dashboards' },
				{ pk: 'app-wiki', name: 'Wiki', slug: 'wiki', launch_url: 'goauthentik.io://providers/wiki' },
				{ pk: 'app-acm', name: 'ac·modern', slug: 'access-modern', launch_url: 'https://access.acme.test' }
			]);
		}
		if (u.pathname === '/api/v3/policies/bindings/') {
			const target = u.searchParams.get('target');
			if (target === 'app-grafana')
				return page([
					{ group: 'g-eng', group_obj: { name: 'engineering' }, user: null, policy: null, enabled: true, negate: false },
					{ group: 'g-ops', group_obj: { name: 'grafana-admins' }, user: null, policy: null, enabled: true, negate: false },
					{ group: 'g-old', group_obj: { name: 'disabled' }, user: null, policy: null, enabled: false, negate: false }
				]);
			if (target === 'app-wiki') return page([{ group: null, user: 7, user_obj: { email: w.email('cat'), is_active: true }, policy: null, enabled: true, negate: false }]);
			return page([]);
		}
		if (u.pathname === '/api/v3/core/users/') {
			const g = u.searchParams.get('groups_by_pk');
			if (g === 'g-eng') return page([{ email: w.email('ann'), is_active: true }, { email: w.email('bob'), is_active: true }, { email: 'contractor@elsewhere.test', is_active: true }]);
			if (g === 'g-ops') return page([{ email: w.email('ann').toUpperCase(), is_active: true }]);
		}
		return new Response('{}', { status: 404 });
	};

	const apps = await discoverApps(w.db, w.org.id, 'authentik', fake);
	const grafana = apps.find((a) => a.name === 'Grafana')!;
	assert.equal(grafana.provisioned, true);
	assert.deepEqual(grafana.levels.map((l) => [l.name, l.people, l.notMembers]), [['engineering', 3, ['contractor@elsewhere.test']], ['grafana-admins', 1, []]]);
	const wiki = apps.find((a) => a.name === 'Wiki')!;
	assert.equal(wiki.provisioned, false, 'direct user bindings can’t be granted by group');
	assert.equal(apps.find((a) => a.name === 'ac·modern')!.openToAll, true);

	const r = await importApps(w.db, w.org.id, w.owner.id, 'authentik', [grafana.ref, wiki.ref], { approval: 'approvers' }, fake);
	assert.deepEqual(r, { resources: 2, grants: 4, notMembers: 1 });

	const after = await discoverApps(w.db, w.org.id, 'authentik', fake);
	const gid = after.find((a) => a.name === 'Grafana')!.resourceId!;
	assert.ok(gid, 'marked as imported');
	const res = await getResource(w.db, w.org.id, gid);
	assert.equal(res.fulfillment, 'integration');
	assert.equal(res.integration, 'authentik');
	assert.equal(res.url, 'https://grafana.acme.test');
	assert.deepEqual(res.roles.map((x) => x.name), ['engineering', 'grafana-admins']);
	const wikiRes = await getResource(w.db, w.org.id, after.find((a) => a.name === 'Wiki')!.resourceId!);
	assert.equal(wikiRes.fulfillment, 'manual');
	assert.equal(wikiRes.url, '', 'non-web launch URLs are dropped');

	const annGrants = await listGrants(w.db, w.org.id, { userId: w.people.ann });
	assert.equal(annGrants.length, 2, 'Ann holds both Grafana levels');
	assert.ok(annGrants.every((g) => g.source === 'idp' && /app scan/.test(g.note)));
	const oop = await outOfProcess(w.db, w.org.id, '2000-01-01', '2100-01-01');
	assert.equal(oop.recorded.filter((e) => e.action === 'grant.recorded').length, 4, 'the baseline shows in the evidence');

	// Importing again does nothing: the app is already a resource.
	assert.deepEqual(await importApps(w.db, w.org.id, w.owner.id, 'authentik', [grafana.ref], { approval: 'approvers' }, fake), { resources: 0, grants: 0, notMembers: 0 });
});

test('Okta scan: groups and direct assignments; Entra scan: group assignments and direct users', async () => {
	const w = await world();
	await saveIntegration(w.db, w.org.id, 'okta', { domain: 'acme.okta.com', apiToken: 't' });
	const okta: typeof fetch = async (input) => {
		const u = new URL(String(input));
		if (u.pathname === '/api/v1/apps')
			return respond([
				{ id: 'a1', name: 'slack', label: 'Slack', status: 'ACTIVE', _links: { appLinks: [{ href: 'https://acme.okta.com/home/slack/a1' }] } },
				{ id: 'a2', name: 'saasure', label: 'Okta Admin Console', status: 'ACTIVE' },
				{ id: 'a3', name: 'zoom', label: 'Zoom', status: 'ACTIVE' }
			]);
		if (u.pathname === '/api/v1/apps/a1/groups') return respond([{ id: 'og1', _embedded: { group: { profile: { name: 'Everyone at Acme' } } } }]);
		if (u.pathname === '/api/v1/apps/a3/groups') return respond([]);
		if (u.pathname === '/api/v1/groups/og1/users') return respond([{ id: 'u1', status: 'ACTIVE', profile: { login: w.email('ann'), email: w.email('ann') } }, { id: 'u2', status: 'DEPROVISIONED', profile: { login: w.email('bob') } }]);
		if (u.pathname === '/api/v1/apps/a1/users') return respond([{ scope: 'USER', _embedded: { user: { id: 'u3', status: 'ACTIVE', profile: { login: w.email('cat'), email: w.email('cat') } } } }]);
		if (u.pathname === '/api/v1/apps/a3/users') return respond([{ scope: 'USER', _embedded: { user: { id: 'u2', status: 'ACTIVE', profile: { login: w.email('bob') } } } }]);
		return new Response('[]', { status: 404 });
	};
	const oapps = await discoverApps(w.db, w.org.id, 'okta', okta);
	assert.deepEqual(oapps.map((a) => a.name), ['Slack', 'Zoom'], 'Okta’s own apps are left out');
	assert.deepEqual(oapps[0].levels.map((l) => [l.name, l.people]), [['Everyone at Acme', 1], ['Direct assignment', 1]]);
	assert.deepEqual(oapps[1].levels.map((l) => l.name), ['Access']);
	assert.ok(oapps.every((a) => a.provisioned), 'groups and app assignments can both be provisioned');
	assert.deepEqual(await importApps(w.db, w.org.id, w.owner.id, 'okta', oapps.map((a) => a.ref), { approval: 'manager' }, okta), { resources: 2, grants: 3, notMembers: 0 });

	await saveIntegration(w.db, w.org.id, 'entra', { tenantId: 'tid', clientId: 'c', clientSecret: 's' });
	const entra: typeof fetch = async (input) => {
		const u = new URL(String(input));
		if (u.host === 'login.microsoftonline.com') return respond({ access_token: 'm' });
		if (u.pathname === '/v1.0/servicePrincipals') return respond({ value: [{ id: 'sp1', displayName: 'Salesforce', homepage: 'https://acme.my.salesforce.com', appRoleAssignmentRequired: true }] });
		if (u.pathname === '/v1.0/servicePrincipals/sp1/appRoleAssignedTo')
			return respond({ value: [{ principalType: 'Group', principalId: 'grp1', principalDisplayName: 'Sales' }, { principalType: 'User', principalId: 'usr1', principalDisplayName: 'Cat' }] });
		if (u.pathname === '/v1.0/groups/grp1/transitiveMembers/microsoft.graph.user') return respond({ value: [{ mail: w.email('bob'), userPrincipalName: 'bob@x', accountEnabled: true }] });
		if (u.pathname === '/v1.0/users/usr1') return respond({ mail: null, userPrincipalName: w.email('cat'), accountEnabled: true });
		return new Response('{}', { status: 404 });
	};
	const [sf] = await discoverApps(w.db, w.org.id, 'entra', entra);
	assert.deepEqual(sf.levels.map((l) => [l.name, l.provisioned, l.people]), [['Sales', true, 1], ['Direct assignment', false, 1]]);
	assert.equal(sf.provisioned, false);
	assert.deepEqual(await importApps(w.db, w.org.id, w.owner.id, 'entra', [sf.ref], { approval: 'approvers' }, entra), { resources: 1, grants: 2, notMembers: 0 });
});
