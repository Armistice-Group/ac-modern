import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { addMember, createUser, updateMember, updateUser } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { saveResource, type ResourceInput } from '../src/lib/server/resources.ts';
import { listGrants, recordGrant } from '../src/lib/server/grants.ts';
import { saveIntegration } from '../src/lib/server/integrations.ts';
import { listEvents } from '../src/lib/server/events.ts';
import { getReconciliation, listReconciliations, parseAccounts, parseCsv, pullAccounts, reconciliationCsv, reconciliationItems, resolveItem, runReconciliation } from '../src/lib/server/reconcile.ts';
import { getResource } from '../src/lib/server/resources.ts';
import { handleV1 } from '../src/lib/server/api-v1.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

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
	const ana = await mk('ana');
	const ben = await mk('ben');
	const cy = await mk('cy');
	const dee = await mk('dee');
	const base: ResourceInput = {
		name: 'Stripe', description: '', category: 'app', url: '', color: 'violet', ownerId: owner.id, approval: 'approvers', fulfillment: 'manual', webhookUrl: '',
		maxDays: null, defaultDays: null, requestable: true, approverIds: [owner.id], fulfillerIds: [owner.id],
		roles: [{ name: 'Viewer', description: '', privileged: false }, { name: 'Admin', description: '', privileged: true }]
	};
	const res = await saveResource(db, org.id, null, base);
	const roles = await db.all<{ id: string; name: string }>('SELECT id, name FROM resource_roles WHERE resource_id = ? ORDER BY position', [res]);
	const A = { orgId: org.id, userId: owner.id, admin: true };
	const grant = (u: { id: string }, role: number) => recordGrant(db, A, { userId: u.id, resourceId: res, roleId: roles[role].id, expiresAt: null, note: 'baseline', source: 'import' });
	return { db, org, owner, ana, ben, cy, dee, res, roles, A, grant, tag, base };
}

test('CSV exports: headers, separators, quotes, no header at all', () => {
	assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1;2,3\n'), [['a', 'b, c', 'say "hi"'], ['1;2', '3']]);
	assert.deepEqual(parseCsv('email;role\nx@y.z;Admin'), [['email', 'role'], ['x@y.z', 'Admin']]);

	const stripe = parseAccounts('﻿Name,Email,Role,Last login\nAna,ANA@acme.test,Administrator,2026-01-01\nBob,bob@acme.test,View only;Developer,');
	assert.deepEqual(stripe.columns, { email: 'Email', login: undefined, level: 'Role', name: 'Name' });
	assert.deepEqual(stripe.accounts[0], { email: 'ana@acme.test', login: undefined, name: 'Ana', levels: ['Administrator'] });
	assert.deepEqual(stripe.accounts[1].levels, ['View only', 'Developer']);

	const gh = parseAccounts('login\noctocat\nhubot\n');
	assert.equal(gh.columns.login, 'login');
	assert.deepEqual(gh.accounts.map((a) => a.login), ['octocat', 'hubot']);
	const headless = parseAccounts('octocat\nhubot\n');
	assert.deepEqual(headless.accounts.map((a) => a.login), ['octocat', 'hubot'], 'no header: the first row is an account too');

	const bare = parseAccounts('ana@acme.test\nben@acme.test\n');
	assert.deepEqual(bare.accounts.map((a) => a.email), ['ana@acme.test', 'ben@acme.test']);
	const upn = parseAccounts('User principal name,Display name\nana@acme.test,Ana');
	assert.equal(upn.accounts[0].email, 'ana@acme.test');
	assert.throws(() => parseAccounts('First,Last\nAna,Smith'), /email or username column/);
	assert.throws(() => parseAccounts(''), /empty/);
});

test('reconciliation: matched, not in ac·modern, not in the system, different level; each resolution', async () => {
	const w = await world();
	await w.grant(w.ana, 0); // matched
	await w.grant(w.ben, 0); // system says Admin → level mismatch
	await w.grant(w.cy, 0); // not in the system → missing
	await updateMember(w.db, w.org.id, w.dee.id, { status: 'deactivated' });
	await updateUser(w.db, w.ana.id, { githubLogin: 'ana-gh' });
	const csv = `email,login,role\n${w.ana.email.toUpperCase()},,Viewer\n,ana-gh,Viewer\n${w.ben.email},,Admin\n${w.dee.email},,Viewer\nbot@acme.test,,Admin\n`;
	const { accounts } = parseAccounts(csv);
	const id = await runReconciliation(w.db, w.A, w.res, { source: 'csv', filename: 'stripe-users.csv', accounts });
	const run = await getReconciliation(w.db, w.org.id, id);
	assert.deepEqual(run.counts, { accounts: 4, matched: 1, unknown: 2, missing: 1, level_mismatch: 1 });
	assert.equal(run.unresolved, 4);
	const items = await reconciliationItems(w.db, w.org.id, id);
	const by = (s: string) => items.find((i) => i.account.toLowerCase().startsWith(s))!;
	assert.equal(by('ana').status, 'matched', 'email and GitHub username are the same person');
	assert.deepEqual([by('ben').status, by('ben').level, by('ben').detail], ['level_mismatch', 'Admin', 'ac·modern records Viewer']);
	assert.deepEqual([by('cy').status, by('cy').level], ['missing', 'Viewer']);
	assert.deepEqual([by('dee').status, by('dee').user?.member, by('dee').detail], ['unknown', 'deactivated', 'Deactivated in ac·modern: they still have an account here']);
	assert.deepEqual([by('bot').status, by('bot').user, by('bot').detail], ['unknown', null, 'Not a member of ac·modern']);

	await assert.rejects(resolveItem(w.db, w.A, by('ana').id, { resolution: 'kept', note: 'fine' }), /need nothing/);
	await assert.rejects(resolveItem(w.db, w.A, by('bot').id, { resolution: 'recorded', note: 'xx' }), /Say why/);
	await assert.rejects(resolveItem(w.db, w.A, by('bot').id, { resolution: 'recorded', note: 'billing bot' }), /isn’t a member/);
	await assert.rejects(resolveItem(w.db, w.A, by('cy').id, { resolution: 'service_account', note: 'nope' }), /doesn’t apply/);
	await resolveItem(w.db, w.A, by('bot').id, { resolution: 'service_account', note: 'Billing export bot, owned by Finance' });
	await resolveItem(w.db, w.A, by('dee').id, { resolution: 'removed_in_system', note: 'Deleted her Stripe user today' });
	await resolveItem(w.db, w.A, by('ben').id, { resolution: 'recorded', note: 'Approved by CFO in March', roleId: w.roles[1].id });
	await resolveItem(w.db, w.A, by('cy').id, { resolution: 'closed', note: 'Left the finance team in May' });
	await assert.rejects(resolveItem(w.db, w.A, by('cy').id, { resolution: 'kept', note: 'again' }), /already resolved/);

	const grants = await listGrants(w.db, w.org.id, { resourceId: w.res });
	assert.deepEqual(grants.map((g) => `${g.user.name}:${g.role.name}:${g.source}`).sort(), ['ana:Viewer:import', 'ben:Admin:import', 'ben:Viewer:import']);
	const events = await listEvents(w.db, w.org.id);
	assert.ok(events.some((e) => e.action === 'grant.closed' && /cy’s Stripe \(Viewer\)/.test(e.summary)));
	assert.ok(events.some((e) => e.action === 'reconciliation.run' && /stripe-users.csv: 4 accounts, 1 matched, 2 not in ac·modern, 1 not in the system, 1 with a different level/.test(e.summary)));
	assert.equal(events.filter((e) => e.action === 'reconciliation.resolved').length, 4);
	assert.equal((await getReconciliation(w.db, w.org.id, id)).unresolved, 0);

	const csvOut = reconciliationCsv(run, await reconciliationItems(w.db, w.org.id, id));
	assert.match(csvOut, /"Stripe",".*","uploaded list","stripe-users.csv","Olive","bot@acme.test","","","In the system, not in ac·modern","Admin","Not a member of ac·modern","Service or shared account","Olive"/);

	// "Keep" on a missing record; a record with a removal under way can't be closed.
	const second = await runReconciliation(w.db, w.A, w.res, { source: 'csv', filename: '', accounts: [] });
	const missing = (await reconciliationItems(w.db, w.org.id, second)).filter((i) => i.status === 'missing');
	assert.equal(missing.length, 3);
	await resolveItem(w.db, w.A, missing[0].id, { resolution: 'kept', note: 'SSO-only, not listed in export' });
	assert.equal((await listReconciliations(w.db, w.org.id, { resourceId: w.res })).length, 2);

	const list = (await handleV1(w.db, w.org.id, ['reconciliations'], new URLSearchParams())).body as { data: { id: string; unresolved: number }[] };
	assert.equal(list.data.length, 2);
	const one = (await handleV1(w.db, w.org.id, ['reconciliations', id], new URLSearchParams())).body as { data: { items: { status: string; resolution: string | null }[] } };
	assert.deepEqual(one.data.items.map((i) => i.resolution).filter(Boolean).sort(), ['closed', 'recorded', 'removed_in_system', 'service_account']);
	assert.equal((await handleV1(w.db, w.org.id, ['reconciliations', 'nope'], new URLSearchParams())).status, 404);
});

test('pull from Okta: members of each mapped group become the system’s list', async () => {
	const w = await world();
	await saveIntegration(w.db, w.org.id, 'okta', { domain: 'acme.okta.com', apiToken: 't' });
	const id = await saveResource(w.db, w.org.id, null, {
		...w.base,
		name: 'Datadog',
		fulfillment: 'integration',
		integration: 'okta',
		integrationMap: { '#0': { type: 'okta_group', id: 'g-view', name: 'dd-viewers' }, '#1': { type: 'okta_app', id: 'app-dd', name: 'Datadog' } }
	});
	const roles = await w.db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [id]);
	await recordGrant(w.db, w.A, { userId: w.ana.id, resourceId: id, roleId: roles[0].id, expiresAt: null, note: 'baseline', source: 'import' });
	const urls: string[] = [];
	const f = (async (input: string | URL) => {
		const u = new URL(String(input));
		urls.push(u.pathname);
		if (u.pathname === '/api/v1/groups/g-view/users') {
			if (!u.searchParams.has('after'))
				return respond(200, [{ id: '1', status: 'ACTIVE', profile: { login: w.ana.email, email: w.ana.email } }], { link: `<https://acme.okta.com/api/v1/groups/g-view/users?after=1>; rel="next"` });
			return respond(200, [{ id: '2', status: 'ACTIVE', profile: { login: 'eve@acme.test', email: 'eve@acme.test' } }]);
		}
		if (u.pathname === '/api/v1/apps/app-dd/users') return respond(200, [{ credentials: { userName: w.ben.email }, _embedded: { user: { id: '3', status: 'ACTIVE', profile: { login: w.ben.email, email: w.ben.email } } } }]);
		return respond(404, { errorSummary: 'nope' });
	}) as typeof fetch;
	const accounts = await pullAccounts(w.db, w.org.id, await getResource(w.db, w.org.id, id), f);
	assert.deepEqual(accounts.map((a) => [a.email, a.levels]), [[w.ana.email, ['Viewer']], ['eve@acme.test', ['Viewer']], [w.ben.email, ['Admin']]]);
	const run = await runReconciliation(w.db, w.A, id, { source: 'idp', filename: '', accounts });
	assert.deepEqual((await getReconciliation(w.db, w.org.id, run)).counts, { accounts: 3, matched: 1, unknown: 2, missing: 0, level_mismatch: 0 });
	assert.ok((await listEvents(w.db, w.org.id)).some((e) => /Reconciled Datadog with Okta/.test(e.summary)));

	await assert.rejects(pullAccounts(w.db, w.org.id, await getResource(w.db, w.org.id, w.res), f), /isn’t set up through an integration/);
});
