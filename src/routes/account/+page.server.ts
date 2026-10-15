import { membershipsOf, orgSettings } from '#lib/server/accounts.ts';
import { listPersonalTokens } from '#lib/server/apitokens.ts';
import { db } from '#lib/server/db.ts';
import { mfaStatus } from '#lib/server/mfa.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const d = await db();
	const row = locals.user ? await d.get<{ github_login: string; password_hash: string | null }>('SELECT github_login, password_hash FROM users WHERE id = ?', [locals.user.id]) : undefined;
	// Organisations of theirs that require two-step verification (they can't turn it off).
	const requiredBy: string[] = [];
	if (locals.user) for (const m of await membershipsOf(d, locals.user.id)) if ((await orgSettings(d, m.orgId)).requireMfa) requiredBy.push(m.orgName);
	return {
		githubLogin: row?.github_login ?? '',
		hasPassword: !!row?.password_hash,
		mfa: locals.user ? await mfaStatus(d, locals.user.id) : null,
		mfaRequiredBy: requiredBy,
		mfaSetupRequired: !!locals.mfaSetupRequired,
		tokens: locals.user && locals.org && !locals.mfaSetupRequired ? await listPersonalTokens(d, locals.org.id, locals.user.id) : [],
		mcpUrl: `${locals.origin}/mcp`
	};
};
