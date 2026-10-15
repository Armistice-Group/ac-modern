import { sha256 } from './crypto.ts';
import type { Db } from './db.ts';
import { requestTimeline } from './events.ts';
import { getRequest, listRequests, stepsFor } from './requests.ts';
import type { AccessRequest, Approval, ApprovalCapacity, Event, RequestCategory } from '#lib/types.ts';

/**
 * Audit evidence for the "access is requested and approved" control. Auditors take the
 * population of access changes in a period, sample from it (new hires, transfers, new
 * admins, extra permissions), and ask for each sample's ticket: who asked, why, who
 * approved in what capacity, and that setup happened after approval.
 */

export interface Snapshot {
	user?: { name: string; email: string; title: string };
	manager?: { id: string | null; name: string; email: string } | null;
	requester?: { id: string | null; name: string; email: string } | null;
	resource?: { name: string; owner: { id: string | null; name: string; email: string } | null; policy: string };
	role?: { name: string; privileged: boolean };
}

export type Flag = 'pre_approved' | 'auto_approved' | 'admin_override' | 'admin_fallback' | 'self_approved' | 'manager_unavailable' | 'approver_provisioned' | 'auto_provisioned';

export const FLAG_LABEL: Record<Flag, string> = {
	pre_approved: 'Pre-approved by resource policy',
	auto_approved: 'Auto-approved by rule',
	admin_override: 'Approved by admin override',
	admin_fallback: 'No designated approver available; an admin approved',
	self_approved: 'Self-approved (no other approver)',
	manager_unavailable: 'Manager step approved by someone other than the manager',
	approver_provisioned: 'Same person approved and set it up',
	auto_provisioned: 'Set up automatically by webhook'
};
/** Flags an auditor would call exceptions (the rest are informational). */
export const EXCEPTIONS: Flag[] = ['admin_override', 'admin_fallback', 'self_approved', 'manager_unavailable'];

export interface EvidenceRow {
	request: AccessRequest;
	snapshot: Snapshot;
	approvals: Approval[];
	approvedAt: string | null;
	fulfilledBy: { name: string; email: string } | null;
	fulfilledAt: string | null;
	flags: Flag[];
}

interface ApprovalRow {
	request_id: string;
	step: number;
	decision: 'approved' | 'denied';
	capacity: ApprovalCapacity;
	approver_id: string | null;
	approver_name: string;
	approver_email: string;
	comment: string;
	created_at: string;
}

async function approvalsFor(db: Db, orgId: string, ids: string[]): Promise<Map<string, Approval[]>> {
	const out = new Map<string, Approval[]>();
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		const rows = await db.all<ApprovalRow>(
			`SELECT request_id, step, decision, capacity, approver_id, approver_name, approver_email, comment, created_at FROM approvals
			 WHERE org_id = ? AND request_id IN (${chunk.map(() => '?').join(',')}) ORDER BY created_at, step`,
			[orgId, ...chunk]
		);
		for (const r of rows) {
			const list = out.get(r.request_id) ?? [];
			list.push({
				step: Number(r.step),
				decision: r.decision,
				capacity: r.capacity,
				approver: { id: r.approver_id, name: r.approver_name, email: r.approver_email },
				comment: r.comment,
				at: r.created_at
			});
			out.set(r.request_id, list);
		}
	}
	return out;
}

function flagsFor(req: AccessRequest, approvals: Approval[], fulfilledById: string | null): Flag[] {
	const flags = new Set<Flag>();
	if (req.kind === 'grant' && req.autoRule) flags.add('auto_approved');
	else if (req.kind === 'grant' && req.policy === 'none') flags.add('pre_approved');
	const steps = stepsFor(req.policy);
	for (const a of approvals) {
		if (a.capacity === 'admin_override') flags.add('admin_override');
		if (a.capacity === 'admin_fallback') flags.add('admin_fallback');
		if (a.capacity === 'self') flags.add('self_approved');
		if (steps[a.step - 1] === 'manager' && a.decision === 'approved' && a.capacity !== 'manager') flags.add('manager_unavailable');
	}
	if (req.status === 'completed') {
		if (!fulfilledById) flags.add('auto_provisioned');
		else if (req.kind === 'grant' && approvals.some((a) => a.approver.id === fulfilledById)) flags.add('approver_provisioned');
	}
	return [...flags];
}

export interface EvidenceFilter {
	from: string;
	to: string;
	categories?: RequestCategory[];
	privileged?: boolean;
	/** Only requests with exception flags. */
	exceptions?: boolean;
	q?: string;
}

/** The population: every request made in the period, with its approvals and setup. */
export async function evidenceRows(db: Db, orgId: string, f: EvidenceFilter): Promise<EvidenceRow[]> {
	const requests = await listRequests(db, orgId, { from: f.from, to: f.to, categories: f.categories, privileged: f.privileged, q: f.q, limit: 100_000 });
	const rows = await buildRows(db, orgId, requests);
	return f.exceptions ? rows.filter((r) => r.flags.some((fl) => EXCEPTIONS.includes(fl))) : rows;
}

async function buildRows(db: Db, orgId: string, requests: AccessRequest[]): Promise<EvidenceRow[]> {
	if (!requests.length) return [];
	const ids = requests.map((r) => r.id);
	const approvals = await approvalsFor(db, orgId, ids);
	const extra = new Map<string, { snapshot: string; fulfilled_by: string | null; fname: string | null; femail: string | null }>();
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		const rows = await db.all<{ id: string; snapshot: string; fulfilled_by: string | null; fname: string | null; femail: string | null }>(
			`SELECT q.id, q.snapshot, q.fulfilled_by, u.name AS fname, u.email AS femail FROM requests q LEFT JOIN users u ON u.id = q.fulfilled_by
			 WHERE q.org_id = ? AND q.id IN (${chunk.map(() => '?').join(',')})`,
			[orgId, ...chunk]
		);
		for (const r of rows) extra.set(r.id, r);
	}
	return requests.map((req) => {
		const a = approvals.get(req.id) ?? [];
		const x = extra.get(req.id)!;
		const approved = a.filter((v) => v.decision === 'approved');
		return {
			request: req,
			snapshot: JSON.parse(x.snapshot || '{}') as Snapshot,
			approvals: a,
			approvedAt: req.status === 'denied' || !approved.length ? null : approved.at(-1)!.at,
			fulfilledBy: x.fulfilled_by ? { name: x.fname ?? '', email: x.femail ?? '' } : null,
			fulfilledAt: req.status === 'completed' ? req.closedAt : null,
			flags: flagsFor(req, a, x.fulfilled_by)
		};
	});
}

export interface Ticket extends EvidenceRow {
	timeline: Event[];
	grant: { status: string; grantedAt: string; expiresAt: string | null; revokedAt: string | null } | null;
	/** SHA-256 over the stored request, approvals and events: changes if any of them change. */
	fingerprint: string;
}

export async function ticket(db: Db, orgId: string, number: number): Promise<Ticket> {
	const req = await getRequest(db, orgId, { number });
	const [row] = await buildRows(db, orgId, [req]);
	const timeline = await requestTimeline(db, orgId, req.id);
	const g = req.grantId
		? await db.get<{ status: string; granted_at: string; expires_at: string | null; revoked_at: string | null }>(
				'SELECT status, granted_at, expires_at, revoked_at FROM grants WHERE id = ?',
				[req.grantId]
			)
		: undefined;
	const raw = await db.get<Record<string, unknown>>('SELECT * FROM requests WHERE id = ?', [req.id]);
	const rawApprovals = await db.all<Record<string, unknown>>('SELECT * FROM approvals WHERE request_id = ? ORDER BY created_at, id', [req.id]);
	const rawEvents = await db.all<Record<string, unknown>>('SELECT id, at, actor_id, action, summary, data FROM events WHERE request_id = ? ORDER BY at, id', [req.id]);
	// Normalise numbers so SQLite and Postgres produce the same fingerprint.
	const canon = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
	return {
		...row,
		timeline,
		grant: g ? { status: g.status, grantedAt: g.granted_at, expiresAt: g.expires_at, revokedAt: g.revoked_at } : null,
		fingerprint: sha256(canon({ request: raw, approvals: rawApprovals, events: rawEvents }))
	};
}

/**
 * Changes that didn't go through a request: access recorded directly by an admin, and
 * changes to who administers ac·modern itself. Auditors ask about both.
 */
export async function outOfProcess(db: Db, orgId: string, from: string, to: string) {
	const rows = await db.all<{ id: string; at: string; action: string; summary: string; data: string; actor_name: string | null; actor_email: string | null }>(
		`SELECT e.id, e.at, e.action, e.summary, e.data, u.name AS actor_name, u.email AS actor_email FROM events e LEFT JOIN users u ON u.id = e.actor_id
		 WHERE e.org_id = ? AND e.at >= ? AND e.at < ? AND e.action IN ('grant.recorded', 'grant.detected', 'member.updated', 'member.joined', 'member.offboarded', 'settings.updated', 'resource.updated', 'rule.created', 'rule.updated', 'rule.deleted', 'review_policy.created', 'review_policy.updated', 'review_policy.deleted', 'change.requested', 'change.approved', 'change.rejected', 'mfa.reset')
		 ORDER BY e.at DESC`,
		[orgId, from, to]
	);
	const list = rows.map((r) => ({ id: r.id, at: r.at, action: r.action, summary: r.summary, actor: r.actor_name || r.actor_email || 'System', data: JSON.parse(r.data || '{}') as Record<string, unknown> }));
	return {
		recorded: list.filter((e) => e.action === 'grant.recorded' || e.action === 'grant.detected'),
		adminChanges: list.filter((e) => e.action === 'member.updated' && e.data.role !== undefined),
		controlChanges: list.filter((e) => e.action === 'settings.updated' || e.action.startsWith('rule.') || e.action.startsWith('review_policy.') || e.action.startsWith('change.') || e.action === 'mfa.reset' || (e.action === 'resource.updated' && Object.keys(e.data).some((k) => ['approval', 'ownerId', 'privileged'].includes(k))))
	};
}

const csvCell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;

export function populationCsv(rows: EvidenceRow[], capacityLabel: (c: ApprovalCapacity) => string, categoryLabel: (c: RequestCategory) => string): string {
	const head = [
		'request',
		'type',
		'privileged',
		'person',
		'person_email',
		'title_at_request',
		'manager_at_request',
		'resource',
		'access_level',
		'system_owner',
		'requested_by',
		'requested_at',
		'justification',
		'duration_days',
		'approvals',
		'approved_at',
		'set_up_by',
		'set_up_at',
		'status',
		'flags'
	];
	const lines = rows.map((r) => {
		const s = r.snapshot;
		return [
			`#${r.request.number}`,
			categoryLabel(r.request.category),
			r.request.privileged ? 'yes' : 'no',
			s.user?.name || r.request.user.name,
			s.user?.email || r.request.user.email,
			s.user?.title ?? '',
			s.manager ? `${s.manager.name} <${s.manager.email}>` : '',
			s.resource?.name || r.request.resource.name,
			s.role?.name || r.request.role.name,
			s.resource?.owner ? `${s.resource.owner.name} <${s.resource.owner.email}>` : '',
			s.requester ? `${s.requester.name} <${s.requester.email}>` : r.request.requester?.email ?? 'system',
			r.request.createdAt,
			r.request.justification,
			r.request.durationDays ?? '',
			r.approvals.map((a) => `step ${a.step}: ${a.decision} by ${a.approver.name || a.approver.email} <${a.approver.email}> as ${capacityLabel(a.capacity)} at ${a.at}${a.comment ? ` ("${a.comment}")` : ''}`).join('; '),
			r.approvedAt ?? '',
			r.fulfilledBy ? `${r.fulfilledBy.name} <${r.fulfilledBy.email}>` : r.fulfilledAt ? 'webhook' : '',
			r.fulfilledAt ?? '',
			r.request.status,
			r.flags.map((f) => (f === 'auto_approved' && r.request.autoRule ? `Auto-approved by rule “${r.request.autoRule.name}” (${r.request.autoRule.reason})` : FLAG_LABEL[f])).join('; ')
		]
			.map(csvCell)
			.join(',');
	});
	return [head.join(','), ...lines].join('\n');
}
