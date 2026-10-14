import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { config } from '../src/lib/server/config.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { addDomain, domains, orgForEmail, saveSso, verifyDomain } from '../src/lib/server/sso.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

test('cloud: domains count only once verified by DNS, and only one org can claim one', async () => {
	const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
	setDb(db);
	const mode = config.mode;
	(config as { mode: string }).mode = 'cloud';
	try {
		const tag = Math.random().toString(36).slice(2, 8);
		const dom = `acme-${tag}.example`;
		const { org: a } = await setupOrg({ orgName: 'A', email: `a${tag}@${dom}`, name: 'A', password: 'password123' });
		const { org: b } = await setupOrg({ orgName: 'B', email: `b${tag}@other.example`, name: 'B', password: 'password123' });
		await addDomain(db, a.id, dom);
		await assert.rejects(addDomain(db, b.id, dom), /Another organisation/);
		assert.equal(await orgForEmail(db, `x@${dom}`), null, 'unverified');
		await assert.rejects(saveSso(db, a.id, { issuer: 'https://idp.example', clientId: 'c', name: 'Okta', scopes: '', autoCreate: true, required: true }), /verified email domain/);
		const [d] = await domains(db, a.id);
		await assert.rejects(verifyDomain(db, a.id, dom, async () => [['something-else']]), /TXT record/);
		await verifyDomain(db, a.id, dom, async () => [[d.record.slice(0, 10), d.record.slice(10)]]);
		assert.equal(await orgForEmail(db, `x@${dom.toUpperCase()}`), a.id);
		await saveSso(db, a.id, { issuer: 'https://idp.example', clientId: 'c', name: 'Okta', scopes: '', autoCreate: true, required: true });
		await assert.rejects(saveSso(db, a.id, { issuer: 'http://idp.example', clientId: 'c', name: 'Okta', scopes: '', autoCreate: true, required: false }), /https/);
	} finally {
		(config as { mode: string }).mode = mode;
	}
});

test('SSO discovery failures say what to change', async () => {
	const { discoveryProblem } = await import('../src/lib/server/sso.ts');
	const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
	assert.match(discoveryProblem(fetchFailed('ENOTFOUND'), 'https://auth.acme.test/application/o/acm/'), /can’t look up auth\.acme\.test/);
	assert.match(discoveryProblem(fetchFailed('ECONNREFUSED'), 'https://auth.acme.test'), /can’t connect.*ECONNREFUSED/);
	assert.match(discoveryProblem(fetchFailed('SELF_SIGNED_CERT_IN_CHAIN'), 'https://auth.acme.test'), /NODE_EXTRA_CA_CERTS/);
	const notFound = Object.assign(new Error('unexpected HTTP response status code'), { code: 'OAUTH_RESPONSE_IS_NOT_CONFORM', cause: new Response('', { status: 404 }) });
	assert.match(discoveryProblem(notFound, 'https://auth.acme.test/'), /https:\/\/auth\.acme\.test\/\.well-known\/openid-configuration answered HTTP 404/);
	const mismatch = Object.assign(new Error('discovered metadata issuer does not match'), { code: 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED', cause: { body: { issuer: 'https://auth.acme.test/application/o/acm/' } } });
	assert.match(discoveryProblem(mismatch, 'https://auth.acme.test/application/o/acm'), /calls itself https:\/\/auth\.acme\.test\/application\/o\/acm\/\./);
});
