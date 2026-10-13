export type Role = 'owner' | 'admin' | 'member';
export type ApprovalPolicy = 'none' | 'manager' | 'approvers' | 'manager_then_approvers';
export type Fulfillment = 'manual' | 'webhook';
export type RequestStatus = 'pending_approval' | 'pending_fulfillment' | 'completed' | 'denied' | 'cancelled';
export type RequestKind = 'grant' | 'revoke';
/** Why a revoke request exists. Grant requests are always 'request'. */
export type RequestReason = 'request' | 'expired' | 'review' | 'offboarding' | 'manual';
export type GrantStatus = 'active' | 'pending_revoke' | 'revoked';
export type GrantSource = 'request' | 'manual' | 'import';

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

export interface Review {
	id: string;
	name: string;
	status: 'open' | 'closed';
	dueAt: string | null;
	createdAt: string;
	closedAt: string | null;
	total: number;
	decided: number;
	revoked: number;
}

export interface ReviewItem {
	id: string;
	grant: Grant;
	reviewerId: string | null;
	reviewerName: string | null;
	decision: 'keep' | 'revoke' | null;
	note: string;
	decidedAt: string | null;
}

/** An API error body: `{ message, hint? }`. */
export interface ProblemInfo {
	message: string;
	hint?: string;
}
