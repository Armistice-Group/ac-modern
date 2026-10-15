import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePersonal, rateLimited } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { handleMcp } from '#lib/server/mcp.ts';

/** The MCP endpoint (Streamable HTTP, stateless): POST JSON-RPC with a personal token. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const d = await db();
	const auth = await authenticatePersonal(d, request.headers.get('authorization'));
	if (!auth)
		return json(
			{ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or invalid token. Create a personal token under Account → AI assistants.' } },
			{ status: 401, headers: { 'www-authenticate': 'Bearer' } }
		);
	if (rateLimited(auth.tokenId)) return json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Slow down: 600 requests a minute per token' } }, { status: 429, headers: { 'retry-after': '60' } });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
	}
	const out = await handleMcp(d, auth, body, locals.origin, __APP_VERSION__);
	return out === null ? new Response(null, { status: 202 }) : json(out);
};

/** No server-initiated stream: every answer comes back on the POST. */
export const GET: RequestHandler = () => new Response(null, { status: 405, headers: { allow: 'POST' } });
export const DELETE: RequestHandler = () => new Response(null, { status: 405, headers: { allow: 'POST' } });
