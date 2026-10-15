import { getOrg, listPeople, orgSettings } from './accounts.ts';
import type { Db } from './db.ts';
import { EXCEPTIONS, evidenceRows, ticket, type EvidenceRow } from './evidence.ts';
import { listEvents } from './events.ts';
import { listGrants } from './grants.ts';
import { listResources } from './resources.ts';
import { describePolicy, getReview, listPolicies, listReviews, reviewItems } from './reviews.ts';
import { describeRule, listRules } from './rules.ts';
import type { GrantStatus, RequestCategory, Review } from '#lib/types.ts';

/**
 * The read-only REST API for GRC tools (Vanta, Drata, Secureframe…) and scripts.
 * snake_case JSON, `{ data, next_cursor }` lists, ISO-8601 UTC timestamps.
 */

export interface V1Response {
	status: number;
	body: unknown;
}

const fail = (status: number, message: string): V1Response => ({ status, body: { error: { status, message } } });

function paginate<T>(items: T[], q: URLSearchParams) {
	const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000);
	let offset = 0;
	const cursor = q.get('cursor');
	if (cursor) {
		const n = Number(Buffer.from(cursor, 'base64url').toString());
		if (Number.isInteger(n) && n >= 0) offset = n;
	}
	const page = items.slice(offset, offset + limit);
	const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
	return { status: 200, body: { data: page, next_cursor: next } };
}

function range(q: URLSearchParams): { from: string; to: string } | V1Response {
	const parse = (v: string | null, fallback: string) => {
		if (!v) return fallback;
		const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
		return Number.isNaN(t) ? null : new Date(t).toISOString();
	};
	const from = parse(q.get('from'), '1970-01-01T00:00:00.000Z');
	let to = parse(q.get('to'), '9999-01-01T00:00:00.000Z');
	if (!from || !to) return fail(400, 'from and to must be ISO-8601 dates');
	// A bare date for `to` includes that whole day.
	if (q.get('to')?.length === 10) to = new Date(Date.parse(to) + 86_400_000).toISOString();
	return { from, to };
}

const person = (p: { id: string; email: string; name: string } | null | undefined) => (p ? { id: p.id, email: p.email, name: p.name } : null);

function requestJson(r: EvidenceRow) {
	const q = r.request;
	const s = r.snapshot;
	return {
		number: q.number,
		id: q.id,
		kind: q.kind,
		type: q.category,
		reason: q.kind === 'revoke' ? q.reason : null,
		privileged: q.privileged,
		status: q.status,
		user: { id: q.user.id, email: s.user?.email || q.user.email, name: s.user?.name || q.user.name, title_at_request: s.user?.title ?? null },
		manager_at_request: s.manager ? { id: s.manager.id, email: s.manager.email, name: s.manager.name } : null,
		resource: { id: q.resource.id, name: s.resource?.name ?? q.resource.name, owner: s.resource?.owner ? { id: s.resource.owner.id, email: s.resource.owner.email, name: s.resource.owner.name } : null },
		access_level: { id: q.role.id, name: s.role?.name ?? q.role.name },
		requested_by: s.requester ? { id: s.requester.id, email: s.requester.email, name: s.requester.name } : null,
		requested_at: q.createdAt,
		justification: q.justification,
		duration_days: q.durationDays,
		approval_policy: q.policy,
		auto_approval_rule: q.autoRule ? { id: q.autoRule.id, name: q.autoRule.name, reason: q.autoRule.reason } : null,
		approvals: r.approvals.map((a) => ({ step: a.step, decision: a.decision, capacity: a.capacity || null, approver: { id: a.approver.id, email: a.approver.email, name: a.approver.name }, comment: a.comment, at: a.at })),
		approved_at: r.approvedAt,
		fulfilled_by: r.fulfilledAt ? (r.fulfilledBy ? { email: r.fulfilledBy.email, name: r.fulfilledBy.name } : { automatic: true }) : null,
		fulfilled_at: r.fulfilledAt,
		closed_at: q.closedAt,
		flags: r.flags,
		exception: r.flags.some((f) => EXCEPTIONS.includes(f)),
		batch_id: q.batchId
	};
}

export async function handleV1(db: Db, orgId: string, path: string[], q: URLSearchParams): Promise<V1Response> {
	const [resource, id, sub] = path;
	switch (resource) {
		case 'organization': {
			const org = (await getOrg(db, orgId))!;
			const s = await orgSettings(db, orgId);
			return {
				status: 200,
				body: {
					data: {
						id: org.id,
						name: org.name,
						slug: org.slug,
						controls: { privileged_requires_owner_approval: s.requirePrivilegedApproval !== false, admin_override_allowed: !!s.allowAdminOverride, expiry_reminder_days: s.expiryReminderDays ?? 3 }
					}
				}
			};
		}
		case 'approval-rules': {
			const rules = await listRules(db, orgId);
			const rows = [];
			for (const r of rules)
				rows.push({
					id: r.id,
					name: r.name,
					enabled: r.enabled,
					description: await describeRule(db, orgId, r),
					resource_ids: r.resourceIds,
					access_level_ids: r.roleIds,
					group_ids: r.groupIds,
					user_ids: r.userIds,
					max_days: r.maxDays,
					created_at: r.createdAt,
					updated_at: r.updatedAt
				});
			return paginate(rows, q);
		}
		case 'users': {
			const status = q.get('status') ?? 'all';
			const people = await listPeople(db, orgId, { includeDeactivated: true });
			const byId = new Map(people.map((p) => [p.id, p]));
			const sources = new Map(
				(await db.all<{ user_id: string; source: string }>('SELECT user_id, source FROM members WHERE org_id = ?', [orgId])).map((r) => [r.user_id, r.source])
			);
			const rows = people
				.filter((p) => status === 'all' || p.status === status)
				.map((p) => ({
					id: p.id,
					email: p.email,
					name: p.name,
					title: p.title,
					role: p.role,
					status: p.status,
					manager: person(p.managerId ? byId.get(p.managerId) : null),
					source: sources.get(p.id) ?? 'manual',
					joined_at: p.joinedAt,
					last_login_at: p.lastLoginAt,
					mfa_enabled: p.mfa,
					last_sign_in_method: p.lastLoginMethod || null
				}));
			return paginate(rows, q);
		}
		case 'resources': {
			const resources = await listResources(db, orgId, { includeArchived: true });
			const people = new Map((await listPeople(db, orgId, { includeDeactivated: true })).map((p) => [p.id, p]));
			return paginate(
				resources.map((r) => ({
					id: r.id,
					name: r.name,
					category: r.category,
					url: r.url || null,
					archived: r.archived,
					owner: person(r.ownerId ? people.get(r.ownerId) : null),
					approval_policy: r.approval,
					approvers: r.approverIds.map((x) => person(people.get(x))).filter(Boolean),
					fulfillment: r.fulfillment,
					max_days: r.maxDays,
					access_levels: r.roles.map((x) => ({ id: x.id, name: x.name, description: x.description, privileged: x.privileged }))
				})),
				q
			);
		}
		case 'access': {
			const status = q.get('status') ?? 'active';
			const statuses: GrantStatus[] = status === 'all' ? ['active', 'pending_revoke', 'revoked'] : ['active', 'pending_revoke'];
			let grants = await listGrants(db, orgId, { statuses, resourceId: q.get('resource_id') ?? undefined });
			const email = q.get('user_email')?.toLowerCase();
			if (email) grants = grants.filter((g) => g.user.email === email);
			const privileged = new Set(
				(await db.all<{ id: string }>('SELECT id FROM resource_roles WHERE org_id = ? AND privileged = 1', [orgId])).map((r) => r.id)
			);
			return paginate(
				grants.map((g) => ({
					id: g.id,
					user: person(g.user),
					resource: { id: g.resource.id, name: g.resource.name },
					access_level: { id: g.role.id, name: g.role.name, privileged: privileged.has(g.role.id) },
					status: g.status,
					source: g.source,
					request_number: g.requestNumber,
					note: g.note,
					granted_at: g.grantedAt,
					expires_at: g.expiresAt,
					revoked_at: g.revokedAt
				})),
				q
			);
		}
		case 'requests': {
			if (id) {
				const n = Number(id);
				if (!Number.isInteger(n)) return fail(404, 'Not found');
				const t = await ticket(db, orgId, n).catch(() => null);
				if (!t) return fail(404, 'Request not found');
				return {
					status: 200,
					body: {
						data: {
							...requestJson(t),
							timeline: t.timeline.map((e) => ({ at: e.at, actor: person(e.actor), action: e.action, summary: e.summary })),
							fingerprint_sha256: t.fingerprint
						}
					}
				};
			}
			const r = range(q);
			if ('status' in r) return r;
			const types = (q.get('type') ?? '').split(',').filter(Boolean) as RequestCategory[];
			const rows = await evidenceRows(db, orgId, { from: r.from, to: r.to, categories: types, privileged: q.get('privileged') === 'true', exceptions: q.get('exceptions') === 'true' });
			return paginate(rows.map(requestJson), q);
		}
		case 'review-policies': {
			const rows = [];
			for (const p of await listPolicies(db, orgId))
				rows.push({
					id: p.id,
					name: p.name,
					enabled: p.enabled,
					description: await describePolicy(db, orgId, p),
					frequency: p.frequency,
					scope: p.scope,
					resource_ids: p.resourceIds,
					reviewer: p.reviewer,
					due_days: p.dueDays,
					next_run_at: p.nextRunAt,
					last_run_at: p.lastRunAt
				});
			return paginate(rows, q);
		}
		case 'reviews': {
			const reviewJson = (v: Review) => ({
				id: v.id,
				name: v.name,
				status: v.status,
				policy: v.policyId ? { id: v.policyId, name: v.policyName } : null,
				scope: v.scope.scope ?? 'all',
				reviewer: v.scope.reviewer ?? 'owner',
				due_at: v.dueAt,
				created_at: v.createdAt,
				closed_at: v.closedAt,
				total: v.total,
				decided: v.decided,
				revoked: v.revoked,
				removed: v.removed,
				closed_late: !!(v.closedAt && v.dueAt && v.closedAt > v.dueAt)
			});
			if (id) {
				const review = await getReview(db, orgId, id).catch(() => null);
				if (!review) return fail(404, 'Review not found');
				const items = await reviewItems(db, orgId, id);
				if (sub === 'items' || !sub)
					return {
						status: 200,
						body: {
							data: {
								...reviewJson(review),
								items: items.map((i) => ({
									id: i.id,
									user: person(i.grant.user),
									resource: { id: i.grant.resource.id, name: i.grant.resource.name },
									access_level: { id: i.grant.role.id, name: i.grant.role.name },
									privileged: i.privileged,
									granted_at: i.grant.grantedAt,
									reviewer: i.reviewerId ? { id: i.reviewerId, name: i.reviewerName } : null,
									reviewer_capacity: i.capacity || null,
									decision: i.decision,
									decided_by: i.decidedBy,
									note: i.note,
									decided_at: i.decidedAt,
									removal: i.removal ? { request_number: i.removal.number, status: i.removal.status, completed_at: i.removal.status === 'completed' ? i.removal.closedAt : null } : null
								}))
							}
						}
					};
			}
			return paginate((await listReviews(db, orgId)).map(reviewJson), q);
		}
		case 'events': {
			const r = range(q);
			if ('status' in r) return r;
			const action = q.get('action');
			const all = await listEvents(db, orgId, { from: r.from, to: r.to, limit: 1_000_000 });
			return paginate(
				all
					.filter((e) => !action || e.action === action || e.action.startsWith(`${action}.`))
					.map((e) => ({ id: e.id, at: e.at, actor: person(e.actor), action: e.action, request_number: e.requestNumber, subject: e.subject, summary: e.summary })),
				q
			);
		}
		default:
			return fail(404, 'Unknown endpoint. See /api/v1/openapi.json');
	}
}
