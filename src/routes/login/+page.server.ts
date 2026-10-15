import { brandForIssuer } from '#lib/brands.ts';
import type { Brand } from '#lib/components/BrandLogo.svelte';
import { redirect } from '@sveltejs/kit';
import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db.ts';
import { ssoSettings } from '#lib/server/sso.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.auth === 'setup') redirect(303, '/setup');
	if (locals.user && locals.org && !locals.ssoRequired) redirect(303, '/');
	const error = url.searchParams.get('error') === 'removed' ? 'Your account isn’t part of an organisation any more. Ask an admin to invite you again.' : (url.searchParams.get('error') ?? '');
	let sso: { name: string; href: string; brand: Brand | null } | null = null;
	if (config.mode !== 'cloud') {
		const d = await db();
		const org = await d.get<{ id: string }>('SELECT id FROM orgs ORDER BY created_at LIMIT 1');
		const s = org ? await ssoSettings(d, org.id) : null;
		if (s) sso = { name: s.name, href: `/auth/oidc/start?org=${org!.id}`, brand: brandForIssuer(s.issuer, s.name) };
	}
	return { cloud: config.mode === 'cloud', error, sso, ssoRequired: !!locals.ssoRequired, publicUrl: config.publicUrl };
};
