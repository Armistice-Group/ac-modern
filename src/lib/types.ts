export type Role = 'owner' | 'admin' | 'member';
export type ApprovalPolicy = 'none' | 'manager' | 'approvers' | 'manager_then_approvers';
export type Fulfillment = 'manual' | 'webhook' | 'integration';
export type IntegrationKind = 'github' | 'google' | 'okta' | 'authentik' | 'entra';
/** What an access level means in the connected system. */
export type LevelMapping =
	| { type: 'github_org'; role: 'member' | 'admin' }
	| { type: 'github_team'; team: string; role: 'member' | 'maintainer' }
	| { type: 'google_group'; group: string; role: 'MEMBER' | 'MANAGER' | 'OWNER' }
	| { type: 'google_account' }
	| { type: 'okta_group'; id: string; name: string }
	| { type: 'okta_app'; id: string; name: string }
	| { type: 'authentik_group'; id: string; name: string }
	| { type: 'entra_group'; id: string; name: string };
export type RequestStatus = 'pending_approval' | 'pending_fulfillment' | 'completed' | 'denied' | 'cancelled';
export type RequestKind = 'grant' | 'revoke';
/** Why a revoke request exists. Grant requests are always 'request'. */
export type RequestReason = 'request' | 'expired' | 'review' | 'offboarding' | 'transfer' | 'manual' | 'directory';
/**
 * What kind of change a request is, for audit sampling: access for a new hire, a transfer
 * between teams, a different level on a resource they already use, a resource they didn't
 * have, more time on access they hold, or a removal.
 */
export type RequestCategory = 'new_hire' | 'transfer' | 'change' | 'new_access' | 'extension' | 'removal';
/** In what role someone approved a step. */
export type ApprovalCapacity = 'manager' | 'system_owner' | 'approver' | 'admin_fallback' | 'admin_override' | 'self' | '';
export type GrantStatus = 'active' | 'pending_revoke' | 'revoked';
export type GrantSource = 'request' | 'manual' | 'import' | 'idp';

export interface Org {
	id: string;
	name: string;
	slug: string;
}

export interface OrgSettings {
	/** Slack incoming-webhook URL (stored encrypted). */
	slackWebhook?: string;
	/** Default approval policy for new resources. */
	defaultApproval?: ApprovalPolicy;
	/** Members may request access for someone else (e.g. a manager for a new hire). */
	allowOnBehalf?: boolean;
	/** Days before expiry to remind the person who holds the access. */
	expiryReminderDays?: number;
	/** Privileged access levels always need a system owner/approver step, whatever the resource's policy. Default on. */
	requirePrivilegedApproval?: boolean;
	/** Admins may approve on behalf of the designated approver (recorded as an override). Default off. */
	allowAdminOverride?: boolean;
}

export interface SessionUser {
	id: string;
	email: string;
	name: string;
}

export interface Membership {
	orgId: string;
	orgName: string;
	role: Role;
}

export interface Viewer extends SessionUser {
	role: Role;
	orgs: Membership[];
}

export interface Person {
	id: string;
	email: string;
	name: string;
	role: Role;
	title: string;
	managerId: string | null;
	status: 'active' | 'deactivated';
	joinedAt: string;
	lastLoginAt: string | null;
}

export interface ResourceRole {
	id: string;
	name: string;
	description: string;
	/** Admin-level or sensitive (owner, write to production…): always needs an owner/approver. */
	privileged: boolean;
}

export interface Resource {
	id: string;
	name: string;
	description: string;
	category: string;
	url: string;
	color: string;
	ownerId: string | null;
	approval: ApprovalPolicy;
	fulfillment: Fulfillment;
	webhookUrl: string;
	hasWebhookSecret: boolean;
	integration: IntegrationKind | '';
	/** Role id → what it means in the integration. */
	integrationMap: Record<string, LevelMapping>;
	maxDays: number | null;
	defaultDays: number | null;
	requestable: boolean;
	archived: boolean;
	roles: ResourceRole[];
	approverIds: string[];
	fulfillerIds: string[];
}

export interface AccessRequest {
	id: string;
	number: number;
	kind: RequestKind;
	reason: RequestReason;
	category: RequestCategory;
	privileged: boolean;
	/** The approval policy in force when the request was made. */
	policy: ApprovalPolicy;
	/** The auto-approval rule that approved it, as it was at the time. */
	autoRule: AutoRuleMatch | null;
	batchId: string | null;
	status: RequestStatus;
	step: number;
	requester: SessionUser | null;
	user: SessionUser;
	resource: { id: string; name: string; color: string };
	role: { id: string; name: string };
	grantId: string | null;
	justification: string;
	durationDays: number | null;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

export interface Grant {
	id: string;
	user: SessionUser;
	resource: { id: string; name: string; color: string };
	role: { id: string; name: string };
	status: GrantStatus;
	source: GrantSource;
	requestNumber: number | null;
	note: string;
	grantedAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
}

export interface Event {
	id: string;
	at: string;
	actor: SessionUser | null;
	action: string;
	requestNumber: number | null;
	subject: string;
	summary: string;
	data: Record<string, unknown>;
}

export type ReviewFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';
/** Who reviews each grant: the system's owner, or the person's manager (falling back to the owner). */
export type ReviewerMode = 'owner' | 'manager';
/** In what role someone was asked to review an item. */
export type ReviewerCapacity = 'owner' | 'approver' | 'manager' | 'admin' | '';

/** A review policy: a review that starts by itself on a schedule. */
export interface ReviewPolicy {
	id: string;
	name: string;
	enabled: boolean;
	frequency: ReviewFrequency;
	/** Every grant, or only privileged access levels. */
	scope: 'all' | 'privileged';
	/** Systems it covers (empty: all). */
	resourceIds: string[];
	reviewer: ReviewerMode;
	/** Reviewers get this many days to finish. */
	dueDays: number;
	nextRunAt: string;
	lastRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Review {
	id: string;
	name: string;
	status: 'open' | 'closed';
	dueAt: string | null;
	createdAt: string;
	closedAt: string | null;
	/** The policy that started it, if any. */
	policyId: string | null;
	policyName: string | null;
	/** What it covered, as set when it started. */
	scope: { scope?: 'all' | 'privileged'; resourceIds?: string[]; reviewer?: ReviewerMode; frequency?: ReviewFrequency };
	total: number;
	decided: number;
	revoked: number;
	/** Revoked items whose removal is done. */
	removed: number;
}

export interface ReviewItem {
	id: string;
	grant: Grant;
	privileged: boolean;
	reviewerId: string | null;
	reviewerName: string | null;
	capacity: ReviewerCapacity;
	decision: 'keep' | 'revoke' | null;
	note: string;
	decidedAt: string | null;
	decidedBy: string | null;
	/** The removal a revoke opened, and whether it's done. */
	removal: { number: number; status: RequestStatus; closedAt: string | null } | null;
}

/** A member's token for MCP clients. */
export interface PersonalToken {
	id: string;
	name: string;
	prefix: string;
	canApprove: boolean;
	createdAt: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	user: { id: string; name: string; email: string };
}

/** An API error body: `{ message, hint? }`. */
export interface ProblemInfo {
	message: string;
	hint?: string;
}

export interface Approval {
	step: number;
	decision: 'approved' | 'denied';
	capacity: ApprovalCapacity;
	approver: { id: string | null; name: string; email: string };
	comment: string;
	at: string;
}

/**
 * Auto-approval: requests that match every condition skip approval. Empty lists mean
 * "any". Privileged levels never match.
 */
export interface ApprovalRule {
	id: string;
	name: string;
	enabled: boolean;
	/** Systems it covers (empty: all). */
	resourceIds: string[];
	/** Access levels it covers, within those systems (empty: every non-privileged level). */
	roleIds: string[];
	/** Directory groups the person must be in, any of them (empty: no group condition). */
	groupIds: string[];
	/** People it covers, in addition to the groups (empty with no groups: everyone). */
	userIds: string[];
	/** The request must end within this many days (null: any duration, including permanent). */
	maxDays: number | null;
	createdAt: string;
	updatedAt: string;
}

/** What a request records about the rule that approved it. */
export interface AutoRuleMatch {
	id: string;
	name: string;
	/** Why it matched, in words, e.g. "in Engineering; 7 days (rule allows up to 14)". */
	reason: string;
}

/** An app found in an identity provider, as the scan reports it (before matching people). */
export interface ScannedApp {
	/** Stable reference, e.g. "authentik:app:<uuid>". */
	ref: string;
	name: string;
	url: string;
	description: string;
	/** Everyone in the IdP can use it (no assignments or bindings). */
	openToAll: boolean;
	/** One per group (or direct assignment) that grants the app. A null mapping can't be provisioned. */
	levels: { name: string; mapping: LevelMapping | null; emails: string[] }[];
}

/** A scanned app as the import page shows it: matched against resources and members. */
export interface DiscoveredApp extends Omit<ScannedApp, 'levels'> {
	/** The resource it was imported as, if it was. */
	resourceId: string | null;
	/** Every level can be granted through the IdP, so the import sets it up that way. */
	provisioned: boolean;
	levels: { name: string; provisioned: boolean; people: number; notMembers: string[] }[];
}

/** What a reconciliation found for one account or grant. */
export type ReconciliationStatus = 'matched' | 'unknown' | 'missing' | 'level_mismatch';
/**
 * How a finding was dealt with: recorded as existing access, removed in the system,
 * justified as a service or shared account, the ac·modern record closed, or kept as is.
 */
export type ReconciliationResolution = 'recorded' | 'removed_in_system' | 'service_account' | 'closed' | 'kept';

export interface ReconciliationCounts {
	accounts: number;
	matched: number;
	unknown: number;
	missing: number;
	level_mismatch: number;
}

/** One comparison of a system's real user list with the access recorded for it. */
export interface Reconciliation {
	id: string;
	resource: { id: string; name: string; color: string };
	source: 'csv' | 'idp';
	filename: string;
	runBy: { id: string; name: string; email: string } | null;
	createdAt: string;
	counts: ReconciliationCounts;
	/** Findings (anything but matched) not yet resolved. */
	unresolved: number;
}

export interface ReconciliationItem {
	id: string;
	account: string;
	user: { id: string; name: string; email: string; member: 'active' | 'deactivated' | null } | null;
	grantId: string | null;
	roleId: string | null;
	status: ReconciliationStatus;
	/** The level in the system (unknown, mismatch) or in ac·modern (missing). */
	level: string;
	detail: string;
	resolution: ReconciliationResolution | null;
	resolvedBy: string | null;
	resolvedAt: string | null;
	note: string;
}
