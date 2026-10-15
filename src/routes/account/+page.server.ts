import { listPersonalTokens } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const d = await db();
	const row = locals.user ? await d.get<{ github_login: string }>('SELECT github_login FROM users WHERE id = ?', [locals.user.id]) : undefined;
	return {
		githubLogin: row?.github_login ?? '',
		tokens: locals.user && locals.org ? await listPersonalTokens(d, locals.org.id, locals.user.id) : [],
		mcpUrl: `${locals.origin}/mcp`
	};
};
