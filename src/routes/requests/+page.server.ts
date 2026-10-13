import { db } from '#lib/server/db.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listRequests, waitingOn } from '#lib/server/requests.ts';
import { stewardedResourceIds } from '#lib/server/resources.ts';
import type { RequestStatus } from '#lib/types.ts';
import type { PageServerLoad } from './$types';

const OPEN: RequestStatus[] = ['pending_approval', 'pending_fulfillment'];
const CLOSED: RequestStatus[] = ['completed', 'denied', 'cancelled'];

export const load: PageServerLoad = async ({ locals, url }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const stewarded = await stewardedResourceIds(d, c.org.id, c.user.id);
	const canSeeAll = admin || stewarded.length > 0;
	const work = await waitingOn(d, c.org.id, c.user.id);
	const view = url.searchParams.get('view') ?? (work.toApprove.length || work.toFulfill.length ? 'approve' : 'mine');
	const status = url.searchParams.get('status') ?? 'open';
	const q = url.searchParams.get('q') ?? '';
	const statuses = status === 'open' ? OPEN : status === 'closed' ? CLOSED : undefined;

	let requests;
	if (view === 'approve') requests = work.toApprove;
	else if (view === 'fulfill') requests = work.toFulfill;
	else if (view === 'all' && canSeeAll) requests = await listRequests(d, c.org.id, { statuses, q, resourceIds: admin ? undefined : stewarded });
	else requests = await listRequests(d, c.org.id, { involving: c.user.id, statuses, q });

	return { view, status, q, requests, canSeeAll, counts: { approve: work.toApprove.length, fulfill: work.toFulfill.length } };
};
