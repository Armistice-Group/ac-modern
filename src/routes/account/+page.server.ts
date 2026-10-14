import { db } from '#lib/server/db.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const row = locals.user ? await (await db()).get<{ github_login: string }>('SELECT github_login FROM users WHERE id = ?', [locals.user.id]) : undefined;
	return { githubLogin: row?.github_login ?? '' };
};
