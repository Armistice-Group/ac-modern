import { listInvites, listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	const counts = await d.all<{ user_id: string; n: number }>(
		"SELECT user_id, CAST(COUNT(*) AS INTEGER) AS n FROM grants WHERE org_id = ? AND status <> 'revoked' GROUP BY user_id",
		[c.org.id]
	);
	return {
		people: await listPeople(d, c.org.id, { includeDeactivated: true }),
		invites: await listInvites(d, c.org.id),
		grants: Object.fromEntries(counts.map((r) => [r.user_id, Number(r.n)])),
		smtp: !!(await import('#lib/server/config.ts')).config.smtp
	};
};
