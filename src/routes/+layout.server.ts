import type { LayoutServerLoad } from './$types';
import { db } from '#lib/server/db.ts';
import { waitingOn } from '#lib/server/requests.ts';
import { pendingReviewCount } from '#lib/server/reviews.ts';
import { config } from '#lib/server/config.ts';
import type { Org, Viewer } from '#lib/types.ts';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	// Reading the path reruns this on navigation so the sidebar badges stay current.
	void url.pathname;
	const base = {
		auth: locals.auth,
		version: __APP_VERSION__,
		mode: config.mode,
		viewer: null as Viewer | null,
		org: null as Org | null,
		badges: { approve: 0, fulfill: 0, review: 0 }
	};
	if (!locals.user) return base;
	const viewer: Viewer = { ...locals.user, role: locals.role ?? 'member', orgs: locals.orgs };
	if (!locals.org) return { ...base, viewer };
	const d = await db();
	const w = await waitingOn(d, locals.org.id, locals.user.id);
	return {
		...base,
		viewer,
		org: locals.org,
		badges: { approve: w.toApprove.length, fulfill: w.toFulfill.length, review: await pendingReviewCount(d, locals.org.id, locals.user.id) }
	};
};
