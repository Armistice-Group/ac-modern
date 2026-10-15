import { adminIds, orgSettings, saveOrgSettings } from './accounts.ts';
import { newId } from './crypto.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { badRequest, conflict, forbidden, notFound } from './http.ts';
import type { Effects } from './requests.ts';
import { getResource, saveResource, type ResourceInput } from './resources.ts';
import { deletePolicy, savePolicy, type PolicyInput } from './reviews.ts';
import { deleteRule, saveRule, type RuleInput } from './rules.ts';
import type { OrgSettings, PendingChange } from '#lib/types.ts';

/**
 * Two-person control for the controls themselves. With "changes need a second admin" on,
 * anything that could weaken approval (auto-approval rules, review policies, a system's
 * approval rule, owner, approvers or privileged levels, and the approval settings) is
 * proposed instead of applied, and takes effect when a different admin approves it.
 */

export type ChangeKind = PendingChange['kind'];
type Action = PendingChange['action'];

/** Settings that are approval controls; the rest (name, Slack…) apply straight away. */
export const CONTROL_SETTINGS: (keyof OrgSettings)[] = ['requirePrivilegedApproval', 'allowAdminOverride', 'defaultApproval', 'removalSlaHours', 'sessionMaxHours', 'sessionIdleMinutes', 'requireSecondAdmin'];

export async function secondAdminRequired(db: Db, orgId: string): Promise<boolean> {
	return !!(await orgSettings(db, orgId)).requireSecondAdmin;
}

/** Applies a change (directly, or once approved). `actorId` is who asked for it. */
export async function applyChange(db: Db, orgId: string, actorId: string, kind: ChangeKind, action: Action, targetId: string | null, payload: unknown): Promise<string | null> {
	switch (kind) {
		case 'rule':
			if (action === 'delete') return deleteRule(db, orgId, actorId, targetId!), targetId;
			return saveRule(db, orgId, actorId, action === 'update' ? targetId : null, payload as RuleInput);
		case 'review_policy':
			if (action === 'delete') return deletePolicy(db, orgId, actorId, targetId!), targetId;
			return savePolicy(db, orgId, actorId, action === 'update' ? targetId : null, payload as PolicyInput);
		case 'resource':
			return action === 'create' ? createResourceAudited(db, orgId, actorId, payload as ResourceInput) : (await updateResourceAudited(db, orgId, actorId, targetId!, payload as ResourceInput), targetId);
		case 'settings': {
			const patch = payload as Partial<OrgSettings>;
			await saveOrgSettings(db, orgId, patch);
			await record(db, { orgId, actorId, action: 'settings.updated', subject: 'Approval controls', summary: `Changed settings: ${describeSettings(patch)}`, data: { patch } });
			return null;
		}
	}
}

export function describeSettings(p: Partial<OrgSettings>): string {
	const parts: string[] = [];
	if (p.requirePrivilegedApproval !== undefined) parts.push(`privileged approval ${p.requirePrivilegedApproval ? 'required' : 'not required'}`);
	if (p.allowAdminOverride !== undefined) parts.push(`admin override ${p.allowAdminOverride ? 'allowed' : 'not allowed'}`);
	if (p.defaultApproval !== undefined) parts.push(`default approval “${p.defaultApproval}”`);
	if (p.removalSlaHours !== undefined) parts.push(`removal target ${p.removalSlaHours} hours`);
	if (p.sessionMaxHours !== undefined) parts.push(`sessions last ${p.sessionMaxHours} hours`);
	if (p.sessionIdleMinutes !== undefined) parts.push(p.sessionIdleMinutes ? `idle sessions end after ${p.sessionIdleMinutes} minutes` : 'no idle timeout');
	if (p.requireSecondAdmin !== undefined) parts.push(`control changes ${p.requireSecondAdmin ? 'need' : 'don’t need'} a second admin`);
	return parts.join(', ');
}

export async function createResourceAudited(db: Db, orgId: string, actorId: string, input: ResourceInput): Promise<string> {
	const id = await saveResource(db, orgId, null, input);
	await record(db, { orgId, actorId, action: 'resource.created', subject: input.name, summary: `Added resource ${input.name}${input.approval === 'none' ? ' (no approval)' : ''}`, data: { approval: input.approval } });
	return id;
}

/** The approval-relevant fields that changed on a resource. */
export function resourceControlChanges(before: Awaited<ReturnType<typeof getResource>>, input: ResourceInput) {
	const changed: Record<string, { from: unknown; to: unknown }> = {};
	for (const k of ['name', 'approval', 'fulfillment', 'maxDays', 'defaultDays', 'requestable', 'ownerId'] as const) if (before[k] !== input[k]) changed[k] = { from: before[k], to: input[k] };
	const priv = (roles: { name: string; privileged?: boolean }[]) => roles.filter((r) => r.privileged).map((r) => r.name).sort().join(', ');
	if (priv(before.roles) !== priv(input.roles)) changed.privileged = { from: priv(before.roles), to: priv(input.roles) };
	const appr = (ids: string[]) => [...ids].sort().join(',');
	if (appr(before.approverIds) !== appr(input.approverIds)) changed.approverIds = { from: before.approverIds, to: input.approverIds };
	return changed;
}

/** Keys that affect who approves, and so need a second admin when that's on. */
export const RESOURCE_CONTROL_KEYS = ['approval', 'ownerId', 'privileged', 'approverIds'];

export async function updateResourceAudited(db: Db, orgId: string, actorId: string, id: string, input: ResourceInput) {
	const before = await getResource(db, orgId, id);
	await saveResource(db, orgId, id, input);
	const changed = resourceControlChanges(before, input);
	await record(db, {
		orgId,
		actorId,
		action: 'resource.updated',
		subject: input.name,
		summary: `Updated resource ${input.name}${Object.keys(changed).length ? ` (${Object.keys(changed).join(', ')})` : ''}`,
		data: changed
	});
}

// ── Proposals ────────────────────────────────────────────────────────────────

interface Row {
	id: string;
	kind: ChangeKind;
	target_id: string | null;
	action: Action;
	payload: string;
	summary: string;
	status: PendingChange['status'];
	requested_by: string | null;
	rname: string | null;
	remail: string | null;
	requested_at: string;
	decided_by: string | null;
	dname: string | null;
	demail: string | null;
	decided_at: string | null;
	note: string;
}

const toChange = (r: Row): PendingChange => ({
	id: r.id,
	kind: r.kind,
	targetId: r.target_id,
	action: r.action,
	payload: JSON.parse(r.payload),
	summary: r.summary,
	status: r.status,
	requestedBy: r.requested_by ? { id: r.requested_by, name: r.rname || r.remail || '' } : null,
	requestedAt: r.requested_at,
	decidedBy: r.decided_by ? { id: r.decided_by, name: r.dname || r.demail || '' } : null,
	decidedAt: r.decided_at,
	note: r.note
});

const SELECT = `SELECT c.*, ru.name AS rname, ru.email AS remail, du.name AS dname, du.email AS demail FROM pending_changes c
	LEFT JOIN users ru ON ru.id = c.requested_by LEFT JOIN users du ON du.id = c.decided_by`;

export async function listChanges(db: Db, orgId: string, opts: { status?: PendingChange['status']; limit?: number } = {}): Promise<PendingChange[]> {
	return (
		await db.all<Row>(`${SELECT} WHERE c.org_id = ? ${opts.status ? 'AND c.status = ?' : ''} ORDER BY c.requested_at DESC LIMIT ?`, opts.status ? [orgId, opts.status, opts.limit ?? 100] : [orgId, opts.limit ?? 100])
	).map(toChange);
}

export async function proposeChange(db: Db, orgId: string, actorId: string, c: { kind: ChangeKind; action: Action; targetId: string | null; payload: unknown; summary: string }, fx: Effects): Promise<PendingChange> {
	const others = (await adminIds(db, orgId)).filter((a) => a !== actorId);
	if (!others.length) throw badRequest('Changes need a second admin, and you’re the only one. Make someone else an admin, or turn this off in Settings → General.');
	const id = newId();
	await db.run('INSERT INTO pending_changes (id, org_id, kind, target_id, action, payload, summary, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
		id,
		orgId,
		c.kind,
		c.targetId,
		c.action,
		JSON.stringify(c.payload),
		c.summary,
		actorId,
		new Date().toISOString()
	]);
	await record(db, { orgId, actorId, action: 'change.requested', subject: c.summary, summary: `Asked for a second admin to approve: ${c.summary}`, data: { changeId: id, kind: c.kind, action: c.action, targetId: c.targetId, payload: c.payload } });
	fx.notices.push({ orgId, to: others, subject: `Approve a control change: ${c.summary}`, text: `A change to your approval controls is waiting for a second admin:\n${c.summary}`, path: '/settings/changes' });
	return (await db.get<Row>(`${SELECT} WHERE c.id = ?`, [id]).then((r) => toChange(r!)))!;
}

export type ChangeResult = { applied: true; id: string | null } | { applied: false; change: PendingChange };

/** Applies a change now, or proposes it when a second admin is required (and `gated`). */
export async function changeOrPropose(db: Db, orgId: string, actorId: string, c: { kind: ChangeKind; action: Action; targetId: string | null; payload: unknown; summary: string }, fx: Effects, gated = true): Promise<ChangeResult> {
	if (gated && (await secondAdminRequired(db, orgId))) return { applied: false, change: await proposeChange(db, orgId, actorId, c, fx) };
	return { applied: true, id: await applyChange(db, orgId, actorId, c.kind, c.action, c.targetId, c.payload) };
}

/** The API answer: 200 with the id, or 202 when it went to a second admin. */
export function changeResponse(r: ChangeResult): Response {
	return r.applied ? Response.json({ id: r.id }) : Response.json({ pending: true, change: r.change, message: 'Sent to another admin for approval' }, { status: 202 });
}

export async function decideChange(db: Db, orgId: string, adminId: string, id: string, decision: 'approved' | 'rejected', note: string, fx: Effects) {
	const row = await db.get<Row>(`${SELECT} WHERE c.org_id = ? AND c.id = ?`, [orgId, id]);
	if (!row) throw notFound('That change doesn’t exist');
	if (row.status !== 'pending') throw conflict('That change was already decided');
	if (row.requested_by === adminId) throw forbidden('Another admin has to approve your change');
	if (decision === 'rejected' && !note.trim()) throw badRequest('Say why, so they know');
	const t = new Date().toISOString();
	const { changes } = await db.run("UPDATE pending_changes SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'", [decision, adminId, t, note.trim(), id]);
	if (!changes) throw conflict('That change was already decided');
	if (decision === 'approved') {
		try {
			await applyChange(db, orgId, row.requested_by ?? adminId, row.kind, row.action, row.target_id, JSON.parse(row.payload));
		} catch (err) {
			// It couldn't apply (e.g. the rule was deleted meanwhile): put it back as failed.
			await db.run("UPDATE pending_changes SET status = 'failed', note = ? WHERE id = ?", [(err as Error).message, id]);
			throw err;
		}
	}
	await record(db, {
		orgId,
		actorId: adminId,
		action: decision === 'approved' ? 'change.approved' : 'change.rejected',
		subject: row.summary,
		summary: `${decision === 'approved' ? 'Approved' : 'Rejected'} ${row.rname || row.remail || 'an admin'}’s change: ${row.summary}${note.trim() ? ` (“${note.trim()}”)` : ''}`,
		data: { changeId: id, requestedBy: row.requested_by }
	});
	if (row.requested_by)
		fx.notices.push({ orgId, to: [row.requested_by], subject: `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${row.summary}`, text: `Your change was ${decision}.${note.trim() ? `\n“${note.trim()}”` : ''}`, path: '/settings/changes' });
}

export async function cancelChange(db: Db, orgId: string, actorId: string, id: string) {
	const row = await db.get<Row>(`${SELECT} WHERE c.org_id = ? AND c.id = ?`, [orgId, id]);
	if (!row || row.status !== 'pending') throw notFound('That change isn’t waiting any more');
	if (row.requested_by !== actorId) throw forbidden('Only whoever asked for it can withdraw it');
	await db.run("UPDATE pending_changes SET status = 'cancelled', decided_at = ? WHERE id = ?", [new Date().toISOString(), id]);
	await record(db, { orgId, actorId, action: 'change.cancelled', subject: row.summary, summary: `Withdrew a proposed change: ${row.summary}`, data: { changeId: id } });
}
