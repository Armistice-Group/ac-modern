import { db } from '#lib/server/db.ts';
import { SCAN_KINDS } from '#lib/server/discovery.ts';
import { adminCtx } from '#lib/server/http.ts';
import { connectedIntegrations } from '#lib/server/integrations.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const connected = await connectedIntegrations(await db(), c.org.id);
	return {
		kinds: SCAN_KINDS.filter((k) => connected.includes(k)),
		origin: locals.origin
	};
};
