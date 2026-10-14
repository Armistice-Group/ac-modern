import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { addMapping, getSource, rotateScimToken, saveSource, syncDirectory, orgForScimToken } from '../src/lib/server/directory.ts';
import { handleScim } from '../src/lib/server/scim.ts';
import { saveResource } from '../src/lib/server/resources.ts';
import { listGrants } from '../src/lib/server/grants.ts';
import { listRequests, effects } from '../src/lib/server/requests.ts';
import { outOfProcess } from '../src/lib/server/evidence.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

async function world() {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const tag = Math.random().toString(36).slice(2, 7);
	const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `owner-${tag}@acme.test`, name: 'Owner', password: 'password123' });
	const resId = await saveResource(db, org.id, null, {
		name: 'GitHub', description: '', category: 'app', url: '', color: 'slate', ownerId: owner.id, approval: 'approvers', fulfillment: 'manual', webhookUrl: '',
		maxDays: null, defaultDays: null, requestable: true, approverIds: [], fulfillerIds: [],
		roles: [{ name: 'Member', description: '', privileged: false }, { name: 'Owner', description: '', privileged: true }]
	});
	const roles = await db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [resId]);
	const scim = (method: string, path: string, body: Record<string, unknown> | null = null, q = '') =>
		handleScim(db, org.id, method, path.split('/').filter(Boolean), new URLSearchParams(q), body, 'http://x/scim/v2', 'http://x');
	const member = (email: string) =>
		db.get<{ status: string; role: string; title: string; manager_id: string | null; user_id: string }>(
			'SELECT m.status, m.role, m.title, m.manager_id, m.user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?',
			[org.id, email]
		);
	return { db, org, owner, resId, roles, scim, member, tag };
}

test('SCIM (Entra-style): users, managers, deactivation offboards, groups map to admin and to access', async () => {
	const w = await world();
	await saveSource(w.db, w.org.id, { kind: 'scim', config: {}, onDeactivate: 'offboard', createMembers: true });
	const token = await rotateScimToken(w.db, w.org.id);
	assert.equal(await orgForScimToken(w.db, token), w.org.id);
	assert.equal(await orgForScimToken(w.db, 'acm_scim_nope'), null);

	const ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
	const boss = await w.scim('POST', 'Users', { schemas: [], userName: `boss-${w.tag}@acme.test`, active: true, displayName: 'Bo Boss', emails: [{ primary: true, type: 'work', value: `boss-${w.tag}@acme.test` }], externalId: 'e-boss' });
	assert.equal(boss.status, 201);
	const bossId = (boss.body as { id: string }).id;
	const dev = await w.scim('POST', 'Users', {
		userName: `dev-${w.tag}@acme.test`, active: true, name: { givenName: 'Dee', familyName: 'Dev' }, title: 'Engineer', externalId: 'e-dev',
		emails: [{ primary: true, type: 'work', value: `dev-${w.tag}@acme.test` }], [ENT]: { manager: { value: bossId } }
	});
	const devId = (dev.body as { id: string }).id;
	assert.equal((await w.scim('POST', 'Users', { userName: `dev-${w.tag}@acme.test` })).status, 409);
	const m = await w.member(`dev-${w.tag}@acme.test`);
	assert.equal(m?.status, 'active');
	assert.equal(m?.title, 'Engineer');
	assert.equal(m?.manager_id, (await w.member(`boss-${w.tag}@acme.test`))!.user_id);
	// Entra looks users up by filter before creating them.
	const found = await w.scim('GET', 'Users', null, `filter=userName eq "dev-${w.tag}@acme.test"`);
	assert.equal((found.body as { totalResults: number }).totalResults, 1);

	// Groups: admins and GitHub owners.
	const admins = await w.scim('POST', 'Groups', { displayName: 'ac-admins', members: [{ value: bossId }] });
	const ghOwners = await w.scim('POST', 'Groups', { displayName: 'github-owners', members: [] });
	await addMapping(w.db, w.org.id, { groupId: (admins.body as { id: string }).id, target: 'admin' });
	await addMapping(w.db, w.org.id, { groupId: (ghOwners.body as { id: string }).id, target: 'access', resourceId: w.resId, roleId: w.roles[1].id });
	await w.scim('PATCH', `Groups/${(ghOwners.body as { id: string }).id}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: devId }] }] });
	assert.equal((await w.member(`boss-${w.tag}@acme.test`))?.role, 'admin');
	let grants = await listGrants(w.db, w.org.id, { userId: m!.user_id });
	assert.equal(grants.length, 1);
	assert.equal(grants[0].source, 'idp');
	const oop = await outOfProcess(w.db, w.org.id, '2000-01-01', '2100-01-01');
	assert.ok(oop.recorded.some((e) => e.action === 'grant.detected' && /privileged/.test(e.summary)));

	// Removed from the group (Entra's filter path): the detected access ends.
	await w.scim('PATCH', `Groups/${(ghOwners.body as { id: string }).id}`, { Operations: [{ op: 'Remove', path: `members[value eq "${devId}"]` }] });
	grants = await listGrants(w.db, w.org.id, { userId: m!.user_id });
	assert.equal(grants.length, 0);

	// Deactivated in Entra ("False" as a string): offboarded, removals opened for what they hold.
	await w.db.run("INSERT INTO grants (id, org_id, user_id, resource_id, role_id, status, source, granted_at) VALUES ('g1', ?, ?, ?, ?, 'active', 'import', '2026-01-01')", [w.org.id, m!.user_id, w.resId, w.roles[0].id]);
	await w.scim('PATCH', `Users/${devId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
	assert.equal((await w.member(`dev-${w.tag}@acme.test`))?.status, 'deactivated');
	const removals = await listRequests(w.db, w.org.id, { userId: m!.user_id, kind: 'revoke' });
	assert.equal(removals.length, 1);
	assert.equal(removals[0].reason, 'directory');
	// Re-enabled in the IdP: back in.
	await w.scim('PATCH', `Users/${devId}`, { Operations: [{ op: 'replace', value: { active: true } }] });
	assert.equal((await w.member(`dev-${w.tag}@acme.test`))?.status, 'active');
	// Boss leaves ac-admins: their directory-granted admin role goes.
	await w.scim('PUT', `Groups/${(admins.body as { id: string }).id}`, { displayName: 'ac-admins', members: [] });
	assert.equal((await w.member(`boss-${w.tag}@acme.test`))?.role, 'member');
});

test('pulls: Google (JWT, pages, manager by email), Okta (Link pages), Microsoft (nextLink, manager by id)', async () => {
	const w = await world();
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const t = w.tag;
	const respond = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
	const calls: string[] = [];
	const fake: typeof fetch = async (input) => {
		const url = new URL(String(input));
		calls.push(url.host + url.pathname);
		if (url.host === 'oauth2.googleapis.com') return respond({ access_token: 'g' });
		if (url.pathname.endsWith('/users') && url.host === 'admin.googleapis.com') {
			return url.searchParams.get('pageToken')
				? respond({ users: [{ id: 'g2', primaryEmail: `ann-${t}@acme.test`, name: { fullName: 'Ann' }, relations: [{ type: 'manager', value: `bob-${t}@acme.test` }] }] })
				: respond({ users: [{ id: 'g1', primaryEmail: `bob-${t}@acme.test`, name: { fullName: 'Bob' }, organizations: [{ title: 'CTO', primary: true }] }], nextPageToken: 'p2' });
		}
		if (url.pathname.endsWith('/groups') && url.host === 'admin.googleapis.com') return respond({ groups: [{ id: 'grp1', email: 'eng@acme.test', name: 'Engineering' }] });
		if (url.pathname.includes('/members')) return respond({ members: [{ id: 'g2', type: 'USER' }, { id: 'x', type: 'GROUP' }] });
		if (url.host === 'acme.okta.com' && url.pathname === '/api/v1/users')
			return url.searchParams.get('after')
				? respond([{ id: 'o2', status: 'SUSPENDED', profile: { login: `sus-${t}@acme.test`, firstName: 'Sus' } }])
				: respond([{ id: 'o1', status: 'ACTIVE', profile: { login: `oli-${t}@acme.test`, email: `oli-${t}@acme.test`, firstName: 'Oli', lastName: 'O' } }], { link: '<https://acme.okta.com/api/v1/users?after=o1&limit=200>; rel="next"' });
		if (url.host === 'acme.okta.com' && url.pathname === '/api/v1/groups') return respond([{ id: 'everyone', type: 'BUILT_IN', profile: { name: 'Everyone' } }, { id: 'og', type: 'OKTA_GROUP', profile: { name: 'Admins' } }]);
		if (url.host === 'acme.okta.com') return respond([{ id: 'o1' }]);
		if (url.host === 'login.microsoftonline.com') return respond({ access_token: 'm' });
		if (url.pathname === '/v1.0/users')
			return url.searchParams.get('$skiptoken')
				? respond({ value: [{ id: 'm2', displayName: 'Mo', userPrincipalName: `mo-${t}@acme.test`, accountEnabled: true, manager: { id: 'm1' } }] })
				: respond({ value: [{ id: 'm1', displayName: 'Max', mail: `max-${t}@acme.test`, userPrincipalName: 'x', accountEnabled: true, jobTitle: 'VP' }, { id: 'guest', userType: 'Guest', userPrincipalName: 'g#EXT#' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=2' });
		if (url.pathname === '/v1.0/groups') return respond({ value: [{ id: 'mg', displayName: 'Finance' }] });
		if (url.pathname.includes('/transitiveMembers')) return respond({ value: [{ id: 'm2', '@odata.type': '#microsoft.graph.user' }] });
		return new Response('not found', { status: 404 });
	};

	await saveSource(w.db, w.org.id, { kind: 'google', config: { serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'sa@x.iam', private_key: pem }), adminEmail: 'admin@acme.test' }, onDeactivate: 'offboard', createMembers: true });
	const g = await syncDirectory(w.db, w.org.id, effects(), fake);
	assert.equal(g.created, 2);
	assert.equal((await w.member(`ann-${t}@acme.test`))?.manager_id, (await w.member(`bob-${t}@acme.test`))!.user_id);
	assert.equal((await w.member(`bob-${t}@acme.test`))?.title, 'CTO');
	assert.equal((await getSource(w.db, w.org.id))?.stats.groups, 1);

	await saveSource(w.db, w.org.id, { kind: 'okta', config: { domain: 'acme.okta.com', apiToken: 't' }, onDeactivate: 'deactivate', createMembers: true });
	await syncDirectory(w.db, w.org.id, effects(), fake);
	assert.equal((await w.member(`oli-${t}@acme.test`))?.status, 'active');
	assert.equal(await w.member(`sus-${t}@acme.test`), undefined, 'suspended users aren’t created');
	// Switching directories starts clean: Google's people aren't treated as removed.
	assert.equal((await w.member(`bob-${t}@acme.test`))?.status, 'active');
	// Within one directory, someone missing from the next pull is deactivated (per setting).
	const okta2: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.host === 'acme.okta.com' && url.pathname === '/api/v1/users') return respond([{ id: 'other', status: 'ACTIVE', profile: { login: `new-${t}@acme.test` } }]);
		return fake(input, init);
	};
	await syncDirectory(w.db, w.org.id, effects(), okta2);
	assert.equal((await w.member(`oli-${t}@acme.test`))?.status, 'deactivated');

	await saveSource(w.db, w.org.id, { kind: 'entra', config: { tenantId: 'tid', clientId: 'c', clientSecret: 's' }, onDeactivate: 'deactivate', createMembers: true });
	await syncDirectory(w.db, w.org.id, effects(), fake);
	assert.equal((await w.member(`mo-${t}@acme.test`))?.manager_id, (await w.member(`max-${t}@acme.test`))!.user_id);
	assert.ok(calls.some((c) => c.includes('transitiveMembers')));
});

test('SCIM (Authentik-style): username isn’t an email, updates are PUTs, groups are PATCHed, deletes remove', async () => {
	const w = await world();
	await saveSource(w.db, w.org.id, { kind: 'scim', config: {}, onDeactivate: 'offboard', createMembers: true });
	const ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
	// What Authentik's default user mapping sends, plus a custom title/manager mapping.
	const authentikUser = (username: string, email: string, active: boolean, extra: Record<string, unknown> = {}) => ({
		schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
		userName: username,
		name: { formatted: username.toUpperCase(), givenName: username, familyName: '' },
		displayName: username.toUpperCase(),
		active,
		emails: [{ value: email, type: 'other', primary: true }],
		externalId: `ak-${username}`,
		...extra
	});
	const lead = await w.scim('POST', 'Users', authentikUser('lead', `lead-${w.tag}@acme.test`, true));
	assert.equal(lead.status, 201);
	const ann = await w.scim('POST', 'Users', authentikUser('ann', `ann-${w.tag}@acme.test`, true, { title: 'SRE', [ENT]: { manager: { value: `lead-${w.tag}@acme.test` } } }));
	const annId = (ann.body as { id: string }).id;
	const m = await w.member(`ann-${w.tag}@acme.test`);
	assert.equal(m?.status, 'active', 'added under their email, not their username');
	assert.equal(m?.title, 'SRE');
	assert.equal(m?.manager_id, (await w.member(`lead-${w.tag}@acme.test`))!.user_id, 'manager given by email');

	// Groups: created with members, then changed with PATCH add/remove.
	const sre = await w.scim('POST', 'Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'sre', externalId: 'ak-sre', members: [] });
	const sreId = (sre.body as { id: string }).id;
	await addMapping(w.db, w.org.id, { groupId: sreId, target: 'access', resourceId: w.resId, roleId: w.roles[0].id });
	await w.scim('PATCH', `Groups/${sreId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'add', path: 'members', value: [{ value: annId }] }] });
	assert.equal((await listGrants(w.db, w.org.id, { userId: m!.user_id })).length, 1);
	await w.scim('PATCH', `Groups/${sreId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: 'members', value: [{ value: annId }] }] });
	assert.equal((await listGrants(w.db, w.org.id, { userId: m!.user_id })).length, 0);

	// Deactivated in Authentik: a full PUT with active false.
	assert.equal((await w.scim('PUT', `Users/${annId}`, authentikUser('ann', `ann-${w.tag}@acme.test`, false))).status, 200);
	assert.equal((await w.member(`ann-${w.tag}@acme.test`))?.status, 'deactivated');
	await w.scim('PUT', `Users/${annId}`, authentikUser('ann', `ann-${w.tag}@acme.test`, true));
	assert.equal((await w.member(`ann-${w.tag}@acme.test`))?.status, 'active');
	// Deleted in Authentik.
	const leadId = (lead.body as { id: string }).id;
	assert.equal((await w.scim('DELETE', `Users/${leadId}`)).status, 204);
	assert.equal((await w.member(`lead-${w.tag}@acme.test`))?.status, 'deactivated');
});
