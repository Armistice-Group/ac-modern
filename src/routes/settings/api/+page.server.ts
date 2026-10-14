import { listTokens } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	return { tokens: await listTokens(await db(), c.org.id), base: `${locals.origin}/api/v1` };
};
