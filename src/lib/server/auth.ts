import type { Cookies } from '@sveltejs/kit';
import { addMember, countOrgs, createOrg, createSession, createUser, deleteSession, getOrg, membership, membershipsOf, SESSION_TTL_MS, sessionByToken, setSessionOrg } from './accounts.ts';
import { config, isCloud } from './config.ts';
import { hashPassword } from './crypto.ts';
import { db } from './db.ts';
import { record } from './events.ts';

export const SESSION_COOKIE = 'acm_session';

export type AuthState = 'setup' | 'anonymous' | 'authenticated';

let bootstrapped = false;

/** ACM_ADMIN_EMAIL + ACM_ADMIN_PASSWORD create the first org and owner, so headless installs skip setup. */
async function bootstrap() {
	bootstrapped = true;
	const b = config.bootstrapAdmin;
	const d = await db();
	if (!b || (await countOrgs(d)) > 0) return;
	if (b.password.length < 8) {
		console.warn('[ac-modern] ACM_ADMIN_PASSWORD must be at least 8 characters; showing the setup wizard instead.');
		return;
	}
	await setupOrg({ orgName: b.org, email: b.email, name: b.name, password: b.password });
	console.log(`[ac-modern] Created ${b.org} with owner ${b.email} from ACM_ADMIN_EMAIL.`);
}

/** Creates an organisation and its first owner (setup wizard, cloud sign-up, bootstrap). */
export async function setupOrg(input: { orgName: string; email: string; name: string; password: string }) {
	const d = await db();
	return d.tx(async (tx) => {
		const user = await createUser(tx, { email: input.email, name: input.name, passwordHash: hashPassword(input.password) });
		const org = await createOrg(tx, input.orgName);
		await addMember(tx, org.id, user.id, 'owner');
		await record(tx, { orgId: org.id, actorId: user.id, action: 'org.created', subject: org.name, summary: `Created ${org.name}` });
		return { user, org };
	});
}

export async function authenticate(cookies: Cookies, locals: App.Locals): Promise<AuthState> {
	if (!bootstrapped) await bootstrap();
	const d = await db();
	locals.user = null;
	locals.org = null;
	locals.role = null;
	locals.orgs = [];
	locals.sessionId = null;
	const token = cookies.get(SESSION_COOKIE);
	const s = token ? await sessionByToken(d, token) : undefined;
	if (!s) {
		if (!isCloud() && (await countOrgs(d)) === 0) return 'setup';
		return 'anonymous';
	}
	locals.sessionId = s.id;
	locals.user = { id: s.user_id, email: s.email, name: s.name };
	locals.orgs = await membershipsOf(d, s.user_id);
	// The session's organisation, or their first one if they were removed from it.
	let orgId = s.org_id && (await membership(d, s.org_id, s.user_id)) ? s.org_id : (locals.orgs[0]?.orgId ?? null);
	if (orgId !== s.org_id && orgId) await setSessionOrg(d, s.id, orgId);
	if (orgId) {
		locals.org = (await getOrg(d, orgId)) ?? null;
		locals.role = locals.orgs.find((m) => m.orgId === orgId)?.role ?? null;
	}
	return 'authenticated';
}

export async function startSession(cookies: Cookies, userId: string, orgId: string | null, secure: boolean) {
	const token = await createSession(await db(), userId, orgId);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		// Lax so the cookie survives top-level navigations from email links.
		sameSite: 'lax',
		secure,
		maxAge: SESSION_TTL_MS / 1000
	});
}

export async function endSession(cookies: Cookies) {
	const token = cookies.get(SESSION_COOKIE);
	if (token) await deleteSession(await db(), token);
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

// In-memory login throttle: 10 attempts per 5 minutes per key.
const attempts = new Map<string, number[]>();
export function throttled(key: string): boolean {
	const t = Date.now();
	const recent = (attempts.get(key) ?? []).filter((x) => t - x < 5 * 60_000);
	recent.push(t);
	attempts.set(key, recent);
	return recent.length > 10;
}

/** Cloud sign-up allow-list (ACM_SIGNUP_ALLOW); empty lets anyone sign up. */
export function emailAllowed(email: string): boolean {
	const patterns = config.signupAllow;
	if (!patterns.length) return true;
	const e = email.trim().toLowerCase();
	return patterns.some((raw) => {
		const p = raw.toLowerCase();
		if (p === '*') return true;
		if (p.startsWith('*@')) return e.endsWith(p.slice(1));
		if (p.startsWith('@')) return e.endsWith(p);
		return e === p;
	});
}
