import { adminIds, orgSettings } from './accounts.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { fulfillersFor, type Effects } from './requests.ts';
import { getResource } from './resources.ts';
import type { Leaver } from '#lib/types.ts';

export type { Leaver };

/**
 * Leavers: how quickly access was removed after someone left. Auditors sample people who
 * left in the period and compare their last day with when each piece of access went.
 * The clock starts at the end of their last day (if one was given when offboarding) or
 * when they were offboarded or deactivated, and stops when the last removal was done.
 */

const HOUR = 3_600_000;
export const DEFAULT_REMOVAL_SLA_HOURS = 24;

export async function leavers(db: Db, orgId: string, from: string, to: string, at = new Date().toISOString()): Promise<{ slaHours: number; rows: Leaver[] }> {
	const slaHours = (await orgSettings(db, orgId)).removalSlaHours ?? DEFAULT_REMOVAL_SLA_HOURS;
	const events = await db.all<{ at: string; action: string; subject: string; data: string; actor_name: string | null; actor_email: string | null }>(
		`SELECT e.at, e.action, e.subject, e.data, u.name AS actor_name, u.email AS actor_email FROM events e LEFT JOIN users u ON u.id = e.actor_id
		 WHERE e.org_id = ? AND e.action IN ('member.offboarded', 'member.deactivated') AND e.at >= ? AND e.at < ? ORDER BY e.at`,
		[orgId, from, to]
	);
	const rows: Leaver[] = [];
	for (const e of events) {
		const data = JSON.parse(e.data || '{}') as { userId?: string; leftAt?: string | null; via?: string };
		// Older deactivation events named the person by email only.
		const user = data.userId
			? await db.get<{ id: string; name: string; email: string }>('SELECT id, name, email FROM users WHERE id = ?', [data.userId])
			: await db.get<{ id: string; name: string; email: string }>('SELECT id, name, email FROM users WHERE email = ?', [e.subject.toLowerCase()]);
		if (!user) continue;
		const since = new Date(Date.parse(e.at) - 60_000).toISOString();
		const removals = await db.all<{ status: string; closed_at: string | null }>(
			"SELECT status, closed_at FROM requests WHERE org_id = ? AND user_id = ? AND kind = 'revoke' AND reason IN ('offboarding', 'directory') AND created_at >= ?",
			[orgId, user.id, since]
		);
		const done = removals.filter((r) => r.status === 'completed');
		const pending = removals.filter((r) => r.status === 'pending_fulfillment').length;
		const lastRemovedAt = done.map((r) => r.closed_at!).sort().at(-1) ?? null;
		const start = Date.parse(data.leftAt ?? e.at);
		const stillActive = Number(
			(await db.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM grants WHERE org_id = ? AND user_id = ? AND status <> 'revoked'", [orgId, user.id]))!.n
		);
		const end = pending || stillActive ? Date.parse(at) : lastRemovedAt ? Date.parse(lastRemovedAt) : Date.parse(e.at);
		const hours = Math.max(0, Math.round(((end - start) / HOUR) * 10) / 10);
		const grantedAfter = Number(
			(await db.get<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM grants WHERE org_id = ? AND user_id = ? AND granted_at > ?', [orgId, user.id, e.at]))!.n
		);
		rows.push({
			userId: user.id,
			name: user.name,
			email: user.email,
			at: e.at,
			leftAt: data.leftAt ?? null,
			how: e.action === 'member.offboarded' ? 'offboarded' : 'deactivated',
			by: data.via === 'directory' || (!e.actor_name && !e.actor_email) ? 'Identity provider' : e.actor_name || e.actor_email || '',
			removals: removals.length,
			removed: done.length,
			pending,
			lastRemovedAt,
			hours,
			onTime: pending || stillActive ? (hours > slaHours ? false : null) : hours <= slaHours,
			stillActive,
			grantedAfter
		});
	}
	return { slaHours, rows };
}

export function leaversCsv(rows: Leaver[], slaHours: number): string {
	const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
	const head = ['person', 'email', 'last_day', 'offboarded_at', 'how', 'by', 'removals', 'removed', 'pending', 'last_removed_at', 'hours_to_remove', `within_${slaHours}h`, 'still_active', 'granted_after_leaving'];
	return [
		head.join(','),
		...rows.map((r) =>
			[r.name, r.email, r.leftAt ?? '', r.at, r.how, r.by, r.removals, r.removed, r.pending, r.lastRemovedAt ?? '', r.hours, r.onTime === null ? 'in progress' : r.onTime ? 'yes' : 'no', r.stillActive, r.grantedAfter]
				.map(cell)
				.join(',')
		)
	].join('\n');
}

/**
 * Removals waiting longer than the target: the fulfillers and admins hear about them,
 * once a day while they stay open, and each escalation is logged.
 */
export async function escalateRemovals(db: Db, orgId: string, fx: Effects, at = new Date().toISOString()) {
	const slaHours = (await orgSettings(db, orgId)).removalSlaHours ?? DEFAULT_REMOVAL_SLA_HOURS;
	const t = Date.parse(at);
	const overdue = await db.all<{ id: string; number: number; created_at: string; resource_id: string; resource_name: string; role_name: string; user_name: string; user_email: string }>(
		`SELECT q.id, q.number, q.created_at, q.resource_id, r.name AS resource_name, rr.name AS role_name, u.name AS user_name, u.email AS user_email
		 FROM requests q JOIN resources r ON r.id = q.resource_id JOIN resource_roles rr ON rr.id = q.role_id JOIN users u ON u.id = q.user_id
		 WHERE q.org_id = ? AND q.kind = 'revoke' AND q.status = 'pending_fulfillment' AND q.created_at <= ? AND (q.escalated_at IS NULL OR q.escalated_at <= ?)
		 ORDER BY q.created_at`,
		[orgId, new Date(t - slaHours * HOUR).toISOString(), new Date(t - 24 * HOUR).toISOString()]
	);
	if (!overdue.length) return 0;
	const admins = await adminIds(db, orgId);
	const lines = new Map<string, string[]>();
	for (const q of overdue) {
		const hours = Math.round((t - Date.parse(q.created_at)) / HOUR);
		const line = `#${q.number} ${q.user_name || q.user_email}: ${q.resource_name} (${q.role_name}), waiting ${hours} hours`;
		const to = new Set([...(await fulfillersFor(db, orgId, await getResource(db, orgId, q.resource_id))), ...admins]);
		for (const id of to) lines.set(id, [...(lines.get(id) ?? []), line]);
		await db.run('UPDATE requests SET escalated_at = ? WHERE id = ?', [at, q.id]);
		await record(db, { orgId, actorId: null, action: 'request.overdue', requestId: q.id, subject: q.resource_name, summary: `Removal still not done after ${hours} hours (target ${slaHours})`, data: { hours, slaHours } });
	}
	for (const [id, list] of lines)
		fx.notices.push({
			orgId,
			to: [id],
			subject: `Overdue: ${list.length} access ${list.length === 1 ? 'removal' : 'removals'} past ${slaHours} hours`,
			text: `These removals are past the ${slaHours}-hour target. Take the access away, then mark each one done:\n${list.join('\n')}`,
			path: '/requests?view=fulfill'
		});
	return overdue.length;
}
