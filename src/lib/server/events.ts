import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import type { Event } from '#lib/types.ts';

/**
 * The audit log. Every change worth knowing about lands here; a request's timeline is
 * the events with its request_id (comments included).
 */
export async function record(
	db: Db,
	e: { orgId: string; actorId: string | null; action: string; summary: string; requestId?: string | null; subject?: string; data?: Record<string, unknown> }
) {
	await db.run('INSERT INTO events (id, org_id, at, actor_id, action, request_id, subject, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
		newId(),
		e.orgId,
		new Date().toISOString(),
		e.actorId,
		e.action,
		e.requestId ?? null,
		e.subject ?? '',
		e.summary,
		JSON.stringify(e.data ?? {})
	]);
}

interface Row {
	id: string;
	at: string;
	actor_id: string | null;
	actor_email: string | null;
	actor_name: string | null;
	action: string;
	number: number | null;
	subject: string;
	summary: string;
	data: string;
}

const SELECT = `SELECT e.id, e.at, e.actor_id, u.email AS actor_email, u.name AS actor_name, e.action, r.number, e.subject, e.summary, e.data
	FROM events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN requests r ON r.id = e.request_id`;

const toEvent = (r: Row): Event => ({
	id: r.id,
	at: r.at,
	actor: r.actor_id ? { id: r.actor_id, email: r.actor_email ?? '', name: r.actor_name ?? '' } : null,
	action: r.action,
	requestNumber: r.number,
	subject: r.subject,
	summary: r.summary,
	data: JSON.parse(r.data || '{}')
});

export async function requestTimeline(db: Db, orgId: string, requestId: string): Promise<Event[]> {
	return (await db.all<Row>(`${SELECT} WHERE e.org_id = ? AND e.request_id = ? ORDER BY e.at, e.id`, [orgId, requestId])).map(toEvent);
}

export async function listEvents(db: Db, orgId: string, opts: { q?: string; before?: string; limit?: number; actorId?: string } = {}): Promise<Event[]> {
	const where = ['e.org_id = ?'];
	const params: (string | number)[] = [orgId];
	if (opts.before) {
		where.push('e.at < ?');
		params.push(opts.before);
	}
	if (opts.actorId) {
		where.push('e.actor_id = ?');
		params.push(opts.actorId);
	}
	if (opts.q) {
		where.push('(LOWER(e.summary) LIKE ? OR LOWER(e.action) LIKE ? OR LOWER(e.subject) LIKE ?)');
		const q = `%${opts.q.toLowerCase()}%`;
		params.push(q, q, q);
	}
	params.push(opts.limit ?? 100);
	return (await db.all<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.at DESC, e.id DESC LIMIT ?`, params)).map(toEvent);
}
