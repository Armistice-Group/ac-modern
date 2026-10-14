import { parseServiceAccountKey } from '#lib/google.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import { config } from '#lib/server/config.ts';
import { getSource } from '#lib/server/directory.ts';
import { getIntegration } from '#lib/server/integrations.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	const gh = await getIntegration<{ org: string }>(d, c.org.id, 'github');
	const g = await getIntegration<{ adminEmail: string; serviceAccountJson: string }>(d, c.org.id, 'google');
	const okta = await getIntegration<{ domain: string }>(d, c.org.id, 'okta');
	const authentik = await getIntegration<{ url: string }>(d, c.org.id, 'authentik');
	const entra = await getIntegration<{ tenantId: string; clientId: string }>(d, c.org.id, 'entra');
	const directory = (await d.get<{ kind: string }>('SELECT kind FROM directory_sources WHERE org_id = ?', [c.org.id]))?.kind ?? null;
	const slack = await getIntegration<{ teamName?: string; botToken?: string }>(d, c.org.id, 'slack');
	const usage = await d.all<{ integration: string; n: number }>(
		"SELECT integration, CAST(COUNT(*) AS INTEGER) AS n FROM resources WHERE org_id = ? AND fulfillment = 'integration' AND archived = 0 GROUP BY integration",
		[c.org.id]
	);
	const key = g ? parseServiceAccountKey(g.serviceAccountJson) : null;
	const sa = key && !('error' in key) ? { clientId: key.clientId, email: key.clientEmail } : null;
	return {
		github: gh ? { org: gh.org } : null,
		google: g ? { adminEmail: g.adminEmail, serviceAccount: sa } : null,
		directoryGoogleKey: await directoryGoogleKey(d, c.org.id),
		okta: okta ? { domain: okta.domain } : null,
		authentik: authentik ? { url: authentik.url } : null,
		entra: entra ? { tenantId: entra.tenantId, clientId: entra.clientId } : null,
		directory,
		slack: slack?.botToken ? { team: slack.teamName ?? '' } : null,
		usage: Object.fromEntries(usage.map((u) => [u.integration, Number(u.n)])),
		slackEventsUrl: `${locals.origin}/api/slack/interactions`,
		slackShared: !!config.slackApp
	};
};

/** Directory sync's Google key, which provisioning reuses when no key of its own is saved. */
async function directoryGoogleKey(d: Awaited<ReturnType<typeof db>>, orgId: string) {
	const source = await getSource(d, orgId);
	if (source?.kind !== 'google' || !source.config.serviceAccountJson) return null;
	const key = parseServiceAccountKey(source.config.serviceAccountJson);
	return 'error' in key ? null : { clientId: key.clientId, email: key.clientEmail };
}
