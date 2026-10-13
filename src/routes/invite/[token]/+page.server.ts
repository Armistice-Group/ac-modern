import { db } from '#lib/server/db.ts';
import { inviteByToken, userByEmail } from '#lib/server/accounts.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const d = await db();
	const invite = await inviteByToken(d, params.token);
	if (!invite) return { invite: null, hasAccount: false, signedInAs: locals.user?.email ?? null };
	const hasAccount = !!(await userByEmail(d, invite.email));
	return {
		invite: { orgName: invite.org_name, email: invite.email, inviter: invite.inviter },
		hasAccount,
		signedInAs: locals.user?.email ?? null
	};
};
