import { json, redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { authenticate } from '#lib/server/auth.ts';
import { config, isCloud } from '#lib/server/config.ts';
import { startJobs } from '#lib/server/jobs.ts';
import { publicUrl } from '#lib/server/origin.ts';

export const init: ServerInit = () => {
	startJobs();
};

const PUBLIC = ['/login', '/setup', '/signup', '/invite/', '/auth/oidc/', '/api/auth/', '/api/health', '/api/slack/interactions', '/api/slack/oauth'];
/** Pages a signed-in user without an organisation can still open. */
const NO_ORG_OK = ['/signup', '/account', '/api/account', '/api/orgs'];
const ADMIN_PAGES = ['/resources/new', '/audit', '/settings', '/evidence'];
const ADMIN_EXACT = ['/resources'];

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	const method = event.request.method;
	const isApi = pathname.startsWith('/api/');

	// Writes must come from our own host: browsers always send Origin on cross-site and
	// non-GET requests, so a mismatch means a forged request. Server-to-server callers
	// (Slack, IdPs) send no Origin and authenticate with signatures or tokens instead.
	if (method !== 'GET' && method !== 'HEAD') {
		const origin = event.request.headers.get('origin');
		if (origin) {
			const h = event.request.headers;
			const allowed = [event.url.host, h.get('host'), h.get('x-forwarded-host')].filter(Boolean);
			let host = '';
			try {
				host = new URL(origin).host;
			} catch {}
			if (!allowed.includes(host)) return json({ message: 'Cross-origin request blocked' }, { status: 403 });
		}
	}

	const visible = publicUrl(event.url, event.request.headers);
	// Machine endpoints (SCIM, the public API) bring their own bearer tokens: no cookies, no redirects.
	if (pathname.startsWith('/scim/') || pathname.startsWith('/api/v1/')) {
		event.locals.origin = config.publicUrl || visible.origin;
		event.locals.secure = visible.protocol === 'https:';
		event.locals.auth = 'anonymous';
		event.locals.user = null;
		event.locals.org = null;
		event.locals.role = null;
		event.locals.orgs = [];
		event.locals.sessionId = null;
		event.locals.ssoRequired = false;
		const response = await resolve(event);
		response.headers.set('X-Content-Type-Options', 'nosniff');
		response.headers.set('Cache-Control', 'no-store');
		return response;
	}
	event.locals.origin = config.publicUrl || visible.origin;
	event.locals.secure = visible.protocol === 'https:';
	try {
		event.locals.ip = event.getClientAddress();
	} catch {}

	const state = await authenticate(event.cookies, event.locals);
	event.locals.auth = state;

	if (!PUBLIC.some((p) => pathname.startsWith(p))) {
		if (state === 'setup') {
			if (isApi) return json({ message: 'Setup required' }, { status: 401 });
			redirect(303, '/setup');
		}
		if (state === 'anonymous') {
			if (isApi) return json({ message: 'Not signed in' }, { status: 401 });
			redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
		}
		if (!event.locals.org && !NO_ORG_OK.some((p) => pathname.startsWith(p))) {
			if (isApi) return json({ message: 'You’re not a member of an organisation' }, { status: 403 });
			redirect(303, isCloud() ? '/signup' : '/login?error=removed');
		}
		if (event.locals.ssoRequired && !NO_ORG_OK.some((p) => pathname.startsWith(p))) {
			if (isApi) return json({ message: `${event.locals.org!.name} requires single sign-on` }, { status: 403 });
			redirect(303, `/auth/oidc/start?org=${event.locals.org!.id}&next=${encodeURIComponent(pathname + event.url.search)}`);
		}
		const admin = event.locals.role === 'owner' || event.locals.role === 'admin';
		if (!admin && !isApi && (ADMIN_EXACT.includes(pathname) || ADMIN_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`)))) redirect(303, '/');
	}

	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	return response;
};
