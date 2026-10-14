import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { adminCtx, badRequest, handler, HttpError, notFound } from '#lib/server/http.ts';
import { getIntegration } from '#lib/server/integrations.ts';
import { TARGET_KINDS } from '#lib/integrations.ts';
import type { IntegrationKind } from '#lib/types.ts';

/** Groups (and Okta apps) to pick from in the resource editor. */
export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const kind = event.params.kind as IntegrationKind;
	if (!TARGET_KINDS.includes(kind)) throw notFound();
	const cfg = await getIntegration(await db(), c.org.id, kind);
	if (!cfg) throw badRequest('Connect it first');
	try {
		if (kind === 'okta') return json(await (await import('#lib/server/idp/okta.ts')).oktaTargets(cfg as never));
		if (kind === 'authentik') return json(await (await import('#lib/server/idp/authentik.ts')).authentikTargets(cfg as never));
		return json(await (await import('#lib/server/idp/entra.ts')).entraTargets(cfg as never));
	} catch (err) {
		throw new HttpError(502, (err as Error).message);
	}
});
