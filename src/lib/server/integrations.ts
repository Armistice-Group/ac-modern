import { decrypt, encrypt } from './crypto.ts';
import type { Db } from './db.ts';
import type { IntegrationKind } from '#lib/types.ts';

/** Org-level credentials for built-in integrations, stored encrypted. */
export type IntegrationStoreKind = IntegrationKind | 'slack';

export async function getIntegration<T = Record<string, string>>(db: Db, orgId: string, kind: IntegrationStoreKind): Promise<T | null> {
	const r = await db.get<{ config: string }>('SELECT config FROM integrations WHERE org_id = ? AND kind = ?', [orgId, kind]);
	return r ? (JSON.parse(decrypt(r.config, `org:${orgId}:integration:${kind}`)) as T) : null;
}

export async function saveIntegration(db: Db, orgId: string, kind: IntegrationStoreKind, config: Record<string, unknown>) {
	const now = new Date().toISOString();
	await db.run(
		`INSERT INTO integrations (org_id, kind, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (org_id, kind) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
		[orgId, kind, encrypt(JSON.stringify(config), `org:${orgId}:integration:${kind}`), now, now]
	);
}

export async function deleteIntegration(db: Db, orgId: string, kind: IntegrationStoreKind) {
	await db.run('DELETE FROM integrations WHERE org_id = ? AND kind = ?', [orgId, kind]);
}

export async function connectedIntegrations(db: Db, orgId: string): Promise<IntegrationStoreKind[]> {
	return (await db.all<{ kind: IntegrationStoreKind }>('SELECT kind FROM integrations WHERE org_id = ?', [orgId])).map((r) => r.kind);
}
