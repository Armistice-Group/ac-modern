import { parseServiceAccountKey } from '#lib/google.ts';
import { db } from '#lib/server/db.ts';
import { getSource, listMappings } from '#lib/server/directory.ts';
import { getIntegration } from '#lib/server/integrations.ts';
import { listEvents } from '#lib/server/events.ts';
import { adminCtx } from '#lib/server/http.ts';
import { listResources } from '#lib/server/resources.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	const source = await getSource(d, c.org.id);
	const groups = await d.all<{ id: string; name: string; n: number }>(
		`SELECT g.id, g.name, CAST(COUNT(m.user_id) AS INTEGER) AS n FROM directory_groups g
		 LEFT JOIN directory_memberships m ON m.org_id = g.org_id AND m.group_id = g.id WHERE g.org_id = ? GROUP BY g.id, g.name ORDER BY LOWER(g.name)`,
		[c.org.id]
	);
	const key = source?.kind === 'google' && source.config.serviceAccountJson ? parseServiceAccountKey(source.config.serviceAccountJson) : null;
	const provisioning = await getIntegration<{ serviceAccountJson: string }>(d, c.org.id, 'google');
	const pkey = provisioning ? parseServiceAccountKey(provisioning.serviceAccountJson) : null;
	const events = (await listEvents(d, c.org.id, { limit: 200 })).filter((e) => e.action.startsWith('directory.') || e.action === 'grant.detected' || (!e.actor && e.action.startsWith('member.'))).slice(0, 15);
	return {
		source: source
			? {
					kind: source.kind,
					// Only non-secret fields go back to the browser.
					config: { domain: source.config.domain ?? '', adminEmail: source.config.adminEmail ?? '', tenantId: source.config.tenantId ?? '', clientId: source.config.clientId ?? '' },
					hasSecret: { serviceAccountJson: !!source.config.serviceAccountJson, apiToken: !!source.config.apiToken, clientSecret: !!source.config.clientSecret },
					// The key's client ID and address aren't secret; they're what the Admin console asks for.
					serviceAccount: key && !('error' in key) ? { clientId: key.clientId, email: key.clientEmail } : null,
					hasScimToken: source.hasScimToken,
					onDeactivate: source.onDeactivate,
					createMembers: source.createMembers,
					lastSyncAt: source.lastSyncAt,
					lastError: source.lastError,
					stats: source.stats
				}
			: null,
		groups: groups.map((g) => ({ ...g, n: Number(g.n) })),
		mappings: await listMappings(d, c.org.id),
		resources: (await listResources(d, c.org.id)).map((r) => ({ id: r.id, name: r.name, roles: r.roles })),
		googleProvisioningKey: pkey && !('error' in pkey) ? { clientId: pkey.clientId, email: pkey.clientEmail } : null,
		scimUrl: `${locals.origin}/scim/v2`,
		events
	};
};
