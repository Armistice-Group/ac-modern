import { listInvites, listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { redirect } from '@sveltejs/kit';
import { ctx, isAdmin } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const counts = await d.all<{ user_id: string; n: number }>(
		"SELECT user_id, CAST(COUNT(*) AS INTEGER) AS n FROM grants WHERE org_id = ? AND status <> 'revoked' GROUP BY user_id",
		[c.org.id]
	);
	// Managers who aren't admins see their own reports.
	const everyone = await listPeople(d, c.org.id, { includeDeactivated: true });
	const people = admin ? everyone : everyone.filter((p) => p.managerId === c.user.id);
	if (!admin && !people.length) redirect(303, '/');
	return {
		admin,
		people: admin ? people : [...people, ...everyone.filter((p) => p.id === c.user.id)],
		invites: admin ? await listInvites(d, c.org.id) : [],
		grants: Object.fromEntries(counts.map((r) => [r.user_id, Number(r.n)])),
		smtp: !!(await import('#lib/server/config.ts')).config.smtp
	};
};
