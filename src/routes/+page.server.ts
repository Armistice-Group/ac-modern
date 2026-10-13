import { listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { listEvents } from '#lib/server/events.ts';
import { listGrants } from '#lib/server/grants.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { listRequests, waitingOn } from '#lib/server/requests.ts';
import { listResources } from '#lib/server/resources.ts';
import { orgSettings } from '#lib/server/accounts.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const [work, mine, myGrants] = await Promise.all([
		waitingOn(d, c.org.id, c.user.id),
		listRequests(d, c.org.id, { involving: c.user.id, limit: 6 }),
		listGrants(d, c.org.id, { userId: c.user.id })
	]);
	let org = null;
	if (admin) {
		const [grants, open, resources, people, events, settings] = await Promise.all([
			listGrants(d, c.org.id),
			listRequests(d, c.org.id, { statuses: ['pending_approval', 'pending_fulfillment'], limit: 1000 }),
			listResources(d, c.org.id),
			listPeople(d, c.org.id),
			listEvents(d, c.org.id, { limit: 8 }),
			orgSettings(d, c.org.id)
		]);
		const week = Date.now() + 7 * 86_400_000;
		org = {
			activeGrants: grants.length,
			openRequests: open.length,
			expiringSoon: grants.filter((g) => g.status === 'active' && g.expiresAt && Date.parse(g.expiresAt) <= week).length,
			resources: resources.length,
			people: people.length,
			events,
			setup: { resources: resources.length > 0, people: people.length > 1, grants: grants.length > 0, slack: !!settings.slackWebhook }
		};
	}
	return { work, mine, myGrants, org };
};
