import { json, type RequestEvent } from '@sveltejs/kit';
import type { Org, Role, SessionUser } from '#lib/types.ts';

export class HttpError extends Error {
	status: number;
	extra: Record<string, unknown>;
	constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}

export const badRequest = (m: string) => new HttpError(400, m);
export const forbidden = (m = 'You don’t have permission to do that') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string, extra: Record<string, unknown> = {}) => new HttpError(409, m, extra);

/** Wraps an API handler so thrown errors become JSON `{ message }` responses. */
export function handler(fn: (event: RequestEvent) => Promise<Response> | Response) {
	return async (event: RequestEvent) => {
		try {
			return await fn(event);
		} catch (err) {
			if (err instanceof HttpError) return json({ message: err.message, ...err.extra }, { status: err.status });
			if (err instanceof Response) return err;
			console.error('[ac-modern]', err);
			return json({ message: 'Something went wrong on the server' }, { status: 500 });
		}
	};
}

export interface Ctx {
	user: SessionUser;
	org: Org;
	role: Role;
}

/** The signed-in member of the current organisation, or a 401/403. */
export function ctx(locals: App.Locals): Ctx {
	if (!locals.user) throw new HttpError(401, 'Not signed in');
	if (!locals.org || !locals.role) throw new HttpError(403, 'You’re not a member of an organisation yet');
	return { user: locals.user, org: locals.org, role: locals.role };
}

export const isAdmin = (c: { role: Role }) => c.role === 'owner' || c.role === 'admin';

export function adminCtx(locals: App.Locals): Ctx {
	const c = ctx(locals);
	if (!isAdmin(c)) throw forbidden('Only admins can do that');
	return c;
}

export async function body(event: RequestEvent): Promise<Record<string, unknown>> {
	const b = await event.request.json().catch(() => null);
	if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('Expected a JSON object');
	return b as Record<string, unknown>;
}

export function str(b: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string {
	const v = b[key];
	if (v === undefined || v === null || v === '') {
		if (opts.required) throw badRequest(`${key} is required`);
		return '';
	}
	if (typeof v !== 'string') throw badRequest(`${key} must be text`);
	const s = v.trim();
	if (opts.required && !s) throw badRequest(`${key} is required`);
	if (s.length > (opts.max ?? 2000)) throw badRequest(`${key} is too long`);
	return s;
}

export function int(b: Record<string, unknown>, key: string, opts: { min?: number; max?: number } = {}): number | null {
	const v = b[key];
	if (v === undefined || v === null || v === '') return null;
	const n = Number(v);
	if (!Number.isInteger(n)) throw badRequest(`${key} must be a whole number`);
	if (opts.min !== undefined && n < opts.min) throw badRequest(`${key} must be at least ${opts.min}`);
	if (opts.max !== undefined && n > opts.max) throw badRequest(`${key} must be at most ${opts.max}`);
	return n;
}

export function oneOf<T extends string>(b: Record<string, unknown>, key: string, values: readonly T[], fallback?: T): T {
	const v = b[key] ?? fallback;
	if (!values.includes(v as T)) throw badRequest(`${key} must be one of ${values.join(', ')}`);
	return v as T;
}

export function ids(b: Record<string, unknown>, key: string): string[] {
	const v = b[key];
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${key} must be a list of ids`);
	return [...new Set(v as string[])];
}

/** The workflow's view of who is acting. */
export function actor(c: Ctx) {
	return { orgId: c.org.id, userId: c.user.id, admin: isAdmin(c) };
}
