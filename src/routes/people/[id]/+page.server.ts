import { error } from '@sveltejs/kit';
import { getPerson, listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { listGrants } from '#lib/server/grants.ts';
import { adminCtx } from '#lib/server/http.ts';
import { listRequests } from '#lib/server/requests.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const c = adminCtx(locals);
	const d = await db();
	const person = await getPerson(d, c.org.id, params.id).catch(() => error(404, 'That person isn’t in this organisation'));
	const people = await listPeople(d, c.org.id);
	return {
		person,
		people: people.filter((p) => p.id !== person.id).map((p) => ({ id: p.id, name: p.name, email: p.email })),
		reports: people.filter((p) => p.managerId === person.id).map((p) => ({ id: p.id, name: p.name, email: p.email })),
		grants: await listGrants(d, c.org.id, { userId: person.id }),
		requests: await listRequests(d, c.org.id, { userId: person.id, limit: 20 }),
		myRole: c.role
	};
};
