import type { RequestHandler } from './$types';
import { db } from '#lib/server/db.ts';
import { orgForScimToken } from '#lib/server/directory.ts';
import { handleScim } from '#lib/server/scim.ts';

const scim = (status: number, body?: unknown) =>
	new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { 'content-type': 'application/scim+json' } });

/** SCIM 2.0 for identity providers; authenticated by the org's SCIM bearer token only. */
const handle: RequestHandler = async ({ request, params, url, locals }) => {
	const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
	const d = await db();
	const orgId = token ? await orgForScimToken(d, token) : null;
	if (!orgId) return scim(401, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401', detail: 'Invalid SCIM token' });
	let body: Record<string, unknown> | null = null;
	if (request.method !== 'GET' && request.method !== 'DELETE') {
		body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return scim(400, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '400', scimType: 'invalidSyntax', detail: 'Expected JSON' });
	}
	try {
		const r = await handleScim(d, orgId, request.method, params.path.split('/').filter(Boolean), url.searchParams, body, `${locals.origin}/scim/v2`, locals.origin);
		return scim(r.status, r.body);
	} catch (err) {
		console.error('[ac-modern] SCIM', err);
		return scim(500, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '500', detail: 'Something went wrong' });
	}
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
