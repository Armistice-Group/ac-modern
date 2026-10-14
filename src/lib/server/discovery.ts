import { mappingValid } from '#lib/integrations.ts';
import type { ApprovalPolicy, DiscoveredApp, IntegrationKind, LevelMapping, ScannedApp } from '#lib/types.ts';
import { normEmail } from './accounts.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { recordGrant } from './grants.ts';
import { badRequest } from './http.ts';
import { getIntegration } from './integrations.ts';
import { saveResource } from './resources.ts';

/**
 * App scans: the apps an identity provider knows about become suggested resources, and
 * the people it lets in become recorded access, so ac·modern starts from what's really
 * there instead of a hand-typed list.
 */

export const SCAN_KINDS = ['authentik', 'okta', 'entra'] as const satisfies IntegrationKind[];
export type ScanKind = (typeof SCAN_KINDS)[number];

const IDP_NAME: Record<ScanKind, string> = { authentik: 'Authentik', okta: 'Okta', entra: 'Microsoft Entra ID' };

async function scan(kind: ScanKind, cfg: Record<string, string>, f: typeof fetch): Promise<ScannedApp[]> {
	if (kind === 'authentik') return (await import('./idp/authentik.ts')).authentikApps(cfg as never, f);
	if (kind === 'okta') return (await import('./idp/okta.ts')).oktaApps(cfg as never, f);
	return (await import('./idp/entra.ts')).entraApps(cfg as never, f);
}

async function scanFor(db: Db, orgId: string, kind: ScanKind, f: typeof fetch) {
	if (!SCAN_KINDS.includes(kind)) throw badRequest('That identity provider can’t be scanned for apps');
	const cfg = await getIntegration(db, orgId, kind);
	if (!cfg) throw badRequest(`Connect ${IDP_NAME[kind]} under Settings → Integrations first`);
	const apps = await scan(kind, cfg, f);
	const members = await db.all<{ user_id: string; email: string }>(
		"SELECT m.user_id, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.status = 'active'",
		[orgId]
	);
	const byEmail = new Map(members.map((m) => [normEmail(m.email), m.user_id]));
	const imported = new Map(
		(await db.all<{ id: string; external_ref: string }>("SELECT id, external_ref FROM resources WHERE org_id = ? AND external_ref <> '' AND archived = 0", [orgId])).map((r) => [r.external_ref, r.id])
	);
	return { apps, byEmail, imported };
}

const provisionable = (kind: ScanKind, m: LevelMapping | null) => !!m && mappingValid(kind, m);

export async function discoverApps(db: Db, orgId: string, kind: ScanKind, f: typeof fetch = fetch): Promise<DiscoveredApp[]> {
	const { apps, byEmail, imported } = await scanFor(db, orgId, kind, f);
	return apps.map((a) => ({
		...a,
		resourceId: imported.get(a.ref) ?? null,
		provisioned: a.levels.length > 0 && a.levels.every((l) => provisionable(kind, l.mapping)),
		levels: a.levels.map((l) => ({
			name: l.name,
			provisioned: provisionable(kind, l.mapping),
			people: new Set(l.emails.map(normEmail)).size,
			notMembers: [...new Set(l.emails.map(normEmail))].filter((e) => !byEmail.has(e))
		}))
	}));
}

const safeUrl = (u: string) => {
	try {
		return ['https:', 'http:'].includes(new URL(u).protocol) ? u : '';
	} catch {
		return '';
	}
};

/**
 * Imports the chosen apps as resources and records who already has each one. Scans again
 * rather than trusting what the browser sends. Apps already imported are skipped.
 */
export async function importApps(db: Db, orgId: string, actorId: string, kind: ScanKind, refs: string[], opts: { approval: ApprovalPolicy }, f: typeof fetch = fetch) {
	const { apps, byEmail, imported } = await scanFor(db, orgId, kind, f);
	const chosen = apps.filter((a) => refs.includes(a.ref) && !imported.has(a.ref));
	const idp = IDP_NAME[kind];
	const result = { resources: 0, grants: 0, notMembers: 0 };
	for (const app of chosen) {
		// Policy-only or open-to-all apps still get a level, so they can be requested.
		const levels = app.levels.length ? app.levels : [{ name: 'Access', mapping: null, emails: [] }];
		const names = new Set<string>();
		const roles = levels.map((l) => {
			let name = l.name.slice(0, 80) || 'Access';
			for (let i = 2; names.has(name.toLowerCase()); i++) name = `${l.name.slice(0, 75)} (${i})`;
			names.add(name.toLowerCase());
			return { name, description: l.mapping ? `${idp}: ${l.name}` : `Found in ${idp}`, privileged: false };
		});
		const provisioned = levels.every((l) => provisionable(kind, l.mapping));
		const resourceId = await saveResource(db, orgId, null, {
			name: app.name.slice(0, 120),
			description: app.description.slice(0, 500) || `Imported from ${idp}.`,
			category: 'app',
			url: safeUrl(app.url),
			color: 'violet',
			ownerId: actorId,
			approval: opts.approval,
			fulfillment: provisioned ? 'integration' : 'manual',
			webhookUrl: '',
			integration: provisioned ? kind : '',
			integrationMap: provisioned ? Object.fromEntries(levels.map((l, i) => [`#${i}`, l.mapping!])) : undefined,
			maxDays: null,
			defaultDays: null,
			requestable: true,
			approverIds: [],
			fulfillerIds: [],
			roles
		});
		await db.run('UPDATE resources SET external_ref = ? WHERE org_id = ? AND id = ?', [app.ref, orgId, resourceId]);
		await record(db, { orgId, actorId, action: 'resource.created', subject: app.name, summary: `Imported ${app.name} from ${idp}` });
		result.resources++;

		const roleIds = await db.all<{ id: string }>('SELECT id FROM resource_roles WHERE resource_id = ? ORDER BY position', [resourceId]);
		for (const [i, level] of levels.entries()) {
			for (const email of new Set(level.emails.map(normEmail))) {
				const userId = byEmail.get(email);
				if (!userId) {
					result.notMembers++;
					continue;
				}
				try {
					await recordGrant(db, { orgId, userId: actorId, admin: true }, {
						userId,
						resourceId,
						roleId: roleIds[i].id,
						expiresAt: null,
						note: `Found in ${idp} by an app scan (${level.mapping ? `group ${level.name}` : level.name.toLowerCase()})`,
						source: 'idp'
					});
					result.grants++;
				} catch {
					// Already recorded (e.g. listed under two groups that map to the same level).
				}
			}
		}
	}
	return result;
}
