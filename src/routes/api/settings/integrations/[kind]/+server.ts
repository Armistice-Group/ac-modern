import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, badRequest, body, handler, HttpError, notFound, str } from '#lib/server/http.ts';
import { deleteIntegration, getIntegration, saveIntegration } from '#lib/server/integrations.ts';

const NAMES = { github: 'GitHub', google: 'Google Workspace' } as const;

/** Connects an integration after checking the credentials work. Blank secrets keep the stored ones. */
export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const kind = event.params.kind as keyof typeof NAMES;
	if (!(kind in NAMES)) throw notFound();
	const b = await body(event);
	const d = await db();
	const current = (await getIntegration(d, c.org.id, kind)) ?? {};
	let config: Record<string, string>;
	let result: Record<string, string>;
	try {
		if (kind === 'github') {
			config = { org: str(b, 'org', { required: true, max: 100 }).replace(/^https:\/\/github\.com\//, ''), token: str(b, 'token', { max: 300 }) || current.token || '' };
			if (!config.token) throw badRequest('Paste a token');
			result = await (await import('#lib/server/idp/github.ts')).testGitHub(config as never);
		} else {
			config = { serviceAccountJson: str(b, 'serviceAccountJson', { max: 20_000 }) || current.serviceAccountJson || '', adminEmail: str(b, 'adminEmail', { required: true, max: 200 }) };
			if (!config.serviceAccountJson) throw badRequest('Paste the service account’s JSON key');
			result = await (await import('#lib/server/idp/google.ts')).testGoogle(config as never);
		}
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(502, `${NAMES[kind]} didn’t accept that: ${(err as Error).message}`);
	}
	await saveIntegration(d, c.org.id, kind, config);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: NAMES[kind], summary: `Connected ${NAMES[kind]}` });
	return json(result);
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const kind = event.params.kind as keyof typeof NAMES;
	if (!(kind in NAMES)) throw notFound();
	const d = await db();
	const used = await d.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM resources WHERE org_id = ? AND fulfillment = 'integration' AND integration = ? AND archived = 0", [c.org.id, kind]);
	if (used!.n) throw badRequest(`${used!.n} ${used!.n === 1 ? 'resource uses' : 'resources use'} ${NAMES[kind]}; switch them to another setup method first`);
	await deleteIntegration(d, c.org.id, kind);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: NAMES[kind], summary: `Disconnected ${NAMES[kind]}` });
	return json({ ok: true });
});
