import { db } from '#lib/server/db.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listResources } from '#lib/server/resources.ts';
import { describePolicy, listPolicies, listReviews } from '#lib/server/reviews.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const all = await listReviews(d, c.org.id);
	// Members see the reviews that have items assigned to them.
	const mine = await d.all<{ review_id: string; n: number }>(
		'SELECT review_id, CAST(SUM(CASE WHEN decision IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS n FROM review_items WHERE org_id = ? AND reviewer_id = ? GROUP BY review_id',
		[c.org.id, c.user.id]
	);
	const assigned = Object.fromEntries(mine.map((m) => [m.review_id, Number(m.n)]));
	const policies = [];
	if (admin)
		for (const p of await listPolicies(d, c.org.id)) {
			const last = all.find((r) => r.policyId === p.id);
			policies.push({ ...p, description: await describePolicy(d, c.org.id, p), last: last ? { id: last.id, name: last.name, status: last.status, decided: last.decided, total: last.total, dueAt: last.dueAt } : null });
		}
	return {
		admin,
		reviews: admin ? all : all.filter((r) => r.id in assigned),
		assigned,
		policies,
		resources: admin ? (await listResources(d, c.org.id)).filter((r) => !r.archived).map((r) => ({ id: r.id, name: r.name, color: r.color })) : []
	};
};
