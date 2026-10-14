import { resolve } from 'node:path';

const env = process.env;

function list(v: string | undefined): string[] {
	return (v ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Everything ac·modern reads from the environment. Self-hosted (the default) runs one
 * organisation on SQLite; cloud mode lets anyone sign up and create their own
 * organisation, and is meant for Postgres (ACM_DATABASE_URL).
 */
export const config = {
	mode: (env.ACM_MODE === 'cloud' ? 'cloud' : 'self-hosted') as 'cloud' | 'self-hosted',
	dataDir: resolve(env.ACM_DATA_DIR ?? './data'),
	/** postgres://… uses Postgres; otherwise SQLite in the data folder. */
	databaseUrl: env.ACM_DATABASE_URL || env.DATABASE_URL || '',
	secretKey: env.ACM_SECRET_KEY || '',
	/** Used in links sent by email and Slack. Falls back to the address of the request that triggered them. */
	publicUrl: (env.ACM_PUBLIC_URL || env.ORIGIN || '').replace(/\/+$/, ''),
	bootstrapAdmin:
		env.ACM_ADMIN_EMAIL && env.ACM_ADMIN_PASSWORD
			? { email: env.ACM_ADMIN_EMAIL, password: env.ACM_ADMIN_PASSWORD, name: env.ACM_ADMIN_NAME || '', org: env.ACM_ORG_NAME || 'My team' }
			: null,
	/** Cloud mode: who may create a new organisation from /signup (empty = anyone). */
	signupAllow: list(env.ACM_SIGNUP_ALLOW),
	smtp: env.ACM_SMTP_URL ? { url: env.ACM_SMTP_URL, from: env.ACM_SMTP_FROM || 'ac·modern <no-reply@localhost>' } : null,
	/** Self-hosted: SSO from the environment (overrides the Settings page). */
	oidc: env.ACM_OIDC_ISSUER
		? {
				issuer: env.ACM_OIDC_ISSUER,
				clientId: env.ACM_OIDC_CLIENT_ID || '',
				clientSecret: env.ACM_OIDC_CLIENT_SECRET || '',
				name: env.ACM_OIDC_NAME || 'SSO',
				scopes: env.ACM_OIDC_SCOPES || 'openid email profile',
				domains: list(env.ACM_OIDC_DOMAINS),
				required: env.ACM_OIDC_REQUIRED === 'true'
			}
		: null,
	/** How often Google/Okta/Microsoft directories are pulled. */
	directorySyncMinutes: Number(env.ACM_DIRECTORY_SYNC_MINUTES || 30),
	/** Cloud: one Slack app for every org ("Add to Slack"). Self-hosted orgs create their own from a manifest. */
	slackApp: env.ACM_SLACK_CLIENT_ID
		? { clientId: env.ACM_SLACK_CLIENT_ID, clientSecret: env.ACM_SLACK_CLIENT_SECRET || '', signingSecret: env.ACM_SLACK_SIGNING_SECRET || '' }
		: null,
	/** How often expiry and reminder jobs run. */
	jobIntervalMs: Number(env.ACM_JOB_INTERVAL_SECONDS || 60) * 1000
};

export const isCloud = () => config.mode === 'cloud';
