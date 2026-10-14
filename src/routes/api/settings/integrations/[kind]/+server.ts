import { json } from '@sveltejs/kit';
import { parseServiceAccountKey } from '#lib/google.ts';
import { db } from '#lib/server/db.ts';
import { getSource } from '#lib/server/directory.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, badRequest, body, handler, HttpError, notFound, str } from '#lib/server/http.ts';
import { deleteIntegration, getIntegration, saveIntegration } from '#lib/server/integrations.ts';
import { INTEGRATION_KINDS, INTEGRATIONS } from '#lib/integrations.ts';
import type { IntegrationKind } from '#lib/types.ts';

/**
 * Connects an integration after checking the credentials work. Blank secrets keep the stored
 * ones, or reuse directory sync's for the same IdP (with write permission added there).
 */
export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const kind = event.params.kind as IntegrationKind;
	if (!INTEGRATION_KINDS.includes(kind)) throw notFound();
	const b = await body(event);
	const d = await db();
	const current = (await getIntegration(d, c.org.id, kind)) ?? {};
	const dir = await getSource(d, c.org.id);
	const fromDir = dir?.kind === kind ? dir.config : {};
	const secret = (key: string) => str(b, key, { max: 20_000 }) || current[key] || fromDir[key] || '';
	let config: Record<string, string>;
	let result: Record<string, string>;
	try {
		switch (kind) {
			case 'github':
				config = { org: str(b, 'org', { required: true, max: 100 }).replace(/^https:\/\/github\.com\//, ''), token: secret('token') };
				if (!config.token) throw badRequest('Paste a token');
				result = await (await import('#lib/server/idp/github.ts')).testGitHub(config as never);
				break;
			case 'google':
				config = { serviceAccountJson: secret('serviceAccountJson'), adminEmail: str(b, 'adminEmail', { required: true, max: 200 }) };
				if (!config.serviceAccountJson) throw badRequest('Paste the service account’s JSON key');
				{
					const key = parseServiceAccountKey(config.serviceAccountJson);
					if ('error' in key) throw badRequest(key.error);
				}
				result = await (await import('#lib/server/idp/google.ts')).testGoogle(config as never);
				break;
			case 'okta':
				config = { domain: str(b, 'domain', { required: true, max: 200 }) || fromDir.domain, apiToken: secret('apiToken') };
				if (!config.apiToken) throw badRequest('Paste an API token');
				result = await (await import('#lib/server/idp/okta.ts')).testOkta(config as never);
				break;
			case 'authentik':
				config = { url: str(b, 'url', { required: true, max: 300 }), token: secret('token') };
				if (!/^https?:\/\//.test(config.url)) throw badRequest('Enter Authentik’s URL, e.g. https://auth.example.com');
				if (!config.token) throw badRequest('Paste an API token');
				result = await (await import('#lib/server/idp/authentik.ts')).testAuthentik(config as never);
				break;
			case 'entra':
				config = { tenantId: str(b, 'tenantId', { max: 100 }) || fromDir.tenantId || '', clientId: str(b, 'clientId', { max: 100 }) || fromDir.clientId || '', clientSecret: secret('clientSecret') };
				if (!config.tenantId || !config.clientId || !config.clientSecret) throw badRequest('Enter the tenant ID, client ID and client secret');
				result = await (await import('#lib/server/idp/entra.ts')).testEntra(config as never);
				break;
		}
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(422, `${INTEGRATIONS[kind].name} didn’t accept that: ${(err as Error).message}`);
	}
	await saveIntegration(d, c.org.id, kind, config);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: INTEGRATIONS[kind].name, summary: `Connected ${INTEGRATIONS[kind].name}` });
	return json(result);
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const kind = event.params.kind as IntegrationKind;
	if (!INTEGRATION_KINDS.includes(kind)) throw notFound();
	const d = await db();
	const used = await d.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM resources WHERE org_id = ? AND fulfillment = 'integration' AND integration = ? AND archived = 0", [c.org.id, kind]);
	if (used!.n) throw badRequest(`${used!.n} ${used!.n === 1 ? 'resource uses' : 'resources use'} ${INTEGRATIONS[kind].name}; switch them to another setup method first`);
	await deleteIntegration(d, c.org.id, kind);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: INTEGRATIONS[kind].name, summary: `Disconnected ${INTEGRATIONS[kind].name}` });
	return json({ ok: true });
});
