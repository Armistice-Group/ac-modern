import { orgSettings } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { EXCEPTIONS, evidenceRows, outOfProcess } from '#lib/server/evidence.ts';
import { adminCtx } from '#lib/server/http.ts';
import { period } from '#lib/server/period.ts';
import { listReconciliations } from '#lib/server/reconcile.ts';
import { listResources } from '#lib/server/resources.ts';
import { describeRule, listRules } from '#lib/server/rules.ts';
import { leavers } from '#lib/server/leavers.ts';
import { describePolicy, listPolicies, listReviews } from '#lib/server/reviews.ts';
import type { RequestCategory } from '#lib/types.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const c = adminCtx(locals);
	const d = await db();
	const p = period(url);
	const types = (url.searchParams.get('types') ?? '').split(',').filter(Boolean) as RequestCategory[];
	const privileged = url.searchParams.get('privileged') === '1';
	const exceptions = url.searchParams.get('exceptions') === '1';
	const all = await evidenceRows(d, c.org.id, { from: p.from, to: p.to });
	const shown = all.filter(
		(r) =>
			(!types.length || types.includes(r.request.category)) &&
			(!privileged || r.request.privileged) &&
			(!exceptions || r.flags.some((f) => EXCEPTIONS.includes(f)))
	);
	const resources = await listResources(d, c.org.id);
	const settings = await orgSettings(d, c.org.id);
	return {
		period: { from: p.fromDate, to: p.toDate },
		filters: { types, privileged, exceptions },
		rows: shown.slice(0, 1000),
		total: shown.length,
		counts: {
			all: all.length,
			newHire: all.filter((r) => r.request.category === 'new_hire').length,
			changes: all.filter((r) => r.request.category === 'transfer' || r.request.category === 'change').length,
			privileged: all.filter((r) => r.request.privileged && r.request.kind === 'grant').length,
			exceptions: all.filter((r) => r.flags.some((f) => EXCEPTIONS.includes(f))).length,
			removals: all.filter((r) => r.request.kind === 'revoke').length
		},
		outside: await outOfProcess(d, c.org.id, p.from, p.to),
		leavers: await leavers(d, c.org.id, p.from, p.to),
		reviews: (await listReviews(d, c.org.id)).filter((r) => r.createdAt >= p.from && r.createdAt < p.to || (r.closedAt && r.closedAt >= p.from && r.closedAt < p.to)),
		reviewPolicies: await (async () => {
			const out: string[] = [];
			for (const x of (await listPolicies(d, c.org.id)).filter((x) => x.enabled)) out.push(`“${x.name}” (${await describePolicy(d, c.org.id, x)})`);
			return out;
		})(),
		reconciliations: await listReconciliations(d, c.org.id, { from: p.from, to: p.to }),
		control: {
			resources: resources.length,
			preApproved: resources.filter((r) => r.approval === 'none').map((r) => r.name),
			privilegedLevels: resources.flatMap((r) => r.roles.filter((x) => x.privileged).map((x) => `${r.name} ${x.name}`)),
			requirePrivilegedApproval: settings.requirePrivilegedApproval !== false,
			allowAdminOverride: !!settings.allowAdminOverride,
			requireSecondAdmin: !!settings.requireSecondAdmin,
			autoRules: await (async () => {
				const out: string[] = [];
				for (const r of (await listRules(d, c.org.id)).filter((x) => x.enabled)) out.push(`“${r.name}” (${await describeRule(d, c.org.id, r)})`);
				return out;
			})(),
			orgName: c.org.name
		}
	};
};
