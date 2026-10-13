import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { GRANT_SELECT, toGrant } from './grants.ts';
import { badRequest, conflict, forbidden, notFound } from './http.ts';
import { type Actor, type Effects, startRevoke } from './requests.ts';
import { listResources } from './resources.ts';
import type { Review, ReviewItem } from '#lib/types.ts';

const now = () => new Date().toISOString();

interface ReviewRow {
	id: string;
	name: string;
	status: 'open' | 'closed';
	due_at: string | null;
	created_at: string;
	closed_at: string | null;
	total: number;
	decided: number;
	revoked: number;
}

const REVIEW_SELECT = `SELECT v.id, v.name, v.status, v.due_at, v.created_at, v.closed_at,
	CAST(COUNT(i.id) AS INTEGER) AS total,
	CAST(SUM(CASE WHEN i.decision IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) AS decided,
	CAST(SUM(CASE WHEN i.decision = 'revoke' THEN 1 ELSE 0 END) AS INTEGER) AS revoked
	FROM reviews v LEFT JOIN review_items i ON i.review_id = v.id`;

const toReview = (r: ReviewRow): Review => ({
	id: r.id,
	name: r.name,
	status: r.status,
	dueAt: r.due_at,
	createdAt: r.created_at,
	closedAt: r.closed_at,
	total: Number(r.total ?? 0),
	decided: Number(r.decided ?? 0),
	revoked: Number(r.revoked ?? 0)
});

export async function listReviews(db: Db, orgId: string): Promise<Review[]> {
	const rows = await db.all<ReviewRow>(
		`${REVIEW_SELECT} WHERE v.org_id = ? GROUP BY v.id, v.name, v.status, v.due_at, v.created_at, v.closed_at ORDER BY v.status DESC, v.created_at DESC`,
		[orgId]
	);
	return rows.map(toReview);
}

export async function getReview(db: Db, orgId: string, id: string): Promise<Review> {
	const r = await db.get<ReviewRow>(`${REVIEW_SELECT} WHERE v.org_id = ? AND v.id = ? GROUP BY v.id, v.name, v.status, v.due_at, v.created_at, v.closed_at`, [orgId, id]);
	if (!r) throw notFound('That review doesn’t exist');
	return toReview(r);
}

export async function reviewItems(db: Db, orgId: string, reviewId: string): Promise<ReviewItem[]> {
	const rows = await db.all<Record<string, never> & { item_id: string; reviewer_id: string | null; reviewer_name: string | null; reviewer_email: string | null; decision: 'keep' | 'revoke' | null; item_note: string; decided_at: string | null }>(
		`SELECT x.*, i.id AS item_id, i.reviewer_id, ru.name AS reviewer_name, ru.email AS reviewer_email, i.decision, i.note AS item_note, i.decided_at
		 FROM review_items i
		 JOIN (${GRANT_SELECT}) x ON x.id = i.grant_id
		 LEFT JOIN users ru ON ru.id = i.reviewer_id
		 WHERE i.org_id = ? AND i.review_id = ?
		 ORDER BY LOWER(x.resource_name), LOWER(x.user_email)`,
		[orgId, reviewId]
	);
	return rows.map((r) => ({
		id: r.item_id,
		grant: toGrant(r as never),
		reviewerId: r.reviewer_id,
		reviewerName: r.reviewer_name || r.reviewer_email,
		decision: r.decision,
		note: r.item_note,
		decidedAt: r.decided_at
	}));
}

/**
 * Starts a review of every active grant on the chosen resources. Each item goes to the
 * resource owner (else its first approver, else whoever started the review).
 */
export async function createReview(db: Db, actor: Actor & { userId: string }, input: { name: string; dueAt: string | null; resourceIds: string[] }, fx: Effects) {
	if (!input.name) throw badRequest('Name the review, e.g. “Q4 access review”');
	const resources = (await listResources(db, actor.orgId)).filter((r) => !input.resourceIds.length || input.resourceIds.includes(r.id));
	if (!resources.length) throw badRequest('Pick at least one resource to review');
	return db.tx(async (tx) => {
		const id = newId();
		await tx.run('INSERT INTO reviews (id, org_id, name, status, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
			id,
			actor.orgId,
			input.name,
			'open',
			input.dueAt,
			actor.userId,
			now()
		]);
		let count = 0;
		const reviewers = new Map<string, number>();
		for (const r of resources) {
			const reviewer = r.ownerId ?? r.approverIds[0] ?? actor.userId;
			const grants = await tx.all<{ id: string; user_id: string }>("SELECT id, user_id FROM grants WHERE org_id = ? AND resource_id = ? AND status = 'active'", [actor.orgId, r.id]);
			for (const g of grants) {
				// Nobody reviews their own access; it goes to whoever started the review.
				const who = g.user_id === reviewer ? actor.userId : reviewer;
				await tx.run('INSERT INTO review_items (id, org_id, review_id, grant_id, reviewer_id) VALUES (?, ?, ?, ?, ?)', [newId(), actor.orgId, id, g.id, who]);
				reviewers.set(who, (reviewers.get(who) ?? 0) + 1);
				count++;
			}
		}
		if (!count) throw badRequest('Nobody has access to those resources yet, so there’s nothing to review');
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'review.started',
			subject: input.name,
			summary: `Started review “${input.name}”: ${count} grants across ${resources.length} resources`,
			data: { reviewId: id }
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

export async function decideItem(db: Db, actor: Actor & { userId: string }, itemId: string, decision: 'keep' | 'revoke', note: string, fx: Effects) {
	return db.tx(async (tx) => {
		const item = await tx.get<{ id: string; review_id: string; grant_id: string; reviewer_id: string | null; decision: string | null; status: string }>(
			'SELECT i.id, i.review_id, i.grant_id, i.reviewer_id, i.decision, v.status FROM review_items i JOIN reviews v ON v.id = i.review_id WHERE i.org_id = ? AND i.id = ?',
			[actor.orgId, itemId]
		);
		if (!item) throw notFound('That review item doesn’t exist');
		if (item.status !== 'open') throw conflict('This review is closed');
		if (item.reviewer_id !== actor.userId && !actor.admin) throw forbidden('This item is assigned to someone else');
		if (item.decision === 'revoke') throw conflict('Already revoked; the removal is under way');
		await tx.run('UPDATE review_items SET decision = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?', [decision, note, actor.userId, now(), item.id]);
		if (decision === 'revoke') {
			const g = await tx.get<{ status: string }>('SELECT status FROM grants WHERE id = ?', [item.grant_id]);
			if (g?.status === 'active') await startRevoke(tx, actor, item.grant_id, 'review', note, fx);
		}
	});
}

export async function closeReview(db: Db, actor: Actor & { userId: string }, id: string) {
	const review = await getReview(db, actor.orgId, id);
	if (review.status === 'closed') return;
	await db.run("UPDATE reviews SET status = 'closed', closed_at = ? WHERE org_id = ? AND id = ?", [now(), actor.orgId, id]);
	await record(db, {
		orgId: actor.orgId,
		actorId: actor.userId,
		action: 'review.closed',
		subject: review.name,
		summary: `Closed review “${review.name}”: ${review.decided}/${review.total} decided, ${review.revoked} revoked`,
		data: { reviewId: id }
	});
}

/** Open review items assigned to this person, for the overview. */
export async function pendingReviewCount(db: Db, orgId: string, userId: string): Promise<number> {
	return (
		await db.get<{ n: number }>(
			"SELECT CAST(COUNT(*) AS INTEGER) AS n FROM review_items i JOIN reviews v ON v.id = i.review_id WHERE i.org_id = ? AND i.reviewer_id = ? AND i.decision IS NULL AND v.status = 'open'",
			[orgId, userId]
		)
	)!.n;
}
