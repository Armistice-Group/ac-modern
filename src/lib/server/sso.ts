import { resolveTxt } from 'node:dns/promises';
import type { Cookies } from '@sveltejs/kit';
import * as client from 'openid-client';
import { addMember, createUser, EMAIL_RE, membership, normEmail, userByEmail } from './accounts.ts';
import { config, isCloud } from './config.ts';
import { decrypt, encrypt, randomToken } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, conflict } from './http.ts';
import { getBilling } from './billing.ts';

/**
 * Single sign-on, per organisation. Each org registers its own OIDC app and claims email
 * domains; in cloud mode a domain must be verified (DNS TXT) before sign-ins from it are
 * trusted. Self-hosted installs can configure the one org from ACM_OIDC_* instead.
 */
export interface SsoSettings {
	orgId: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
	name: string;
	scopes: string;
	autoCreate: boolean;
	required: boolean;
	source: 'env' | 'ui';
}

const FLOW_COOKIE = 'acm_oidc';
const now = () => new Date().toISOString();

/** The single org a self-hosted install runs, if ACM_OIDC_* applies to it. */
async function envOrgId(db: Db): Promise<string | null> {
	if (!config.oidc || isCloud()) return null;
	return (await db.get<{ id: string }>('SELECT id FROM orgs ORDER BY created_at LIMIT 1'))?.id ?? null;
}

export async function ssoSettings(db: Db, orgId: string): Promise<SsoSettings | null> {
	if (config.oidc && (await envOrgId(db)) === orgId) {
		const o = config.oidc;
		return { orgId, issuer: o.issuer, clientId: o.clientId, clientSecret: o.clientSecret, name: o.name, scopes: o.scopes, autoCreate: true, required: o.required, source: 'env' };
	}
	const r = await db.get<{ issuer: string; client_id: string; client_secret: string; name: string; scopes: string; auto_create: number; required: number }>(
		'SELECT issuer, client_id, client_secret, name, scopes, auto_create, required FROM org_sso WHERE org_id = ?',
		[orgId]
	);
	if (!r) return null;
	return {
		orgId,
		issuer: r.issuer,
		clientId: r.client_id,
		clientSecret: r.client_secret ? decrypt(r.client_secret, `org:${orgId}:oidc`) : '',
		name: r.name,
		scopes: r.scopes,
		autoCreate: !!r.auto_create,
		required: !!r.required,
		source: 'ui'
	};
}

export async function saveSso(
	db: Db,
	orgId: string,
	input: { issuer: string; clientId: string; clientSecret?: string; name: string; scopes: string; autoCreate: boolean; required: boolean }
) {
	let issuer: URL;
	try {
		issuer = new URL(input.issuer);
	} catch {
		throw badRequest('The issuer must be a URL, e.g. https://acme.okta.com');
	}
	if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && !isCloud())) throw badRequest('The issuer must use https');
	if (!input.clientId) throw badRequest('Enter the client ID');
	if (input.required && !(await domains(db, orgId)).some((d) => d.verified)) throw badRequest('Add a verified email domain before requiring SSO');
	const existing = await db.get<{ client_secret: string }>('SELECT client_secret FROM org_sso WHERE org_id = ?', [orgId]);
	const secret = input.clientSecret === undefined ? (existing?.client_secret ?? '') : input.clientSecret ? encrypt(input.clientSecret, `org:${orgId}:oidc`) : '';
	await db.run(
		`INSERT INTO org_sso (org_id, issuer, client_id, client_secret, name, scopes, auto_create, required, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (org_id) DO UPDATE SET issuer = excluded.issuer, client_id = excluded.client_id, client_secret = excluded.client_secret, name = excluded.name,
		 scopes = excluded.scopes, auto_create = excluded.auto_create, required = excluded.required, updated_at = excluded.updated_at`,
		[orgId, issuer.href.replace(/\/$/, ''), input.clientId, secret, input.name || 'SSO', input.scopes || 'openid email profile', input.autoCreate, input.required, now()]
	);
	discovered.delete(orgId);
}

export async function deleteSso(db: Db, orgId: string) {
	await db.run('DELETE FROM org_sso WHERE org_id = ?', [orgId]);
	discovered.delete(orgId);
}

// ── Domains ──────────────────────────────────────────────────────────────────

export async function domains(db: Db, orgId: string) {
	const rows = await db.all<{ domain: string; token: string; verified_at: string | null }>('SELECT domain, token, verified_at FROM org_domains WHERE org_id = ? ORDER BY domain', [orgId]);
	const env = config.oidc && (await envOrgId(db)) === orgId ? config.oidc.domains : [];
	return [
		...rows.map((r) => ({ domain: r.domain, record: `ac-modern-verification=${r.token}`, verified: !!r.verified_at || !isCloud() })),
		...env.filter((d) => !rows.some((r) => r.domain === d)).map((d) => ({ domain: d.toLowerCase(), record: '', verified: true }))
	];
}

export async function addDomain(db: Db, orgId: string, raw: string) {
	const domain = raw.trim().toLowerCase().replace(/^@/, '');
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw badRequest('Enter a domain like acme.com');
	const taken = await db.get<{ org_id: string }>('SELECT org_id FROM org_domains WHERE domain = ?', [domain]);
	if (taken && taken.org_id !== orgId) throw conflict('Another organisation has claimed that domain');
	if (taken) return;
	await db.run('INSERT INTO org_domains (domain, org_id, token, verified_at, created_at) VALUES (?, ?, ?, ?, ?)', [domain, orgId, randomToken(16), isCloud() ? null : now(), now()]);
}

export async function removeDomain(db: Db, orgId: string, domain: string) {
	await db.run('DELETE FROM org_domains WHERE org_id = ? AND domain = ?', [orgId, domain]);
}

/** Cloud: proves the org controls the domain via a TXT record. */
export async function verifyDomain(db: Db, orgId: string, domain: string, lookup: (d: string) => Promise<string[][]> = resolveTxt) {
	const row = await db.get<{ token: string }>('SELECT token FROM org_domains WHERE org_id = ? AND domain = ?', [orgId, domain]);
	if (!row) throw badRequest('Add the domain first');
	let records: string[][] = [];
	try {
		records = await lookup(domain);
	} catch {
		records = [];
	}
	const want = `ac-modern-verification=${row.token}`;
	if (!records.some((parts) => parts.join('') === want)) throw badRequest(`Couldn’t find the TXT record “${want}” on ${domain} yet. DNS can take a few minutes.`);
	await db.run('UPDATE org_domains SET verified_at = ? WHERE org_id = ? AND domain = ?', [now(), orgId, domain]);
}

/** The org whose SSO handles this email address (verified domains only). */
export async function orgForEmail(db: Db, email: string): Promise<string | null> {
	const domain = normEmail(email).split('@')[1] ?? '';
	if (!domain) return null;
	const row = await db.get<{ org_id: string; verified_at: string | null }>('SELECT org_id, verified_at FROM org_domains WHERE domain = ?', [domain]);
	if (row && (row.verified_at || !isCloud())) return row.org_id;
	const env = await envOrgId(db);
	if (env && config.oidc!.domains.map((d) => d.toLowerCase()).includes(domain)) return env;
	return null;
}

// ── The login flow ───────────────────────────────────────────────────────────

const discovered = new Map<string, { key: string; config: Promise<client.Configuration> }>();

function configuration(s: SsoSettings): Promise<client.Configuration> {
	const key = JSON.stringify([s.issuer, s.clientId, s.clientSecret]);
	const hit = discovered.get(s.orgId);
	if (hit?.key === key) return hit.config;
	const issuer = new URL(s.issuer);
	const options = issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined;
	const pending = client.discovery(issuer, s.clientId, s.clientSecret || undefined, undefined, options).catch((err) => {
		if (discovered.get(s.orgId)?.config === pending) discovered.delete(s.orgId);
		throw err;
	});
	discovered.set(s.orgId, { key, config: pending });
	return pending;
}

/** Checks discovery works (Settings → Test). */
export async function testSso(s: SsoSettings) {
	discovered.delete(s.orgId);
	const cfg = await configuration(s);
	return { issuer: cfg.serverMetadata().issuer };
}

export const redirectUri = (origin: string) => `${origin}/auth/oidc/callback`;

export async function beginLogin(db: Db, cookies: Cookies, orgId: string, origin: string, next: string, secure: boolean, loginHint?: string): Promise<URL> {
	const s = await ssoSettings(db, orgId);
	if (!s) throw badRequest('Single sign-on isn’t set up for this organisation');
	const cfg = await configuration(s);
	const verifier = client.randomPKCECodeVerifier();
	const flow = { orgId, verifier, state: client.randomState(), nonce: client.randomNonce(), next };
	cookies.set(FLOW_COOKIE, encrypt(JSON.stringify(flow), 'oidc-flow'), { path: '/auth/oidc', httpOnly: true, sameSite: 'lax', secure, maxAge: 600 });
	return client.buildAuthorizationUrl(cfg, {
		redirect_uri: redirectUri(origin),
		scope: s.scopes,
		code_challenge: await client.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256',
		state: flow.state,
		nonce: flow.nonce,
		...(loginHint ? { login_hint: loginHint } : {})
	});
}

export class LoginRefused extends Error {}

/**
 * Finishes the code exchange and finds (or, when allowed, creates) the member. A known
 * subject wins; otherwise the email must be on one of the org's verified domains, or
 * belong to someone already in the org (e.g. invited by email).
 */
export async function completeLogin(db: Db, cookies: Cookies, currentUrl: URL, origin: string): Promise<{ userId: string; orgId: string; next: string }> {
	const raw = cookies.get(FLOW_COOKIE);
	cookies.delete(FLOW_COOKIE, { path: '/auth/oidc' });
	if (!raw) throw new LoginRefused('Sign-in session expired. Please try again.');
	const flow = JSON.parse(decrypt(raw, 'oidc-flow')) as { orgId: string; verifier: string; state: string; nonce: string; next: string };
	const s = await ssoSettings(db, flow.orgId);
	if (!s) throw new LoginRefused('Single sign-on was turned off for this organisation.');
	const cfg = await configuration(s);
	const callback = new URL(redirectUri(origin));
	callback.search = currentUrl.search;
	const tokens = await client.authorizationCodeGrant(cfg, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
	let claims: Record<string, unknown> = { ...tokens.claims() };
	if (!claims.email) claims = { ...claims, ...(await client.fetchUserInfo(cfg, tokens.access_token, claims.sub as string)) };
	const sub = String(claims.sub);
	const email = typeof claims.email === 'string' ? normEmail(claims.email) : '';
	const name = String(claims.name ?? claims.preferred_username ?? '');
	if (!email || !EMAIL_RE.test(email)) throw new LoginRefused('Your identity provider didn’t share an email address (add the “email” scope).');
	if (claims.email_verified === false) throw new LoginRefused(`${email} isn’t verified with your identity provider.`);

	const linked = await db.get<{ user_id: string }>('SELECT user_id FROM user_identities WHERE org_id = ? AND sub = ?', [flow.orgId, sub]);
	let userId = linked?.user_id;
	if (!userId) {
		const domainOrg = await orgForEmail(db, email);
		const existing = await userByEmail(db, email);
		const member = existing ? await membership(db, flow.orgId, existing.id) : undefined;
		if (!member && domainOrg !== flow.orgId) throw new LoginRefused(`${email} isn’t on one of this organisation’s domains. Ask an admin to invite you.`);
		if (!member && !s.autoCreate) throw new LoginRefused(`${email} doesn’t have an account yet. Ask an admin to invite you.`);
		if (!member && !(await getBilling(db, flow.orgId)).canGrow) throw new LoginRefused('This organisation has used all the seats on its plan. Ask an admin to upgrade.');
		userId = existing?.id ?? (await createUser(db, { email, name, passwordHash: null })).id;
		if (!member) {
			const prior = await db.get<{ status: string }>('SELECT status FROM members WHERE org_id = ? AND user_id = ?', [flow.orgId, userId]);
			// Offboarded people stay out, even if the IdP still lets them in.
			if (prior?.status === 'deactivated') throw new LoginRefused(`${email} has been offboarded from this organisation.`);
			await addMember(db, flow.orgId, userId, 'member');
			await record(db, { orgId: flow.orgId, actorId: userId, action: 'member.joined', subject: email, summary: `${email} joined through single sign-on` });
		}
		await db.run('INSERT INTO user_identities (org_id, sub, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, sub) DO NOTHING', [flow.orgId, sub, userId, now()]);
	}
	const m = await membership(db, flow.orgId, userId);
	if (!m) throw new LoginRefused(`${email} has been offboarded from this organisation.`);
	if (name) await db.run("UPDATE users SET name = ? WHERE id = ? AND name = ''", [name, userId]);
	return { userId, orgId: flow.orgId, next: flow.next };
}
