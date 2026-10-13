import { adminIds, nextRequestNumber, orgSettings } from './accounts.ts';
import { hmac, newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, conflict, forbidden, notFound } from './http.ts';
import type { Notice } from './notify.ts';
import { getResource, getRole, webhookSecret } from './resources.ts';
import type { AccessRequest, ApprovalPolicy, RequestReason, RequestStatus, Resource } from '#lib/types.ts';

const now = () => new Date().toISOString();
const DAY = 86_400_000;

/**
 * What a workflow step leaves behind for after the commit: emails/Slack to send and
 * webhook fulfillments to run (network calls never happen inside a transaction).
 */
export interface Effects {
	notices: Notice[];
	webhooks: string[];
}
export const effects = (): Effects => ({ notices: [], webhooks: [] });

export interface Actor {
	orgId: string;
	/** null for the system (expiry job, webhook callbacks). */
	userId: string | null;
	admin: boolean;
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
	id: string;
	number: number;
	kind: 'grant' | 'revoke';
	reason: RequestReason;
	status: RequestStatus;
	step: number;
	requester_id: string | null;
	requester_email: string | null;
	requester_name: string | null;
	user_id: string;
	user_email: string;
	user_name: string;
	resource_id: string;
	resource_name: string;
	resource_color: string;
	role_id: string;
	role_name: string;
	grant_id: string | null;
	justification: string;
	duration_days: number | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
}

const SELECT = `SELECT q.id, q.number, q.kind, q.reason, q.status, q.step, q.requester_id, rq.email AS requester_email, rq.name AS requester_name,
	q.user_id, u.email AS user_email, u.name AS user_name, q.resource_id, r.name AS resource_name, r.color AS resource_color,
	q.role_id, rr.name AS role_name, q.grant_id, q.justification, q.duration_days, q.created_at, q.updated_at, q.closed_at
	FROM requests q
	JOIN users u ON u.id = q.user_id
	LEFT JOIN users rq ON rq.id = q.requester_id
	JOIN resources r ON r.id = q.resource_id
	JOIN resource_roles rr ON rr.id = q.role_id`;

const toRequest = (r: Row): AccessRequest => ({
	id: r.id,
	number: Number(r.number),
	kind: r.kind,
	reason: r.reason,
	status: r.status,
	step: Number(r.step),
	requester: r.requester_id ? { id: r.requester_id, email: r.requester_email ?? '', name: r.requester_name ?? '' } : null,
	user: { id: r.user_id, email: r.user_email, name: r.user_name },
	resource: { id: r.resource_id, name: r.resource_name, color: r.resource_color },
	role: { id: r.role_id, name: r.role_name },
	grantId: r.grant_id,
	justification: r.justification,
	durationDays: r.duration_days,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
	closedAt: r.closed_at
});

export interface RequestFilter {
	userId?: string;
	/** Requests for or by this person. */
	involving?: string;
	resourceIds?: string[];
	statuses?: RequestStatus[];
	kind?: 'grant' | 'revoke';
	q?: string;
	limit?: number;
}

export async function listRequests(db: Db, orgId: string, f: RequestFilter = {}): Promise<AccessRequest[]> {
	const where = ['q.org_id = ?'];
	const params: (string | number)[] = [orgId];
	if (f.userId) where.push('q.user_id = ?'), params.push(f.userId);
	if (f.involving) where.push('(q.user_id = ? OR q.requester_id = ?)'), params.push(f.involving, f.involving);
	if (f.resourceIds) {
		if (!f.resourceIds.length) return [];
		where.push(`q.resource_id IN (${f.resourceIds.map(() => '?').join(',')})`);
		params.push(...f.resourceIds);
	}
	if (f.statuses?.length) where.push(`q.status IN (${f.statuses.map(() => '?').join(',')})`), params.push(...f.statuses);
	if (f.kind) where.push('q.kind = ?'), params.push(f.kind);
	if (f.q) {
		const q = `%${f.q.toLowerCase()}%`;
		where.push('(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(r.name) LIKE ? OR CAST(q.number AS TEXT) = ?)');
		params.push(q, q, q, f.q.replace(/^#/, ''));
	}
	params.push(f.limit ?? 200);
	return (await db.all<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT ?`, params)).map(toRequest);
}

export async function getRequest(db: Db, orgId: string, by: { id?: string; number?: number }): Promise<AccessRequest> {
	const row = by.id
		? await db.get<Row>(`${SELECT} WHERE q.org_id = ? AND q.id = ?`, [orgId, by.id])
		: await db.get<Row>(`${SELECT} WHERE q.org_id = ? AND q.number = ?`, [orgId, by.number ?? -1]);
	if (!row) throw notFound('That request doesn’t exist');
	return toRequest(row);
}

// ── Who acts on a request ────────────────────────────────────────────────────

export function stepsFor(policy: ApprovalPolicy): ('manager' | 'approvers')[] {
	return policy === 'none' ? [] : policy === 'manager' ? ['manager'] : policy === 'approvers' ? ['approvers'] : ['manager', 'approvers'];
}

async function activeIds(db: Db, orgId: string, ids: string[]): Promise<string[]> {
	if (!ids.length) return [];
	const rows = await db.all<{ user_id: string }>(
		`SELECT user_id FROM members WHERE org_id = ? AND status = 'active' AND user_id IN (${ids.map(() => '?').join(',')})`,
		[orgId, ...ids]
	);
	const ok = new Set(rows.map((r) => r.user_id));
	return ids.filter((i) => ok.has(i));
}

/**
 * Who can approve the current step. The subject never approves their own access unless
 * nobody else could (a one-person team); a missing manager or approver list falls back to
 * the resource owner, then to the organisation's admins.
 */
export async function approversFor(db: Db, orgId: string, req: Pick<AccessRequest, 'user' | 'step'>, resource: Resource): Promise<{ ids: string[]; via: string }> {
	const step = stepsFor(resource.approval)[req.step - 1];
	if (!step) return { ids: [], via: '' };
	const subject = req.user.id;
	const candidates: [string[], string][] = [];
	if (step === 'manager') {
		const m = await db.get<{ manager_id: string | null }>('SELECT manager_id FROM members WHERE org_id = ? AND user_id = ?', [orgId, subject]);
		candidates.push([m?.manager_id ? [m.manager_id] : [], 'manager']);
	}
	candidates.push([resource.approverIds, 'approvers']);
	candidates.push([resource.ownerId ? [resource.ownerId] : [], 'owner']);
	candidates.push([await adminIds(db, orgId), 'admins']);
	for (const [ids, via] of candidates) {
		const live = (await activeIds(db, orgId, ids)).filter((i) => i !== subject);
		if (live.length) return { ids: live, via };
	}
	return { ids: [subject], via: 'self' };
}

/** Fulfillers, then the owner, then admins. */
export async function fulfillersFor(db: Db, orgId: string, resource: Resource): Promise<string[]> {
	for (const ids of [resource.fulfillerIds, resource.ownerId ? [resource.ownerId] : [], await adminIds(db, orgId)]) {
		const live = await activeIds(db, orgId, ids);
		if (live.length) return live;
	}
	return [];
}

export interface Abilities {
	view: boolean;
	approve: boolean;
	fulfill: boolean;
	cancel: boolean;
	comment: boolean;
	approverIds: string[];
	approverVia: string;
	fulfillerIds: string[];
}

export async function abilities(db: Db, actor: Actor & { userId: string }, req: AccessRequest, resource: Resource): Promise<Abilities> {
	const approvers = req.status === 'pending_approval' ? await approversFor(db, actor.orgId, req, resource) : { ids: [], via: '' };
	const fulfillers = await fulfillersFor(db, actor.orgId, resource);
	const me = actor.userId;
	const steward = resource.ownerId === me || resource.approverIds.includes(me) || fulfillers.includes(me);
	const pastApprover = !!(await db.get('SELECT 1 FROM approvals WHERE request_id = ? AND approver_id = ?', [req.id, me]));
	const isApprover = approvers.ids.includes(me);
	const view = actor.admin || req.user.id === me || req.requester?.id === me || steward || isApprover || pastApprover;
	const open = req.status === 'pending_approval' || req.status === 'pending_fulfillment';
	return {
		view,
		approve: req.status === 'pending_approval' && (isApprover || (actor.admin && req.user.id !== me)),
		fulfill: req.status === 'pending_fulfillment' && (fulfillers.includes(me) || actor.admin),
		cancel: open && (actor.admin || (req.kind === 'grant' && req.status === 'pending_approval' && (req.user.id === me || req.requester?.id === me))),
		comment: view,
		approverIds: approvers.ids,
		approverVia: approvers.via,
		fulfillerIds: fulfillers
	};
}

/** Open requests waiting on this person: approvals and fulfillment tasks. */
export async function waitingOn(db: Db, orgId: string, userId: string) {
	const open = await listRequests(db, orgId, { statuses: ['pending_approval', 'pending_fulfillment'], limit: 1000 });
	const resources = new Map<string, Resource>();
	const toApprove: AccessRequest[] = [];
	const toFulfill: AccessRequest[] = [];
	for (const r of open) {
		if (!resources.has(r.resource.id)) resources.set(r.resource.id, await getResource(db, orgId, r.resource.id));
		const res = resources.get(r.resource.id)!;
		if (r.status === 'pending_approval') {
			if ((await approversFor(db, orgId, r, res)).ids.includes(userId)) toApprove.push(r);
		} else if ((await fulfillersFor(db, orgId, res)).includes(userId)) toFulfill.push(r);
	}
	return { toApprove, toFulfill };
}

// ── Labels used in messages ──────────────────────────────────────────────────

const who = (u: { name: string; email: string }) => u.name || u.email;
const what = (r: { resource: { name: string }; role: { name: string } }) => `${r.resource.name} (${r.role.name})`;

// ── Creating requests ────────────────────────────────────────────────────────

export interface NewRequest {
	userId: string;
	resourceId: string;
	roleId: string;
	justification: string;
	durationDays: number | null;
}

export async function createRequest(db: Db, actor: Actor & { userId: string }, input: NewRequest, fx: Effects): Promise<AccessRequest> {
	const resource = await getResource(db, actor.orgId, input.resourceId);
	if (resource.archived) throw badRequest('That resource has been archived');
	if (!resource.requestable && !actor.admin) throw badRequest('Access to this resource can’t be requested; ask an admin');
	const role = await getRole(db, actor.orgId, resource.id, input.roleId);

	if (input.userId !== actor.userId) {
		const settings = await orgSettings(db, actor.orgId);
		const isManager = await db.get('SELECT 1 FROM members WHERE org_id = ? AND user_id = ? AND manager_id = ?', [actor.orgId, input.userId, actor.userId]);
		if (!actor.admin && !isManager && !settings.allowOnBehalf) throw forbidden('You can only request access for yourself or people who report to you');
	}
	const subject = await db.get<{ status: string }>('SELECT status FROM members WHERE org_id = ? AND user_id = ?', [actor.orgId, input.userId]);
	if (subject?.status !== 'active') throw badRequest('That person isn’t an active member');

	let days = input.durationDays ?? resource.defaultDays;
	if (resource.maxDays !== null) {
		if (days === null) days = resource.maxDays;
		if (days > resource.maxDays) throw badRequest(`${resource.name} access lasts at most ${resource.maxDays} days`);
	}
	if (days !== null && days < 1) throw badRequest('Duration must be at least a day');
	if (resource.approval !== 'none' && input.justification.trim().length < 3) throw badRequest('Say briefly why the access is needed');

	return db.tx(async (tx) => {
		const dup = await tx.get<{ number: number }>(
			"SELECT number FROM requests WHERE org_id = ? AND user_id = ? AND role_id = ? AND kind = 'grant' AND status IN ('pending_approval', 'pending_fulfillment')",
			[actor.orgId, input.userId, role.id]
		);
		if (dup) throw conflict(`There’s already an open request for this (#${dup.number})`, { number: dup.number });
		const held = await tx.get<{ expires_at: string | null }>("SELECT expires_at FROM grants WHERE org_id = ? AND user_id = ? AND role_id = ? AND status = 'active'", [
			actor.orgId,
			input.userId,
			role.id
		]);
		if (held && !held.expires_at) throw conflict('They already have this access');

		const number = await nextRequestNumber(tx, actor.orgId);
		const id = newId();
		const t = now();
		const status: RequestStatus = resource.approval === 'none' ? 'pending_fulfillment' : 'pending_approval';
		await tx.run(
			`INSERT INTO requests (id, org_id, number, kind, reason, requester_id, user_id, resource_id, role_id, justification, duration_days, status, step, created_at, updated_at)
			 VALUES (?, ?, ?, 'grant', 'request', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			[id, actor.orgId, number, actor.userId, input.userId, resource.id, role.id, input.justification.trim(), days, status, t, t]
		);
		const req = await getRequest(tx, actor.orgId, { id });
		const forSelf = input.userId === actor.userId;
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'request.created',
			requestId: id,
			subject: resource.name,
			summary: `Requested ${what(req)}${forSelf ? '' : ` for ${who(req.user)}`}${held ? ' (extension)' : ''}`,
			data: { days, extension: !!held }
		});
		if (status === 'pending_approval') await announceApproval(tx, actor.orgId, req, resource, fx);
		else await startFulfillment(tx, actor.orgId, req, resource, fx, 'No approval needed');
		return getRequest(tx, actor.orgId, { id });
	});
}

async function announceApproval(db: Db, orgId: string, req: AccessRequest, resource: Resource, fx: Effects) {
	const { ids, via } = await approversFor(db, orgId, req, resource);
	const steps = stepsFor(resource.approval).length;
	fx.notices.push({
		orgId,
		to: ids,
		subject: `Approve access: ${who(req.user)} → ${what(req)}`,
		text: `${who(req.user)} needs ${what(req)}${req.durationDays ? ` for ${req.durationDays} days` : ''}.\n“${req.justification}”${steps > 1 ? `\nStep ${req.step} of ${steps}${via === 'manager' ? ' (manager)' : ''}.` : ''}`,
		path: `/requests/${req.number}`,
		slack: true
	});
}

async function startFulfillment(db: Db, orgId: string, req: AccessRequest, resource: Resource, fx: Effects, why: string) {
	if (resource.fulfillment === 'webhook') {
		fx.webhooks.push(req.id);
		return;
	}
	const ids = await fulfillersFor(db, orgId, resource);
	const verb = req.kind === 'grant' ? 'Give' : 'Remove';
	fx.notices.push({
		orgId,
		to: ids,
		subject: `${verb} access: ${who(req.user)} ${req.kind === 'grant' ? '→' : '✕'} ${what(req)}`,
		text:
			req.kind === 'grant'
				? `${why}. ${verb} ${who(req.user)} (${req.user.email}) ${what(req)} access in ${resource.name}, then mark the request done.`
				: `${REVOKE_WHY[req.reason]}. Remove ${who(req.user)}’s (${req.user.email}) ${req.role.name} access in ${resource.name}, then mark it done.`,
		path: `/requests/${req.number}`
	});
}

const REVOKE_WHY: Record<RequestReason, string> = {
	request: 'They asked for it to be removed',
	expired: 'Their access expired',
	review: 'An access review decided to remove it',
	offboarding: 'They’re being offboarded',
	manual: 'An admin revoked it'
};

// ── Approving ────────────────────────────────────────────────────────────────

export async function decide(db: Db, actor: Actor & { userId: string }, requestId: string, decision: 'approved' | 'denied', comment: string, fx: Effects) {
	return db.tx(async (tx) => {
		const req = await getRequest(tx, actor.orgId, { id: requestId });
		if (req.status !== 'pending_approval') throw conflict('This request isn’t waiting for approval any more');
		const resource = await getResource(tx, actor.orgId, req.resource.id);
		const can = await abilities(tx, actor, req, resource);
		if (!can.approve) throw forbidden(req.user.id === actor.userId ? 'You can’t approve your own access' : 'You’re not an approver for this request');
		if (decision === 'denied' && !comment.trim()) throw badRequest('Add a short note so they know why');

		const t = now();
		const asAdmin = !can.approverIds.includes(actor.userId);
		await tx.run('INSERT INTO approvals (id, org_id, request_id, step, approver_id, decision, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
			newId(),
			actor.orgId,
			req.id,
			req.step,
			actor.userId,
			decision,
			comment.trim(),
			t
		]);
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: decision === 'approved' ? 'request.approved' : 'request.denied',
			requestId: req.id,
			subject: resource.name,
			summary: `${decision === 'approved' ? 'Approved' : 'Denied'} ${what(req)} for ${who(req.user)}${asAdmin ? ' (as admin)' : can.approverVia === 'self' ? ' (self-approved: no other approver)' : ''}`,
			data: { step: req.step, comment: comment.trim() }
		});

		const notifyIds = [...new Set([req.user.id, req.requester?.id].filter((x): x is string => !!x && x !== actor.userId))];
		if (decision === 'denied') {
			await tx.run("UPDATE requests SET status = 'denied', updated_at = ?, closed_at = ? WHERE id = ?", [t, t, req.id]);
			fx.notices.push({
				orgId: actor.orgId,
				to: notifyIds,
				subject: `Denied: ${what(req)}`,
				text: `Your request #${req.number} for ${what(req)} was denied.${comment.trim() ? `\n“${comment.trim()}”` : ''}`,
				path: `/requests/${req.number}`
			});
			return;
		}

		// Next step, unless this person also approves it (a manager who is also the approver).
		let step = req.step + 1;
		const steps = stepsFor(resource.approval).length;
		while (step <= steps) {
			const next = await approversFor(tx, actor.orgId, { ...req, step }, resource);
			if (!next.ids.includes(actor.userId)) break;
			step++;
		}
		if (step <= steps) {
			await tx.run('UPDATE requests SET step = ?, updated_at = ? WHERE id = ?', [step, t, req.id]);
			await announceApproval(tx, actor.orgId, { ...req, step }, resource, fx);
			return;
		}
		await tx.run("UPDATE requests SET status = 'pending_fulfillment', step = ?, updated_at = ? WHERE id = ?", [step, t, req.id]);
		await startFulfillment(tx, actor.orgId, { ...req, status: 'pending_fulfillment' }, resource, fx, 'It was approved');
		fx.notices.push({
			orgId: actor.orgId,
			to: notifyIds,
			subject: `Approved: ${what(req)}`,
			text: `Request #${req.number} was approved. ${resource.fulfillment === 'webhook' ? 'Access is being set up automatically.' : 'You’ll hear again once access is set up.'}`,
			path: `/requests/${req.number}`
		});
	});
}

// ── Fulfilling ───────────────────────────────────────────────────────────────

/** Marks a request done: grants are created (or extended), revocations take effect. */
export async function complete(db: Db, actor: Actor, requestId: string, note: string, fx: Effects) {
	return db.tx(async (tx) => {
		const req = await getRequest(tx, actor.orgId, { id: requestId });
		if (req.status !== 'pending_fulfillment') throw conflict('This request isn’t waiting to be set up');
		const resource = await getResource(tx, actor.orgId, req.resource.id);
		if (actor.userId) {
			const can = await abilities(tx, actor as Actor & { userId: string }, req, resource);
			if (!can.fulfill) throw forbidden('You’re not a fulfiller for this resource');
		}
		const t = now();
		await tx.run("UPDATE requests SET status = 'completed', updated_at = ?, closed_at = ?, fulfilled_by = ? WHERE id = ?", [t, t, actor.userId, req.id]);

		if (req.kind === 'grant') {
			const expires = req.durationDays ? new Date(Date.now() + req.durationDays * DAY).toISOString() : null;
			const existing = await tx.get<{ id: string }>("SELECT id FROM grants WHERE org_id = ? AND user_id = ? AND role_id = ? AND status = 'active'", [actor.orgId, req.user.id, req.role.id]);
			if (existing) {
				await tx.run('UPDATE grants SET expires_at = ?, request_id = ?, reminded_at = NULL WHERE id = ?', [expires, req.id, existing.id]);
				await tx.run('UPDATE requests SET grant_id = ? WHERE id = ?', [existing.id, req.id]);
			} else {
				const gid = newId();
				await tx.run(
					"INSERT INTO grants (id, org_id, user_id, resource_id, role_id, status, source, request_id, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, 'active', 'request', ?, ?, ?)",
					[gid, actor.orgId, req.user.id, req.resource.id, req.role.id, req.id, t, expires]
				);
				await tx.run('UPDATE requests SET grant_id = ? WHERE id = ?', [gid, req.id]);
			}
			await record(tx, {
				orgId: actor.orgId,
				actorId: actor.userId,
				action: 'grant.created',
				requestId: req.id,
				subject: resource.name,
				summary: `${who(req.user)} now has ${what(req)}${expires ? ` until ${expires.slice(0, 10)}` : ''}${actor.userId ? '' : ' (set up automatically)'}`,
				data: { note: note.trim(), expiresAt: expires }
			});
			fx.notices.push({
				orgId: actor.orgId,
				to: [req.user.id, ...(req.requester && req.requester.id !== req.user.id ? [req.requester.id] : [])],
				subject: `Access ready: ${what(req)}`,
				text: `${who(req.user)} now has ${what(req)}${expires ? ` until ${expires.slice(0, 10)}` : ''}.${note.trim() ? `\n“${note.trim()}”` : ''}${resource.url ? `\n${resource.url}` : ''}`,
				path: `/requests/${req.number}`,
				slack: true
			});
		} else {
			if (req.grantId) await tx.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", [t, req.grantId]);
			await record(tx, {
				orgId: actor.orgId,
				actorId: actor.userId,
				action: 'grant.revoked',
				requestId: req.id,
				subject: resource.name,
				summary: `Removed ${who(req.user)}’s ${what(req)}${actor.userId ? '' : ' (automatically)'}`,
				data: { note: note.trim(), reason: req.reason }
			});
			fx.notices.push({
				orgId: actor.orgId,
				to: req.reason === 'offboarding' ? [] : [req.user.id],
				subject: `Access removed: ${what(req)}`,
				text: `Your ${what(req)} access was removed (${REVOKE_WHY[req.reason].toLowerCase()}).`,
				path: `/requests/${req.number}`
			});
		}
	});
}

export async function cancel(db: Db, actor: Actor & { userId: string }, requestId: string, comment: string) {
	return db.tx(async (tx) => {
		const req = await getRequest(tx, actor.orgId, { id: requestId });
		const resource = await getResource(tx, actor.orgId, req.resource.id);
		const can = await abilities(tx, actor, req, resource);
		if (!can.cancel) throw forbidden('You can’t cancel this request');
		const t = now();
		await tx.run("UPDATE requests SET status = 'cancelled', updated_at = ?, closed_at = ? WHERE id = ?", [t, t, req.id]);
		// A cancelled removal leaves the access in place.
		if (req.kind === 'revoke' && req.grantId) await tx.run("UPDATE grants SET status = 'active' WHERE id = ? AND status = 'pending_revoke'", [req.grantId]);
		await record(tx, {
			orgId: actor.orgId,
			actorId: actor.userId,
			action: 'request.cancelled',
			requestId: req.id,
			subject: resource.name,
			summary: `Cancelled ${req.kind === 'grant' ? 'request for' : 'removal of'} ${what(req)}`,
			data: { comment: comment.trim() }
		});
	});
}

export async function addComment(db: Db, actor: Actor & { userId: string }, requestId: string, text: string) {
	const req = await getRequest(db, actor.orgId, { id: requestId });
	const resource = await getResource(db, actor.orgId, req.resource.id);
	const can = await abilities(db, actor, req, resource);
	if (!can.comment) throw forbidden();
	if (!text.trim()) throw badRequest('Write a comment first');
	await record(db, { orgId: actor.orgId, actorId: actor.userId, action: 'request.comment', requestId: req.id, subject: resource.name, summary: text.trim() });
	const to = [...new Set([req.user.id, req.requester?.id, ...can.approverIds, ...(req.status === 'pending_fulfillment' ? can.fulfillerIds : [])])].filter(
		(x): x is string => !!x && x !== actor.userId
	);
	return {
		orgId: actor.orgId,
		to,
		subject: `Comment on #${req.number}: ${what(req)}`,
		text: text.trim(),
		path: `/requests/${req.number}`
	} satisfies Notice;
}

// ── Revoking ─────────────────────────────────────────────────────────────────

/**
 * Opens a removal request for a grant: the access stays until someone (or the webhook)
 * confirms it's gone. Returns null if a removal is already under way.
 */
export async function startRevoke(db: Db, actor: Actor, grantId: string, reason: RequestReason, note: string, fx: Effects): Promise<AccessRequest | null> {
	const g = await db.get<{ id: string; user_id: string; resource_id: string; role_id: string; status: string }>(
		'SELECT id, user_id, resource_id, role_id, status FROM grants WHERE org_id = ? AND id = ?',
		[actor.orgId, grantId]
	);
	if (!g) throw notFound('That access grant doesn’t exist');
	if (g.status === 'revoked') throw conflict('That access was already removed');
	if (g.status === 'pending_revoke') return null;
	const resource = await getResource(db, actor.orgId, g.resource_id);
	const number = await nextRequestNumber(db, actor.orgId);
	const id = newId();
	const t = now();
	await db.run(
		`INSERT INTO requests (id, org_id, number, kind, reason, requester_id, user_id, resource_id, role_id, grant_id, justification, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'revoke', ?, ?, ?, ?, ?, ?, ?, 'pending_fulfillment', ?, ?)`,
		[id, actor.orgId, number, reason, actor.userId, g.user_id, g.resource_id, g.role_id, g.id, note.trim(), t, t]
	);
	await db.run("UPDATE grants SET status = 'pending_revoke' WHERE id = ?", [g.id]);
	const req = await getRequest(db, actor.orgId, { id });
	await record(db, {
		orgId: actor.orgId,
		actorId: actor.userId,
		action: 'request.revoke',
		requestId: id,
		subject: resource.name,
		summary: `Removal of ${who(req.user)}’s ${what(req)}: ${REVOKE_WHY[reason].toLowerCase()}`,
		data: { reason, note: note.trim() }
	});
	await startFulfillment(db, actor.orgId, req, resource, fx, REVOKE_WHY[reason]);
	return req;
}

// ── Webhook fulfillment ──────────────────────────────────────────────────────

/**
 * Calls the resource's provisioning webhook. A 2xx answer completes the request; anything
 * else leaves it open, logs why, and asks the fulfillers to do it by hand.
 */
export async function runWebhook(db: Db, orgId: string, requestId: string, origin: string): Promise<boolean> {
	const req = await getRequest(db, orgId, { id: requestId });
	if (req.status !== 'pending_fulfillment') return false;
	const resource = await getResource(db, orgId, req.resource.id);
	if (resource.fulfillment !== 'webhook' || !resource.webhookUrl) return false;
	const body = JSON.stringify({
		event: req.kind === 'grant' ? 'access.grant' : 'access.revoke',
		request: { id: req.id, number: req.number, reason: req.reason, url: `${origin}/requests/${req.number}` },
		user: req.user,
		resource: { id: resource.id, name: resource.name },
		role: req.role,
		durationDays: req.durationDays,
		grantId: req.grantId
	});
	const ts = Math.floor(Date.now() / 1000).toString();
	const secret = await webhookSecret(db, orgId, resource.id);
	let error = '';
	try {
		const res = await fetch(resource.webhookUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'user-agent': 'ac-modern',
				'x-acm-event': req.kind === 'grant' ? 'access.grant' : 'access.revoke',
				'x-acm-timestamp': ts,
				...(secret ? { 'x-acm-signature': `sha256=${hmac(secret, `${ts}.${body}`)}` } : {})
			},
			body,
			signal: AbortSignal.timeout(15_000)
		});
		if (!res.ok) error = `answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim();
	} catch (err) {
		error = (err as Error).message;
	}
	const fx = effects();
	if (!error) {
		await complete(db, { orgId, userId: null, admin: true }, req.id, `Webhook ${resource.webhookUrl} confirmed`, fx);
	} else {
		await record(db, {
			orgId,
			actorId: null,
			action: 'request.webhook_failed',
			requestId: req.id,
			subject: resource.name,
			summary: `Automatic setup failed: ${error}`,
			data: { url: resource.webhookUrl }
		});
		fx.notices.push({
			orgId,
			to: await fulfillersFor(db, orgId, resource),
			subject: `Needs a hand: ${what(req)} for ${who(req.user)}`,
			text: `The provisioning webhook for ${resource.name} failed (${error}). Set it up by hand, or retry, then mark request #${req.number} done.`,
			path: `/requests/${req.number}`
		});
	}
	const { deliver } = await import('./notify.ts');
	await deliver(fx.notices, origin);
	return !error;
}

/** Sends notices and runs webhooks collected during a committed change. */
export async function flush(db: Db, orgId: string, fx: Effects, origin: string) {
	const { deliver } = await import('./notify.ts');
	await deliver(fx.notices, origin);
	// One webhook (a single request) runs inline so the response shows the result; a batch
	// (offboarding, expiry) runs in the background instead of holding the request open.
	if (fx.webhooks.length === 1) await runWebhook(db, orgId, fx.webhooks[0], origin);
	else if (fx.webhooks.length > 1)
		void (async () => {
			for (const id of fx.webhooks) await runWebhook(db, orgId, id, origin).catch((err) => console.error('[ac-modern] webhook', err));
		})();
}

