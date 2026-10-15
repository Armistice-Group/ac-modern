import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, conflict } from './http.ts';
import { type Actor, type Effects, startRevoke } from './requests.ts';
import { getResource, getRole } from './resources.ts';
import type { Grant, GrantSource, GrantStatus } from '#lib/types.ts';

const now = () => new Date().toISOString();
const DAY = 86_400_000;

interface Row {
	id: string;
	user_id: string;
	user_email: string;
	user_name: string;
	resource_id: string;
	resource_name: string;
	resource_color: string;
	role_id: string;
	role_name: string;
	status: GrantStatus;
	source: GrantSource;
	number: number | null;
	note: string;
	granted_at: string;
	expires_at: string | null;
	revoked_at: string | null;
}

export const GRANT_SELECT = `SELECT g.id, g.user_id, u.email AS user_email, u.name AS user_name, g.resource_id, r.name AS resource_name, r.color AS resource_color,
	g.role_id, rr.name AS role_name, g.status, g.source, q.number, g.note, g.granted_at, g.expires_at, g.revoked_at
	FROM grants g
	JOIN users u ON u.id = g.user_id
	JOIN resources r ON r.id = g.resource_id
	JOIN resource_roles rr ON rr.id = g.role_id
	LEFT JOIN requests q ON q.id = g.request_id`;

export const toGrant = (r: Row): Grant => ({
	id: r.id,
	user: { id: r.user_id, email: r.user_email, name: r.user_name },
	resource: { id: r.resource_id, name: r.resource_name, color: r.resource_color },
	role: { id: r.role_id, name: r.role_name },
	status: r.status,
	source: r.source,
	requestNumber: r.number === null ? null : Number(r.number),
	note: r.note,
	grantedAt: r.granted_at,
	expiresAt: r.expires_at,
	revokedAt: r.revoked_at
});

export interface GrantFilter {
	userId?: string;
	resourceId?: string;
	resourceIds?: string[];
	/** Default: active and pending removal. */
	statuses?: GrantStatus[];
	expiringWithinDays?: number;
	q?: string;
	/** Access held at this moment (ISO), whatever happened since; overrides statuses. */
	asOf?: string;
}

export async function listGrants(db: Db, orgId: string, f: GrantFilter = {}): Promise<Grant[]> {
	const where = ['g.org_id = ?'];
	const params: (string | number)[] = [orgId];
	if (f.asOf) {
		where.push('g.granted_at <= ? AND (g.revoked_at IS NULL OR g.revoked_at > ?)');
		params.push(f.asOf, f.asOf);
	} else {
		const statuses = f.statuses ?? ['active', 'pending_revoke'];
		where.push(`g.status IN (${statuses.map(() => '?').join(',')})`);
		params.push(...statuses);
	}
	if (f.userId) where.push('g.user_id = ?'), params.push(f.userId);
	if (f.resourceId) where.push('g.resource_id = ?'), params.push(f.resourceId);
	if (f.resourceIds) {
		if (!f.resourceIds.length) return [];
		where.push(`g.resource_id IN (${f.resourceIds.map(() => '?').join(',')})`);
		params.push(...f.resourceIds);
	}
	if (f.expiringWithinDays !== undefined) {
		where.push('g.expires_at IS NOT NULL AND g.expires_at <= ?');
		params.push(new Date(Date.now() + f.expiringWithinDays * DAY).toISOString());
	}
	if (f.q) {
		const q = `%${f.q.toLowerCase()}%`;
		where.push('(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(r.name) LIKE ? OR LOWER(rr.name) LIKE ?)');
		params.push(q, q, q, q);
	}
	const rows = await db.all<Row>(`${GRANT_SELECT} WHERE ${where.join(' AND ')} ORDER BY LOWER(r.name), LOWER(CASE WHEN u.name = '' THEN u.email ELSE u.name END)`, params);
	return rows.map(toGrant);
}

/**
 * Records access someone already has (set up before ac·modern, or outside it), so it
 * shows up in reviews and offboarding. No request, no provisioning.
 */
export async function recordGrant(
	db: Db,
	actor: Actor & { userId: string },
	input: { userId: string; resourceId: string; roleId: string; expiresAt: string | null; note: string; source: GrantSource }
) {
	const resource = await getResource(db, actor.orgId, input.resourceId);
	const role = await getRole(db, actor.orgId, resource.id, input.roleId);
	const member = await db.get<{ name: string; email: string }>(
		'SELECT u.name, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?',
		[actor.orgId, input.userId]
	);
	if (!member) throw badRequest('That person isn’t a member');
	// Recorded access skips the request process, so the evidence needs to say where it came from.
	if (input.note.trim().length < 3) throw badRequest('Say where this access came from, e.g. “Granted before ac·modern, per IT sheet”');
	if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw badRequest('Enter a valid expiry date');
	return db.tx(async (tx) => {
		if (await tx.get("SELECT 1 FROM grants WHERE org_id = ? AND user_id = ? AND role_id = ? AND status <> 'revoked'", [actor.orgId, input.userId, role.id])) {
			throw conflict(`${member.name || member.email} already has ${resource.name} (${role.name})`);
		}
		const id = newId();
		await tx.run(
			"INSERT INTO grants (id, org_id, user_id, resource_id, role_id, status, source, note, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
			[id, actor.orgId, input.userId, resource.id, role.id, input.source, input.note, now(), input.expiresAt ? new Date(input.expiresAt).toISOString() : null]
		);
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'grant.recorded',
			subject: resource.name,
			summary: `Recorded existing access: ${member.name || member.email} has ${resource.name} (${role.name})${role.privileged ? ' [privileged]' : ''}: “${input.note.trim()}”`,
			data: { grantId: id, note: input.note, privileged: role.privileged }
		});
		return id;
	});
}

/** Deactivates a member and opens removal requests for everything they hold. */
export async function offboard(db: Db, actor: Actor, userId: string, note: string, fx: Effects, reason: 'offboarding' | 'directory' = 'offboarding', leftAt: string | null = null) {
	if (userId === actor.userId) throw badRequest('You can’t offboard yourself');
	return db.tx(async (tx) => {
		const p = await tx.get<{ role: string; name: string; email: string }>('SELECT m.role, u.name, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?', [
			actor.orgId,
			userId
		]);
		if (!p) throw badRequest('That person isn’t a member');
		if (p.role === 'owner') {
			const owners = await tx.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM members WHERE org_id = ? AND role = 'owner' AND status = 'active'", [actor.orgId]);
			if (owners!.n <= 1) throw badRequest('Make someone else an owner first');
		}
		await tx.run("UPDATE members SET status = 'deactivated', deactivated_by = ? WHERE org_id = ? AND user_id = ?", [reason === 'directory' ? 'directory' : 'manual', actor.orgId, userId]);
		await tx.run('DELETE FROM sessions WHERE user_id = ? AND org_id = ?', [userId, actor.orgId]);
		// Their open requests go nowhere now.
		const t = now();
		await tx.run(
			"UPDATE requests SET status = 'cancelled', updated_at = ?, closed_at = ? WHERE org_id = ? AND user_id = ? AND kind = 'grant' AND status IN ('pending_approval', 'pending_fulfillment')",
			[t, t, actor.orgId, userId]
		);
		const grants = await tx.all<{ id: string }>("SELECT id FROM grants WHERE org_id = ? AND user_id = ? AND status = 'active'", [actor.orgId, userId]);
		for (const g of grants) await startRevoke(tx, actor, g.id, reason, note, fx);
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'member.offboarded',
			subject: p.name || p.email,
			summary: `Offboarded ${p.name || p.email}: ${grants.length} ${grants.length === 1 ? 'access removal' : 'access removals'} opened`,
			data: { userId, note, leftAt, removals: grants.length, via: reason }
		});
		return grants.length;
	});
}

/** Expired grants become removal requests; grants about to expire get a reminder. */
export async function sweepExpiry(db: Db, orgId: string, reminderDays: number, fx: Effects) {
	const t = now();
	const expired = await db.all<{ id: string }>("SELECT id FROM grants WHERE org_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?", [orgId, t]);
	for (const g of expired) await db.tx((tx) => startRevoke(tx, { orgId, userId: null, admin: true }, g.id, 'expired', '', fx));

	if (reminderDays > 0) {
		const soon = new Date(Date.now() + reminderDays * DAY).toISOString();
		const rows = await db.all<Row>(
			`${GRANT_SELECT} WHERE g.org_id = ? AND g.status = 'active' AND g.expires_at IS NOT NULL AND g.expires_at <= ? AND g.reminded_at IS NULL`,
			[orgId, soon]
		);
		for (const r of rows.map(toGrant)) {
			await db.run('UPDATE grants SET reminded_at = ? WHERE id = ?', [t, r.id]);
			fx.notices.push({
				orgId,
				to: [r.user.id],
				subject: `Expiring soon: ${r.resource.name} (${r.role.name})`,
				text: `Your ${r.resource.name} (${r.role.name}) access ends on ${r.expiresAt!.slice(0, 10)}. Still need it? Request an extension before then.`,
				path: `/access?mine=1`
			});
		}
	}
	return expired.length;
}
