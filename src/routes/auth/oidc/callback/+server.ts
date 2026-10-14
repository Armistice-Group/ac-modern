import { redirect } from '@sveltejs/kit';
import { endSession, startSession } from '#lib/server/auth.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { completeLogin, LoginRefused } from '#lib/server/sso.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url, locals }) => {
	const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
	if (providerError) redirect(303, `/login?error=${encodeURIComponent(providerError)}`);
	const d = await db();
	let next = '/';
	try {
		const r = await completeLogin(d, cookies, url, locals.origin);
		// A password session (e.g. bounced here by "require SSO") is replaced by the SSO one.
		await endSession(cookies);
		await startSession(cookies, r.userId, r.orgId, locals.secure, 'sso');
		await record(d, { orgId: r.orgId, actorId: r.userId, action: 'auth.sso', summary: 'Signed in with single sign-on' });
		next = r.next;
	} catch (err) {
		const message = err instanceof LoginRefused ? err.message : `Sign-in failed: ${(err as Error).message}`;
		redirect(303, `/login?error=${encodeURIComponent(message)}`);
	}
	redirect(303, next.startsWith('/') && !next.startsWith('//') ? next : '/');
};
