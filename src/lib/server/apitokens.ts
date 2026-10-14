import { newId, randomToken, sha256 } from './crypto.ts';
import type { Db } from './db.ts';
import { badRequest } from './http.ts';

/** Read-only, org-scoped tokens for the /api/v1 API (GRC tools, scripts). Stored hashed. */
export async function createToken(db: Db, orgId: string, name: string, createdBy: string, expiresDays: number | null) {
	if (!name.trim()) throw badRequest('Name the token after what will use it, e.g. “Vanta”');
	const token = `acm_${randomToken(32)}`;
	const id = newId();
	const now = new Date();
	await db.run('INSERT INTO api_tokens (id, org_id, name, token_hash, prefix, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
		id,
		orgId,
		name.trim(),
		sha256(token),
		token.slice(0, 10),
		createdBy,
		now.toISOString(),
		expiresDays ? new Date(now.getTime() + expiresDays * 86_400_000).toISOString() : null
	]);
	return { id, token };
}

export async function listTokens(db: Db, orgId: string) {
	return db.all<{ id: string; name: string; prefix: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; createdBy: string | null }>(
		`SELECT t.id, t.name, t.prefix, t.created_at AS "createdAt", t.expires_at AS "expiresAt", t.last_used_at AS "lastUsedAt", COALESCE(NULLIF(u.name, ''), u.email) AS "createdBy"
		 FROM api_tokens t LEFT JOIN users u ON u.id = t.created_by WHERE t.org_id = ? AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
		[orgId]
	);
}

export async function revokeToken(db: Db, orgId: string, id: string) {
	const { changes } = await db.run('UPDATE api_tokens SET revoked_at = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL', [new Date().toISOString(), orgId, id]);
	return changes > 0;
}

const lastTouch = new Map<string, number>();

/** The org a bearer token belongs to, if it's live. */
export async function authenticateToken(db: Db, header: string | null): Promise<{ orgId: string; tokenId: string } | null> {
	const token = (header ?? '').replace(/^Bearer\s+/i, '').trim();
	if (!token.startsWith('acm_') || token.startsWith('acm_scim_')) return null;
	const row = await db.get<{ id: string; org_id: string; expires_at: string | null }>('SELECT id, org_id, expires_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL', [sha256(token)]);
	if (!row || (row.expires_at && row.expires_at < new Date().toISOString())) return null;
	// Last-used is informative; write it at most once a minute per token.
	if (Date.now() - (lastTouch.get(row.id) ?? 0) > 60_000) {
		lastTouch.set(row.id, Date.now());
		await db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
	}
	return { orgId: row.org_id, tokenId: row.id };
}

const hits = new Map<string, number[]>();
/** 600 requests a minute per token. */
export function rateLimited(tokenId: string): boolean {
	const t = Date.now();
	const recent = (hits.get(tokenId) ?? []).filter((x) => t - x < 60_000);
	recent.push(t);
	hits.set(tokenId, recent);
	return recent.length > 600;
}
