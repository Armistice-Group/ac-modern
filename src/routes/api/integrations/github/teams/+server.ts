import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, badRequest, handler, HttpError } from '#lib/server/http.ts';
import { getIntegration } from '#lib/server/integrations.ts';
import { listTeams } from '#lib/server/idp/github.ts';

export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const cfg = await getIntegration<{ org: string; token: string }>(await db(), c.org.id, 'github');
	if (!cfg) throw badRequest('Connect GitHub first');
	try {
		return json(await listTeams(cfg));
	} catch (err) {
		throw new HttpError(502, (err as Error).message);
	}
});
