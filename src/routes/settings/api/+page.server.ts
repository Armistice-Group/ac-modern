import { listPersonalTokens, listTokens } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	return { tokens: await listTokens(d, c.org.id), personal: await listPersonalTokens(d, c.org.id), base: `${locals.origin}/api/v1`, mcpUrl: `${locals.origin}/mcp` };
};
