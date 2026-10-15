import { decrypt, encrypt, hmac, randomToken, sha256 } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest } from './http.ts';
import type { Verification } from '#lib/types.ts';

/**
 * Tamper evidence for the audit log, and streaming it to a store the org controls.
 *
 * Every complete UTC day is sealed: a SHA-256 digest over that day's events, chained to
 * the previous day's digest. Changing, deleting or back-dating an event changes the
 * digest of its day (and so every later one), which verification recomputes. Anyone who
 * can write the database could also rewrite the anchors, so the anchors are exported (API,
 * download) and the events can be streamed out as they happen: copies outside ac·modern
 * are what make a rewrite detectable.
 */

const DAY = 86_400_000;
const GENESIS = '0'.repeat(64);

export interface Anchor {
	day: string;
	count: number;
	digest: string;
	prevDigest: string;
	createdAt: string;
}

interface EventRow {
	id: string;
	at: string;
	actor_id: string | null;
	action: string;
	request_id: string | null;
	subject: string;
	summary: string;
	data: string;
}

const dayOf = (iso: string) => iso.slice(0, 10);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10);

/** One day's events in a fixed order and shape, so SQLite and Postgres hash the same bytes. */
async function dayEvents(db: Db, orgId: string, day: string): Promise<EventRow[]> {
	return db.all<EventRow>(
		'SELECT id, at, actor_id, action, request_id, subject, summary, data FROM events WHERE org_id = ? AND at >= ? AND at < ? ORDER BY at, id',
		[orgId, `${day}T00:00:00.000Z`, `${nextDay(day)}T00:00:00.000Z`]
	);
}

function digestOf(prev: string, events: EventRow[]): string {
	const canon = events.map((e) => [e.id, e.at, e.actor_id ?? null, e.action, e.request_id ?? null, e.subject ?? '', e.summary ?? '', e.data ?? '{}']);
	return sha256(prev + JSON.stringify(canon));
}

export async function listAnchors(db: Db, orgId: string): Promise<Anchor[]> {
	const rows = await db.all<{ day: string; count: number; digest: string; prev_digest: string; created_at: string }>(
		'SELECT day, count, digest, prev_digest, created_at FROM audit_anchors WHERE org_id = ? ORDER BY day',
		[orgId]
	);
	return rows.map((r) => ({ day: r.day, count: Number(r.count), digest: r.digest, prevDigest: r.prev_digest, createdAt: r.created_at }));
}

/**
 * Seals every complete UTC day not sealed yet, from the org's first event up to yesterday.
 * Empty days get an anchor too, so a missing day can't hide. Returns how many were sealed.
 */
export async function sealDays(db: Db, orgId: string, now = new Date().toISOString()): Promise<number> {
	const last = await db.get<{ day: string; digest: string }>('SELECT day, digest FROM audit_anchors WHERE org_id = ? ORDER BY day DESC LIMIT 1', [orgId]);
	let day: string;
	let prev: string;
	if (last) {
		day = nextDay(last.day);
		prev = last.digest;
	} else {
		const first = await db.get<{ at: string }>('SELECT MIN(at) AS at FROM events WHERE org_id = ?', [orgId]);
		if (!first?.at) return 0;
		day = dayOf(first.at);
		prev = GENESIS;
	}
	const today = dayOf(now);
	let sealed = 0;
	while (day < today) {
		const events = await dayEvents(db, orgId, day);
		const digest = digestOf(prev, events);
		await db.run('INSERT INTO audit_anchors (org_id, day, count, digest, prev_digest, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, day) DO NOTHING', [
			orgId,
			day,
			events.length,
			digest,
			prev,
			now
		]);
		prev = digest;
		day = nextDay(day);
		sealed++;
	}
	return sealed;
}

/** Recomputes every sealed day and compares it with its anchor and the chain. */
export async function verifyAuditLog(db: Db, orgId: string, now = new Date().toISOString()): Promise<Verification> {
	const anchors = await listAnchors(db, orgId);
	const broken: Verification['broken'] = [];
	let prev = GENESIS;
	for (const a of anchors) {
		const events = await dayEvents(db, orgId, a.day);
		if (a.prevDigest !== prev) broken.push({ day: a.day, reason: 'The chain of daily digests is broken here: an anchor was changed or removed' });
		else if (events.length !== a.count) broken.push({ day: a.day, reason: `${a.count} events were sealed; there are now ${events.length}` });
		else if (digestOf(prev, events) !== a.digest) broken.push({ day: a.day, reason: 'An event from this day was changed after it was sealed' });
		prev = a.digest;
	}
	if (anchors.length) {
		const before = await db.get<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM events WHERE org_id = ? AND at < ?', [orgId, `${anchors[0].day}T00:00:00.000Z`]);
		if (Number(before?.n ?? 0) > 0) broken.unshift({ day: anchors[0].day, reason: `${before!.n} events are dated before the first sealed day` });
	}
	const lastSealed = anchors.at(-1)?.day ?? null;
	const after = await db.get<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM events WHERE org_id = ? AND at >= ?', [orgId, lastSealed ? `${nextDay(lastSealed)}T00:00:00.000Z` : '']);
	return { ok: !broken.length, days: anchors.length, firstDay: anchors[0]?.day ?? null, lastSealed, broken, unsealed: Number(after?.n ?? 0), checkedAt: now };
}

/** Verifies and records that it did, with the result. */
export async function verifyAndRecord(db: Db, orgId: string, actorId: string | null): Promise<Verification> {
	const v = await verifyAuditLog(db, orgId);
	await record(db, {
		orgId,
		actorId,
		action: 'audit.verified',
		subject: 'Audit log',
		summary: v.ok
			? `Verified the audit log: ${v.days} sealed ${v.days === 1 ? 'day' : 'days'} intact${v.lastSealed ? ` (through ${v.lastSealed})` : ''}`
			: `Audit log verification failed: ${v.broken.length} ${v.broken.length === 1 ? 'day doesn’t' : 'days don’t'} match (first ${v.broken[0].day})`,
		data: { ok: v.ok, days: v.days, lastSealed: v.lastSealed, broken: v.broken }
	});
	return v;
}

// ── Streaming ────────────────────────────────────────────────────────────────

let streamFetch: typeof fetch = (...a) => fetch(...a);
/** Tests swap in a fake network. */
export function setAuditFetch(f: typeof fetch) {
	streamFetch = f;
}

export interface StreamStatus {
	url: string;
	lastDeliveredAt: string | null;
	lastError: string;
	/** Events not delivered yet. */
	behind: number;
}

const BATCH = 100;
/** Batches per job run, so one org with a long backlog can't hold up the others. */
const BATCHES_PER_RUN = 20;

export async function getStream(db: Db, orgId: string): Promise<StreamStatus | null> {
	const s = await db.get<{ url: string; cursor_at: string | null; cursor_id: string | null; last_error: string; last_delivered_at: string | null }>(
		'SELECT url, cursor_at, cursor_id, last_error, last_delivered_at FROM audit_stream WHERE org_id = ?',
		[orgId]
	);
	if (!s) return null;
	const behind = await db.get<{ n: number }>(
		`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM events WHERE org_id = ?${s.cursor_at ? ' AND (at > ? OR (at = ? AND id > ?))' : ''}`,
		s.cursor_at ? [orgId, s.cursor_at, s.cursor_at, s.cursor_id] : [orgId]
	);
	return { url: s.url, lastDeliveredAt: s.last_delivered_at, lastError: s.last_error, behind: Number(behind?.n ?? 0) };
}

/**
 * Sets where events are streamed. A new stream starts from the first event (so the store
 * gets the whole history) and gets a new signing secret, returned once.
 */
export async function saveStream(db: Db, orgId: string, url: string, rotate = false): Promise<{ secret: string | null }> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw badRequest('That isn’t a URL');
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('The URL must start with https://');
	const t = new Date().toISOString();
	const existing = await db.get<{ url: string }>('SELECT url FROM audit_stream WHERE org_id = ?', [orgId]);
	if (existing && !rotate) {
		await db.run("UPDATE audit_stream SET url = ?, last_error = '', updated_at = ? WHERE org_id = ?", [u.href, t, orgId]);
		return { secret: null };
	}
	const secret = `acm_whsec_${randomToken(24)}`;
	if (existing) await db.run('UPDATE audit_stream SET url = ?, secret = ?, updated_at = ? WHERE org_id = ?', [u.href, encrypt(secret, `org:${orgId}:audit`), t, orgId]);
	else await db.run('INSERT INTO audit_stream (org_id, url, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [orgId, u.href, encrypt(secret, `org:${orgId}:audit`), t, t]);
	return { secret };
}

export async function deleteStream(db: Db, orgId: string) {
	await db.run('DELETE FROM audit_stream WHERE org_id = ?', [orgId]);
}

async function post(url: string, secret: string, payload: unknown): Promise<void> {
	const body = JSON.stringify(payload);
	const ts = Math.floor(Date.now() / 1000).toString();
	const res = await streamFetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'user-agent': 'ac-modern', 'x-acm-event': 'audit.events', 'x-acm-timestamp': ts, 'x-acm-signature': `sha256=${hmac(secret, `${ts}.${body}`)}` },
		body,
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`${url} answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim());
}

/** A signed request with no events, to check the receiver. */
export async function testStream(db: Db, orgId: string) {
	const s = await db.get<{ url: string; secret: string }>('SELECT url, secret FROM audit_stream WHERE org_id = ?', [orgId]);
	if (!s) throw badRequest('Set a stream URL first');
	await post(s.url, decrypt(s.secret, `org:${orgId}:audit`), { org: { id: orgId }, test: true, events: [] });
}

/**
 * Sends events after the cursor, oldest first, in batches. The cursor only moves past a
 * batch the receiver accepted, so a failure is retried next run and nothing is skipped.
 */
export async function deliverStream(db: Db, orgId: string): Promise<number> {
	const s = await db.get<{ url: string; secret: string; cursor_at: string | null; cursor_id: string | null }>('SELECT url, secret, cursor_at, cursor_id FROM audit_stream WHERE org_id = ?', [orgId]);
	if (!s) return 0;
	const secret = decrypt(s.secret, `org:${orgId}:audit`);
	let cursor = { at: s.cursor_at, id: s.cursor_id };
	let sent = 0;
	for (let i = 0; i < BATCHES_PER_RUN; i++) {
		const rows = await db.all<EventRow & { actor_email: string | null; actor_name: string | null; number: number | null }>(
			`SELECT e.id, e.at, e.actor_id, u.email AS actor_email, u.name AS actor_name, e.action, e.request_id, r.number, e.subject, e.summary, e.data
			 FROM events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN requests r ON r.id = e.request_id
			 WHERE e.org_id = ?${cursor.at ? ' AND (e.at > ? OR (e.at = ? AND e.id > ?))' : ''} ORDER BY e.at, e.id LIMIT ${BATCH}`,
			cursor.at ? [orgId, cursor.at, cursor.at, cursor.id] : [orgId]
		);
		if (!rows.length) break;
		const events = rows.map((e) => ({
			id: e.id,
			at: e.at,
			actor: e.actor_id ? { id: e.actor_id, email: e.actor_email, name: e.actor_name } : null,
			action: e.action,
			request_number: e.number === null ? null : Number(e.number),
			subject: e.subject,
			summary: e.summary,
			data: JSON.parse(e.data || '{}')
		}));
		try {
			await post(s.url, secret, { org: { id: orgId }, events });
		} catch (err) {
			await db.run('UPDATE audit_stream SET last_error = ? WHERE org_id = ?', [(err as Error).message.slice(0, 500), orgId]);
			break;
		}
		const last = rows.at(-1)!;
		cursor = { at: last.at, id: last.id };
		sent += rows.length;
		await db.run("UPDATE audit_stream SET cursor_at = ?, cursor_id = ?, last_error = '', last_delivered_at = ? WHERE org_id = ?", [cursor.at, cursor.id, new Date().toISOString(), orgId]);
		if (rows.length < BATCH) break;
	}
	return sent;
}
