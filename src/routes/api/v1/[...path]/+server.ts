import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { handleV1 } from '#lib/server/api-v1.ts';
import { authenticateToken, rateLimited } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { openapi } from '#lib/server/openapi.ts';

export const GET: RequestHandler = async ({ request, params, url, locals }) => {
	const path = params.path.split('/').filter(Boolean);
	if (path.join('/') === 'openapi.json') return json(openapi(locals.origin));
	const d = await db();
	const auth = await authenticateToken(d, request.headers.get('authorization'));
	if (!auth) return json({ error: { status: 401, message: 'Missing or invalid API token' } }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
	if (rateLimited(auth.tokenId)) return json({ error: { status: 429, message: 'Slow down: 600 requests a minute per token' } }, { status: 429, headers: { 'retry-after': '60' } });
	try {
		const r = await handleV1(d, auth.orgId, path, url.searchParams);
		return json(r.body, { status: r.status });
	} catch (err) {
		console.error('[ac-modern] API', err);
		return json({ error: { status: 500, message: 'Something went wrong' } }, { status: 500 });
	}
};

const readOnly: RequestHandler = () => json({ error: { status: 405, message: 'The API is read-only' } }, { status: 405, headers: { allow: 'GET' } });
export const POST = readOnly;
export const PUT = readOnly;
export const PATCH = readOnly;
export const DELETE = readOnly;
