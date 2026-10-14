import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import { domains, redirectUri, ssoSettings } from '#lib/server/sso.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	const s = await ssoSettings(d, c.org.id);
	return {
		sso: s ? { issuer: s.issuer, clientId: s.clientId, hasSecret: !!s.clientSecret, name: s.name, scopes: s.scopes, autoCreate: s.autoCreate, required: s.required, source: s.source } : null,
		domains: await domains(d, c.org.id),
		redirectUri: redirectUri(locals.origin),
		cloud: config.mode === 'cloud',
		loginUrl: `${locals.origin}/auth/oidc/start?org=${c.org.slug}`
	};
};
