import { adminIds } from './accounts.ts';
import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { GRANT_SELECT, toGrant } from './grants.ts';
import { badRequest, conflict, forbidden, ids, int, notFound, oneOf, str } from './http.ts';
import { type Actor, type Effects, startRevoke } from './requests.ts';
import { listResources } from './resources.ts';
import type { RequestStatus, Review, ReviewerCapacity, ReviewerMode, ReviewFrequency, ReviewItem, ReviewPolicy } from '#lib/types.ts';

/**
 * Access reviews: every grant in scope goes to a reviewer (the system owner, or the
 * person's manager) to keep or revoke; a revoke opens a removal. Review policies start
 * reviews on a schedule (monthly, quarterly…), and the jobs remind reviewers before the
 * due date and escalate to admins when a review runs late.
 */

const now = () => new Date().toISOString();
const DAY = 86_400_000;

// ── Reading ──────────────────────────────────────────────────────────────────

interface ReviewRow {
	id: string;
	name: string;
	status: 'open' | 'closed';
	due_at: string | null;
	created_at: string;
	closed_at: string | null;
	policy_id: string | null;
	policy_name: string | null;
	scope: string;
	total: number;
	decided: number;
	revoked: number;
	removed: number;
}

const REVIEW_SELECT = `SELECT v.id, v.name, v.status, v.due_at, v.created_at, v.closed_at, v.policy_id, p.name AS policy_name, v.scope,
	CAST(COUNT(i.id) AS INTEGER) AS total,
	CAST(SUM(CASE WHEN i.decision IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) AS decided,
	CAST(SUM(CASE WHEN i.decision = 'revoke' THEN 1 ELSE 0 END) AS INTEGER) AS revoked,
	CAST(SUM(CASE WHEN i.decision = 'revoke' AND g.status = 'revoked' THEN 1 ELSE 0 END) AS INTEGER) AS removed
	FROM reviews v
	LEFT JOIN review_policies p ON p.id = v.policy_id
	LEFT JOIN review_items i ON i.review_id = v.id
	LEFT JOIN grants g ON g.id = i.grant_id`;
const REVIEW_GROUP = 'GROUP BY v.id, v.name, v.status, v.due_at, v.created_at, v.closed_at, v.policy_id, p.name, v.scope';

const toReview = (r: ReviewRow): Review => ({
	id: r.id,
	name: r.name,
	status: r.status,
	dueAt: r.due_at,
	createdAt: r.created_at,
	closedAt: r.closed_at,
	policyId: r.policy_id,
	policyName: r.policy_name,
	scope: JSON.parse(r.scope || '{}'),
	total: Number(r.total ?? 0),
	decided: Number(r.decided ?? 0),
	revoked: Number(r.revoked ?? 0),
	removed: Number(r.removed ?? 0)
});

export async function listReviews(db: Db, orgId: string): Promise<Review[]> {
	const rows = await db.all<ReviewRow>(`${REVIEW_SELECT} WHERE v.org_id = ? ${REVIEW_GROUP} ORDER BY v.status DESC, v.created_at DESC`, [orgId]);
	return rows.map(toReview);
}

export async function getReview(db: Db, orgId: string, id: string): Promise<Review> {
	const r = await db.get<ReviewRow>(`${REVIEW_SELECT} WHERE v.org_id = ? AND v.id = ? ${REVIEW_GROUP}`, [orgId, id]);
	if (!r) throw notFound('That review doesn’t exist');
	return toReview(r);
}

export async function reviewItems(db: Db, orgId: string, reviewId: string): Promise<ReviewItem[]> {
	const rows = await db.all<
		Record<string, never> & {
			item_id: string;
			reviewer_id: string | null;
			reviewer_name: string | null;
			reviewer_email: string | null;
			capacity: ReviewerCapacity;
			decision: 'keep' | 'revoke' | null;
			item_note: string;
			decided_at: string | null;
			decider_name: string | null;
			decider_email: string | null;
			privileged: number | null;
			removal_number: number | null;
			removal_status: RequestStatus | null;
			removal_closed_at: string | null;
		}
	>(
		`SELECT x.*, i.id AS item_id, i.reviewer_id, ru.name AS reviewer_name, ru.email AS reviewer_email, i.capacity, i.decision, i.note AS item_note, i.decided_at,
			du.name AS decider_name, du.email AS decider_email, pr.privileged, rm.number AS removal_number, rm.status AS removal_status, rm.closed_at AS removal_closed_at
		 FROM review_items i
		 JOIN (${GRANT_SELECT}) x ON x.id = i.grant_id
		 LEFT JOIN resource_roles pr ON pr.id = x.role_id
		 LEFT JOIN users ru ON ru.id = i.reviewer_id
		 LEFT JOIN users du ON du.id = i.decided_by
		 LEFT JOIN requests rm ON rm.id = i.removal_request_id
		 WHERE i.org_id = ? AND i.review_id = ?
		 ORDER BY LOWER(x.resource_name), LOWER(x.user_email)`,
		[orgId, reviewId]
	);
	return rows.map((r) => ({
		id: r.item_id,
		grant: toGrant(r as never),
		privileged: !!r.privileged,
		reviewerId: r.reviewer_id,
		reviewerName: r.reviewer_name || r.reviewer_email,
		capacity: r.capacity,
		decision: r.decision,
		note: r.item_note,
		decidedAt: r.decided_at,
		decidedBy: r.decider_name || r.decider_email,
		removal: r.removal_number === null ? null : { number: Number(r.removal_number), status: r.removal_status!, closedAt: r.removal_closed_at }
	}));
}

// ── Starting a review ────────────────────────────────────────────────────────

export interface NewReview {
	name: string;
	dueAt: string | null;
	/** Systems to cover (empty: all). */
	resourceIds: string[];
	/** Only privileged access levels. */
	privilegedOnly?: boolean;
	reviewer?: ReviewerMode;
	policyId?: string | null;
	frequency?: ReviewFrequency;
}

/**
 * Starts a review of every active grant in scope. Each item goes to a reviewer who isn't
 * the person holding the access: with reviewer "manager", their manager first; then the
 * system owner, its approvers, whoever started the review, and finally an admin.
 * Returns null (and logs it) when a scheduled review finds nothing to review.
 */
export async function createReview(db: Db, actor: Actor, input: NewReview, fx: Effects): Promise<string | null> {
	if (!input.name) throw badRequest('Name the review, e.g. “Q4 access review”');
	const mode = input.reviewer ?? 'owner';
	const resources = (await listResources(db, actor.orgId)).filter((r) => !r.archived && (!input.resourceIds.length || input.resourceIds.includes(r.id)));
	if (!resources.length) throw badRequest('Pick at least one resource to review');
	return db.tx(async (tx) => {
		const active = new Set((await tx.all<{ user_id: string }>("SELECT user_id FROM members WHERE org_id = ? AND status = 'active'", [actor.orgId])).map((m) => m.user_id));
		const managers = new Map((await tx.all<{ user_id: string; manager_id: string | null }>('SELECT user_id, manager_id FROM members WHERE org_id = ?', [actor.orgId])).map((m) => [m.user_id, m.manager_id]));
		const admins = await adminIds(tx, actor.orgId);
		const pick = (subject: string, r: (typeof resources)[number]): [string, ReviewerCapacity] => {
			const candidates: [string | null | undefined, ReviewerCapacity][] = [
				...(mode === 'manager' ? [[managers.get(subject), 'manager'] as [string | null | undefined, ReviewerCapacity]] : []),
				[r.ownerId, 'owner'],
				...r.approverIds.map((a) => [a, 'approver'] as [string, ReviewerCapacity]),
				[actor.userId, 'admin'],
				...admins.map((a) => [a, 'admin'] as [string, ReviewerCapacity])
			];
			for (const [id, cap] of candidates) if (id && id !== subject && active.has(id)) return [id, cap];
			// A one-person team: nobody else could review it.
			return [actor.userId ?? subject, 'admin'];
		};

		const id = newId();
		const scope = { scope: input.privilegedOnly ? 'privileged' : 'all', resourceIds: input.resourceIds, reviewer: mode, ...(input.frequency ? { frequency: input.frequency } : {}) };
		const items: { grant: string; reviewer: string; capacity: ReviewerCapacity }[] = [];
		for (const r of resources) {
			const grants = await tx.all<{ id: string; user_id: string; privileged: number }>(
				"SELECT g.id, g.user_id, rr.privileged FROM grants g JOIN resource_roles rr ON rr.id = g.role_id WHERE g.org_id = ? AND g.resource_id = ? AND g.status = 'active'",
				[actor.orgId, r.id]
			);
			for (const g of grants) {
				if (input.privilegedOnly && !g.privileged) continue;
				const [reviewer, capacity] = pick(g.user_id, r);
				items.push({ grant: g.id, reviewer, capacity });
			}
		}
		if (!items.length) {
			if (!input.policyId) throw badRequest('Nobody has access to those resources yet, so there’s nothing to review');
			await record(tx, { orgId: actor.orgId, actorId: actor.userId, action: 'review.skipped', subject: input.name, summary: `Skipped scheduled review “${input.name}”: nothing in scope to review`, data: { policyId: input.policyId, scope } });
			return null;
		}
		await tx.run('INSERT INTO reviews (id, org_id, name, status, due_at, created_by, created_at, policy_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
			id,
			actor.orgId,
			input.name,
			'open',
			input.dueAt,
			actor.userId,
			now(),
			input.policyId ?? null,
			JSON.stringify(scope)
		]);
		const reviewers = new Map<string, number>();
		for (const it of items) {
			await tx.run('INSERT INTO review_items (id, org_id, review_id, grant_id, reviewer_id, capacity) VALUES (?, ?, ?, ?, ?, ?)', [newId(), actor.orgId, id, it.grant, it.reviewer, it.capacity]);
			reviewers.set(it.reviewer, (reviewers.get(it.reviewer) ?? 0) + 1);
		}
		const covered = new Set(items.map((i) => i.grant)).size;
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'review.started',
			subject: input.name,
			summary: `Started review “${input.name}”${input.policyId ? ' (scheduled)' : ''}: ${covered} ${input.privilegedOnly ? 'privileged ' : ''}grants across ${resources.length} resources, ${reviewers.size} reviewers`,
			data: { reviewId: id, policyId: input.policyId ?? null, scope, dueAt: input.dueAt }
		});
		for (const [userId, n] of reviewers) {
			fx.notices.push({
				orgId: actor.orgId,
				to: [userId],
				subject: `Access review: ${input.name}`,
				text: `You have ${n} ${n === 1 ? 'grant' : 'grants'} to review${input.dueAt ? ` by ${input.dueAt.slice(0, 10)}` : ''}. Keep what’s still needed, revoke the rest.`,
				path: `/reviews/${id}`
			});
		}
		return id;
	});
}

// ── Deciding ─────────────────────────────────────────────────────────────────

export async function decideItem(db: Db, actor: Actor & { userId: string }, itemId: string, decision: 'keep' | 'revoke', note: string, fx: Effects) {
	return db.tx(async (tx) => {
		const item = await tx.get<{ id: string; review_id: string; grant_id: string; reviewer_id: string | null; decision: string | null; status: string; grant_status: string; user_id: string }>(
			`SELECT i.id, i.review_id, i.grant_id, i.reviewer_id, i.decision, v.status, g.status AS grant_status, g.user_id FROM review_items i
			 JOIN reviews v ON v.id = i.review_id JOIN grants g ON g.id = i.grant_id WHERE i.org_id = ? AND i.id = ?`,
			[actor.orgId, itemId]
		);
		if (!item) throw notFound('That review item doesn’t exist');
		if (item.status !== 'open') throw conflict('This review is closed');
		if (item.reviewer_id !== actor.userId && !actor.admin) throw forbidden('This item is assigned to someone else');
		if (item.user_id === actor.userId && item.reviewer_id !== actor.userId) throw forbidden('You can’t review your own access');
		if (item.decision === 'revoke') throw conflict('Already revoked; the removal is under way');
		if (item.grant_status === 'revoked') throw conflict('That access has already been removed');
		let removal: string | null = null;
		if (decision === 'revoke') {
			if (item.grant_status === 'active') removal = (await startRevoke(tx, actor, item.grant_id, 'review', note, fx))?.id ?? null;
			// A removal already under way (offboarding, expiry) counts as this review's removal.
			removal ??= (await tx.get<{ id: string }>("SELECT id FROM requests WHERE grant_id = ? AND kind = 'revoke' AND status = 'pending_fulfillment'", [item.grant_id]))?.id ?? null;
		}
		await tx.run('UPDATE review_items SET decision = ?, note = ?, decided_by = ?, decided_at = ?, removal_request_id = ? WHERE id = ?', [decision, note, actor.userId, now(), removal, item.id]);
	});
}

/** Hands one reviewer's undecided items (or every undecided item) to someone else. */
export async function reassignItems(db: Db, actor: Actor & { userId: string }, reviewId: string, from: string | null, to: string, fx: Effects): Promise<number> {
	const review = await getReview(db, actor.orgId, reviewId);
	if (review.status !== 'open') throw conflict('This review is closed');
	const member = await db.get<{ status: string; name: string; email: string }>(
		'SELECT m.status, u.name, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?',
		[actor.orgId, to]
	);
	if (member?.status !== 'active') throw badRequest('Pick an active member to review');
	return db.tx(async (tx) => {
		// Never to the person whose access it is.
		const { changes } = await tx.run(
			`UPDATE review_items SET reviewer_id = ?, capacity = 'admin' WHERE org_id = ? AND review_id = ? AND decision IS NULL ${from ? 'AND reviewer_id = ?' : ''}
			 AND grant_id NOT IN (SELECT id FROM grants WHERE user_id = ?)`,
			from ? [to, actor.orgId, reviewId, from, to] : [to, actor.orgId, reviewId, to]
		);
		if (!changes) return 0;
		const fromName = from ? await tx.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [from]) : null;
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'review.reassigned',
			subject: review.name,
			summary: `Reassigned ${changes} undecided ${changes === 1 ? 'item' : 'items'}${fromName ? ` from ${fromName.name || fromName.email}` : ''} to ${member.name || member.email} in “${review.name}”`,
			data: { reviewId, from, to, count: changes }
		});
		fx.notices.push({
			orgId: actor.orgId,
			to: [to],
			subject: `Access review: ${review.name}`,
			text: `${changes} ${changes === 1 ? 'grant was' : 'grants were'} handed to you to review${review.dueAt ? ` by ${review.dueAt.slice(0, 10)}` : ''}.`,
			path: `/reviews/${reviewId}`
		});
		return changes;
	});
}

export async function closeReview(db: Db, actor: Actor & { userId: string }, id: string) {
	const review = await getReview(db, actor.orgId, id);
	if (review.status === 'closed') return;
	await db.run("UPDATE reviews SET status = 'closed', closed_at = ? WHERE org_id = ? AND id = ?", [now(), actor.orgId, id]);
	const late = review.dueAt && review.dueAt < now();
	await record(db, {
		orgId: actor.orgId,
		actorId: actor.userId,
		action: 'review.closed',
		subject: review.name,
		summary: `Closed review “${review.name}”: ${review.decided}/${review.total} decided, ${review.revoked} revoked${late ? ' (after its due date)' : ''}`,
		data: { reviewId: id, total: review.total, decided: review.decided, revoked: review.revoked, removed: review.removed, late: !!late }
	});
}

/** Open review items assigned to this person, for the overview. */
export async function pendingReviewCount(db: Db, orgId: string, userId: string): Promise<number> {
	return Number(
		(
			await db.get<{ n: number }>(
				"SELECT CAST(COUNT(*) AS INTEGER) AS n FROM review_items i JOIN reviews v ON v.id = i.review_id WHERE i.org_id = ? AND i.reviewer_id = ? AND i.decision IS NULL AND v.status = 'open'",
				[orgId, userId]
			)
		)!.n
	);
}

// ── Review policies ──────────────────────────────────────────────────────────

export const FREQUENCIES: ReviewFrequency[] = ['monthly', 'quarterly', 'semiannual', 'annual'];
const MONTHS: Record<ReviewFrequency, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
export const FREQUENCY_LABEL: Record<ReviewFrequency, string> = { monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every six months', annual: 'Yearly' };

/** The next run after `from`, keeping the day of the month (clamped to short months). */
export function advance(from: string, frequency: ReviewFrequency): string {
	const d = new Date(from);
	const day = d.getUTCDate();
	const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + MONTHS[frequency], 1, d.getUTCHours(), d.getUTCMinutes()));
	const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
	t.setUTCDate(Math.min(day, last));
	return t.toISOString();
}

/** "October 2026", "Q4 2026", "H2 2026", "2026": the period a review covers, by when it started. */
export function periodLabel(at: string, frequency: ReviewFrequency): string {
	const d = new Date(at);
	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	if (frequency === 'monthly') return `${d.toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${y}`;
	if (frequency === 'quarterly') return `Q${Math.floor(m / 3) + 1} ${y}`;
	if (frequency === 'semiannual') return `H${m < 6 ? 1 : 2} ${y}`;
	return String(y);
}

interface PolicyRow {
	id: string;
	name: string;
	enabled: number;
	frequency: ReviewFrequency;
	scope: 'all' | 'privileged';
	resource_ids: string;
	reviewer: ReviewerMode;
	due_days: number;
	next_run_at: string;
	last_run_at: string | null;
	created_at: string;
	updated_at: string;
}

const toPolicy = (r: PolicyRow): ReviewPolicy => ({
	id: r.id,
	name: r.name,
	enabled: !!r.enabled,
	frequency: r.frequency,
	scope: r.scope,
	resourceIds: JSON.parse(r.resource_ids),
	reviewer: r.reviewer,
	dueDays: Number(r.due_days),
	nextRunAt: r.next_run_at,
	lastRunAt: r.last_run_at,
	createdAt: r.created_at,
	updatedAt: r.updated_at
});

export async function listPolicies(db: Db, orgId: string): Promise<ReviewPolicy[]> {
	return (await db.all<PolicyRow>('SELECT * FROM review_policies WHERE org_id = ? ORDER BY created_at', [orgId])).map(toPolicy);
}

export async function getPolicy(db: Db, orgId: string, id: string): Promise<ReviewPolicy> {
	const r = await db.get<PolicyRow>('SELECT * FROM review_policies WHERE org_id = ? AND id = ?', [orgId, id]);
	if (!r) throw notFound('That review policy doesn’t exist');
	return toPolicy(r);
}

export type PolicyInput = Pick<ReviewPolicy, 'name' | 'enabled' | 'frequency' | 'scope' | 'resourceIds' | 'reviewer' | 'dueDays' | 'nextRunAt'>;

export function parsePolicy(b: Record<string, unknown>): PolicyInput {
	const next = str(b, 'nextRunAt', { required: true });
	const t = Date.parse(next.length === 10 ? `${next}T09:00:00Z` : next);
	if (Number.isNaN(t)) throw badRequest('Pick the date of the first review');
	return {
		name: str(b, 'name', { required: true, max: 80 }),
		enabled: b.enabled !== false,
		frequency: oneOf(b, 'frequency', FREQUENCIES),
		scope: oneOf(b, 'scope', ['all', 'privileged'] as const, 'all'),
		resourceIds: ids(b, 'resourceIds'),
		reviewer: oneOf(b, 'reviewer', ['owner', 'manager'] as const, 'owner'),
		dueDays: int(b, 'dueDays', { min: 1, max: 90 }) ?? 14,
		nextRunAt: new Date(t).toISOString()
	};
}

/** The policy in words: "Quarterly, privileged access on AWS and GitHub, reviewed by managers, 14 days to finish." */
export async function describePolicy(db: Db, orgId: string, p: PolicyInput): Promise<string> {
	const names = p.resourceIds.length
		? (await db.all<{ name: string }>(`SELECT name FROM resources WHERE org_id = ? AND id IN (${p.resourceIds.map(() => '?').join(',')})`, [orgId, ...p.resourceIds])).map((r) => r.name)
		: [];
	return `${FREQUENCY_LABEL[p.frequency]}, ${p.scope === 'privileged' ? 'privileged access' : 'all access'} on ${names.length ? names.join(', ') : 'every system'}, reviewed by ${p.reviewer === 'manager' ? 'each person’s manager (else the system owner)' : 'system owners'}, ${p.dueDays} days to finish`;
}

export async function savePolicy(db: Db, orgId: string, actorId: string, id: string | null, input: PolicyInput): Promise<string> {
	if (input.resourceIds.length) {
		const found = await db.all<{ id: string }>(`SELECT id FROM resources WHERE org_id = ? AND id IN (${input.resourceIds.map(() => '?').join(',')})`, [orgId, ...input.resourceIds]);
		if (found.length !== input.resourceIds.length) throw badRequest('One of the systems doesn’t exist');
	}
	const t = now();
	const description = await describePolicy(db, orgId, input);
	const cols = [input.name, input.enabled, input.frequency, input.scope, JSON.stringify(input.resourceIds), input.reviewer, input.dueDays, input.nextRunAt];
	if (id) {
		const before = await getPolicy(db, orgId, id);
		await db.run('UPDATE review_policies SET name = ?, enabled = ?, frequency = ?, scope = ?, resource_ids = ?, reviewer = ?, due_days = ?, next_run_at = ?, updated_at = ? WHERE org_id = ? AND id = ?', [...cols, t, orgId, id]);
		await record(db, {
			orgId,
			actorId,
			action: 'review_policy.updated',
			subject: input.name,
			summary: before.enabled !== input.enabled && description === (await describePolicy(db, orgId, before)) ? `${input.enabled ? 'Turned on' : 'Turned off'} review policy “${input.name}”` : `Changed review policy “${input.name}”: ${description}${input.enabled ? '' : ' (off)'}`,
			data: { ...input, description, before }
		});
		return id;
	}
	const nid = newId();
	await db.run(
		'INSERT INTO review_policies (id, org_id, name, enabled, frequency, scope, resource_ids, reviewer, due_days, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
		[nid, orgId, ...cols, actorId, t, t]
	);
	await record(db, { orgId, actorId, action: 'review_policy.created', subject: input.name, summary: `Added review policy “${input.name}”: ${description}, first on ${input.nextRunAt.slice(0, 10)}`, data: { ...input, description } });
	return nid;
}

export async function deletePolicy(db: Db, orgId: string, actorId: string, id: string) {
	const p = await getPolicy(db, orgId, id);
	await db.run('DELETE FROM review_policies WHERE org_id = ? AND id = ?', [orgId, id]);
	await record(db, { orgId, actorId, action: 'review_policy.deleted', subject: p.name, summary: `Deleted review policy “${p.name}”`, data: { ...p } });
}

/** Starts one policy's review now. `actorId` is who asked (null: the schedule). */
export async function runPolicy(db: Db, orgId: string, policy: ReviewPolicy, fx: Effects, actorId: string | null = null, at = now()): Promise<string | null> {
	return createReview(
		db,
		{ orgId, userId: actorId, admin: true },
		{
			name: `${policy.name}: ${periodLabel(at, policy.frequency)}`,
			dueAt: new Date(Date.parse(at) + policy.dueDays * DAY).toISOString(),
			resourceIds: policy.resourceIds,
			privilegedOnly: policy.scope === 'privileged',
			reviewer: policy.reviewer,
			policyId: policy.id,
			frequency: policy.frequency
		},
		fx
	);
}

/**
 * The scheduled part, run by the jobs: start reviews whose policy is due (one per policy,
 * even if the server was down for several periods), then remind and escalate.
 */
export async function runReviewSchedule(db: Db, orgId: string, fx: Effects, at = now()) {
	for (const p of await listPolicies(db, orgId)) {
		if (!p.enabled || p.nextRunAt > at) continue;
		let next = p.nextRunAt;
		while (next <= at) next = advance(next, p.frequency);
		// Move the schedule on first, so a failure can't start the same review twice.
		await db.run('UPDATE review_policies SET next_run_at = ?, last_run_at = ? WHERE id = ?', [next, at, p.id]);
		try {
			await runPolicy(db, orgId, p, fx, null, at);
		} catch (err) {
			await record(db, { orgId, actorId: null, action: 'review.failed', subject: p.name, summary: `Couldn’t start scheduled review “${p.name}”: ${(err as Error).message}`, data: { policyId: p.id } });
		}
	}
	await remindReviewers(db, orgId, fx, at);
}

/** Days before the due date that reviewers get a reminder. */
export const REMIND_DAYS = 3;
/** While a review is overdue, reviewers and admins hear about it this often. */
export const OVERDUE_EVERY_DAYS = 7;

export async function remindReviewers(db: Db, orgId: string, fx: Effects, at = now()) {
	const open = await db.all<{ id: string; name: string; due_at: string; reminded_at: string | null; overdue_notified_at: string | null }>(
		"SELECT id, name, due_at, reminded_at, overdue_notified_at FROM reviews WHERE org_id = ? AND status = 'open' AND due_at IS NOT NULL",
		[orgId]
	);
	const t = Date.parse(at);
	for (const r of open) {
		const due = Date.parse(r.due_at);
		const overdue = t > due;
		const remind = !overdue && !r.reminded_at && t >= due - REMIND_DAYS * DAY;
		const escalate = overdue && (!r.overdue_notified_at || t - Date.parse(r.overdue_notified_at) >= OVERDUE_EVERY_DAYS * DAY);
		if (!remind && !escalate) continue;
		// Undecided items on access that still exists.
		const pending = await db.all<{ reviewer_id: string; n: number; name: string; email: string }>(
			`SELECT i.reviewer_id, CAST(COUNT(*) AS INTEGER) AS n, u.name, u.email FROM review_items i JOIN grants g ON g.id = i.grant_id JOIN users u ON u.id = i.reviewer_id
			 WHERE i.review_id = ? AND i.decision IS NULL AND g.status <> 'revoked' GROUP BY i.reviewer_id, u.name, u.email`,
			[r.id]
		);
		if (!pending.length) continue;
		const day = r.due_at.slice(0, 10);
		for (const p of pending)
			fx.notices.push({
				orgId,
				to: [p.reviewer_id],
				subject: overdue ? `Overdue access review: ${r.name}` : `Access review due ${day}: ${r.name}`,
				text: `You still have ${p.n} ${Number(p.n) === 1 ? 'grant' : 'grants'} to review in “${r.name}”, ${overdue ? `which was due ${day}` : `due ${day}`}.`,
				path: `/reviews/${r.id}`
			});
		if (overdue) {
			const behind = pending.map((p) => `${p.name || p.email}: ${p.n}`).join(', ');
			fx.notices.push({ orgId, to: await adminIds(db, orgId), subject: `Overdue access review: ${r.name}`, text: `“${r.name}” was due ${day} and still has undecided items (${behind}). Remind them, or reassign their items.`, path: `/reviews/${r.id}` });
			await db.run('UPDATE reviews SET overdue_notified_at = ? WHERE id = ?', [at, r.id]);
			await record(db, { orgId, actorId: null, action: 'review.overdue', subject: r.name, summary: `“${r.name}” is overdue: ${behind}`, data: { reviewId: r.id } });
		} else await db.run('UPDATE reviews SET reminded_at = ? WHERE id = ?', [at, r.id]);
	}
}

// ── Evidence ─────────────────────────────────────────────────────────────────

const CAPACITY_LABEL: Record<ReviewerCapacity, string> = { owner: 'System owner', approver: 'Designated approver', manager: 'Manager', admin: 'Admin', '': '' };

/** Every item with who reviewed it, in what capacity, when, and whether a revoke was carried out. */
export function reviewCsv(review: Review, items: ReviewItem[]): string {
	const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
	const head = [
		'review',
		'policy',
		'started',
		'due',
		'closed',
		'resource',
		'access_level',
		'privileged',
		'person',
		'person_email',
		'granted_at',
		'source',
		'reviewer',
		'reviewer_capacity',
		'decision',
		'decided_by',
		'decided_at',
		'on_time',
		'note',
		'removal_request',
		'removal_status',
		'removed_at'
	];
	const lines = items.map((i) =>
		[
			review.name,
			review.policyName ?? '',
			review.createdAt,
			review.dueAt ?? '',
			review.closedAt ?? '',
			i.grant.resource.name,
			i.grant.role.name,
			i.privileged ? 'yes' : 'no',
			i.grant.user.name,
			i.grant.user.email,
			i.grant.grantedAt,
			i.grant.source,
			i.reviewerName ?? '',
			CAPACITY_LABEL[i.capacity],
			i.decision ?? (i.grant.status === 'revoked' ? 'removed before decision' : 'undecided'),
			i.decidedBy ?? '',
			i.decidedAt ?? '',
			i.decidedAt && review.dueAt ? (i.decidedAt <= review.dueAt ? 'yes' : 'no') : '',
			i.note,
			i.removal ? `#${i.removal.number}` : '',
			i.removal ? i.removal.status : '',
			i.removal?.status === 'completed' ? i.removal.closedAt : i.decision === 'revoke' && i.grant.revokedAt ? i.grant.revokedAt : ''
		]
			.map(cell)
			.join(',')
	);
	return [head.join(','), ...lines].join('\n');
}
