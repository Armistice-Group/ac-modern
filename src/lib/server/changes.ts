import { getPerson, updateMember } from './accounts.ts';
import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, forbidden, HttpError } from './http.ts';
import { type Actor, createRequest, type Effects, startRevoke } from './requests.ts';

/**
 * Onboarding and transfers: several access changes for one person, made together with one
 * reason. Each addition is still its own request with its own approvals (that's the
 * evidence), grouped by a batch so the whole change can be shown and sampled as one.
 */
export interface AccessChange {
	userId: string;
	kind: 'onboarding' | 'transfer';
	reason: string;
	add: { resourceId: string; roleId: string; durationDays: number | null }[];
	/** Grant ids to remove (transfers). */
	remove: string[];
	/** Transfers: their new title and manager, applied first so the new manager approves. */
	title?: string;
	managerId?: string | null;
}

export async function applyAccessChange(db: Db, actor: Actor & { userId: string }, input: AccessChange, fx: Effects) {
	const person = await getPerson(db, actor.orgId, input.userId);
	if (person.status !== 'active') throw badRequest('That person isn’t an active member');
	const isManager = person.managerId === actor.userId;
	if (!actor.admin && !isManager) throw forbidden('Only admins and their manager can change their access');
	if (input.userId === actor.userId) throw badRequest('Ask your manager or an admin to change your own access');
	if (input.reason.trim().length < 3) throw badRequest(input.kind === 'onboarding' ? 'Say what they’re joining as, e.g. “New backend engineer”' : 'Say what’s changing, e.g. “Moving to the platform team”');
	if (!input.add.length && !input.remove.length) throw badRequest('Choose access to add or remove');
	if (input.kind === 'onboarding' && input.remove.length) throw badRequest('Onboarding only adds access');

	const batchId = newId();
	await db.run('INSERT INTO request_batches (id, org_id, kind, user_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
		batchId,
		actor.orgId,
		input.kind,
		input.userId,
		input.reason.trim(),
		actor.userId,
		new Date().toISOString()
	]);

	if (input.kind === 'transfer' && (input.title !== undefined || input.managerId !== undefined)) {
		if (!actor.admin && input.managerId !== undefined && input.managerId !== person.managerId) throw forbidden('Only admins can change someone’s manager');
		if (input.managerId) await getPerson(db, actor.orgId, input.managerId);
		if (input.managerId === input.userId) throw badRequest('Someone can’t be their own manager');
		await updateMember(db, actor.orgId, input.userId, { title: input.title, managerId: input.managerId });
	}

	const created: number[] = [];
	const skipped: string[] = [];
	for (const a of input.add) {
		try {
			const r = await createRequest(
				db,
				actor,
				{ userId: input.userId, resourceId: a.resourceId, roleId: a.roleId, durationDays: a.durationDays, justification: input.reason.trim(), category: input.kind === 'onboarding' ? 'new_hire' : 'transfer', batchId },
				fx
			);
			created.push(r.number);
		} catch (err) {
			if (!(err instanceof HttpError)) throw err;
			skipped.push(err.message);
		}
	}
	let removals = 0;
	for (const grantId of input.remove) {
		const g = await db.get<{ user_id: string }>('SELECT user_id FROM grants WHERE org_id = ? AND id = ?', [actor.orgId, grantId]);
		if (g?.user_id !== input.userId) throw badRequest('Some of the access to remove isn’t theirs');
		const r = await db.tx((tx) => startRevoke(tx, actor, grantId, 'transfer', input.reason, fx, batchId));
		if (r) (created.push(r.number), removals++);
	}
	await record(db, {
		orgId: actor.orgId,
		actorId: actor.userId,
		action: input.kind === 'onboarding' ? 'member.onboarding' : 'member.transferred',
		subject: person.name || person.email,
		summary: `${input.kind === 'onboarding' ? 'Onboarding' : 'Transfer'} for ${person.name || person.email}: ${created.length - removals} to add, ${removals} to remove (“${input.reason.trim()}”)`,
		data: { batchId, requests: created, title: input.title, managerId: input.managerId }
	});
	return { batchId, created, skipped };
}

export async function getBatch(db: Db, orgId: string, id: string) {
	return db.get<{ id: string; kind: 'onboarding' | 'transfer'; reason: string; created_at: string; created_by_name: string | null }>(
		`SELECT b.id, b.kind, b.reason, b.created_at, COALESCE(NULLIF(u.name, ''), u.email) AS created_by_name
		 FROM request_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.org_id = ? AND b.id = ?`,
		[orgId, id]
	);
}
