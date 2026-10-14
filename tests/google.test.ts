import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { googleHint, parseServiceAccountKey } from '../src/lib/google.ts';
import { pullGoogle } from '../src/lib/server/idp/google.ts';

test('Google setup: pasted keys are recognised, and the wrong file says what it is', () => {
	assert.match((parseServiceAccountKey('not json') as { error: string }).error, /JSON key file/);
	assert.match((parseServiceAccountKey('{"web":{"client_id":"x"}}') as { error: string }).error, /OAuth client/);
	assert.match((parseServiceAccountKey('{"type":"authorized_user"}') as { error: string }).error, /service account key/);
	const key = parseServiceAccountKey(JSON.stringify({ type: 'service_account', client_id: '1234', client_email: 'sa@p.iam.gserviceaccount.com', private_key: 'k', project_id: 'p' }));
	assert.deepEqual(key, { clientId: '1234', clientEmail: 'sa@p.iam.gserviceaccount.com', projectId: 'p', privateKey: 'k' });
	assert.equal(googleHint('something else'), '');
});

test('Google setup: errors name the step that fixes them', async () => {
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const cfg = {
		serviceAccountJson: JSON.stringify({ type: 'service_account', client_id: '1187', client_email: 'sa@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
		adminEmail: 'admin@acme.test'
	};
	const failWith = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const token: typeof fetch = async (input) =>
		String(input).includes('oauth2')
			? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
			: new Response(JSON.stringify({ error: { message: 'Admin SDK API has not been used in project 42 before or it is disabled.' } }), { status: 403 });

	await assert.rejects(pullGoogle(cfg, failWith(401, { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.' })), /delegation.*client ID 1187/);
	await assert.rejects(pullGoogle(cfg, failWith(400, { error: 'invalid_grant', error_description: 'Invalid email or User ID' })), /real user in your Workspace/);
	await assert.rejects(pullGoogle(cfg, token), /Turn on the Admin SDK API/);
	await assert.rejects(pullGoogle({ ...cfg, adminEmail: 'SA@p.iam.gserviceaccount.com' }, token), /not the service account’s/);
});
