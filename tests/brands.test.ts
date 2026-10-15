import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandForIssuer } from '../src/lib/brands.ts';

test('SSO button logo follows the issuer', () => {
	assert.equal(brandForIssuer('https://sso.armgrp.dev/application/o/ac-modern/'), 'authentik');
	assert.equal(brandForIssuer('https://acme.okta.com'), 'okta');
	assert.equal(brandForIssuer('https://login.microsoftonline.com/abc/v2.0'), 'entra');
	assert.equal(brandForIssuer('https://accounts.google.com'), 'google');
	assert.equal(brandForIssuer('https://auth.example.com/realms/main', 'Keycloak'), null);
	assert.equal(brandForIssuer('https://auth.example.com', 'Okta'), 'okta');
});
