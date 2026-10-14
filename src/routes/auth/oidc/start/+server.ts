import { redirect } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { beginLogin, orgForEmail } from '#lib/server/sso.ts';
import type { RequestHandler } from './$types';

/** /auth/oidc/start?org=<id|slug> or ?email=<address>, plus an optional &next=/path. */
export const GET: RequestHandler = async ({ cookies, url, locals }) => {
	const d = await db();
	const next = url.searchParams.get('next') ?? '/';
	const email = url.searchParams.get('email') ?? '';
	let orgId = url.searchParams.get('org') ?? '';
	if (orgId) orgId = (await d.get<{ id: string }>('SELECT id FROM orgs WHERE id = ? OR slug = ?', [orgId, orgId]))?.id ?? '';
	else if (email) orgId = (await orgForEmail(d, email)) ?? '';
	if (!orgId) redirect(303, `/login?error=${encodeURIComponent('No organisation uses single sign-on for that address.')}`);
	let target: URL;
	try {
		target = await beginLogin(d, cookies, orgId, locals.origin, next, locals.secure, email || undefined);
	} catch (err) {
		redirect(303, `/login?error=${encodeURIComponent(`Couldn’t reach the identity provider: ${(err as Error).message}`)}`);
	}
	// The provider's authorization endpoint comes from OIDC discovery, so it's a trusted external URL.
	redirect(303, target.href, { external: true });
};
