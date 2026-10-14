import { listPeople, orgSettings } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { connectedIntegrations } from '#lib/server/integrations.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	return {
		people: (await listPeople(d, c.org.id)).map((p) => ({ id: p.id, name: p.name, email: p.email })),
		defaultApproval: (await orgSettings(d, c.org.id)).defaultApproval ?? 'approvers',
		origin: locals.origin,
		integrations: (await connectedIntegrations(d, c.org.id)).filter((k) => k !== 'slack')
	};
};
