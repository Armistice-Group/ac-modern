import type { ApprovalCapacity, RequestCategory, RequestReason, RequestStatus, Role } from './types.ts';

export function displayName(u: { name: string; email: string } | null | undefined): string {
	if (!u) return 'System';
	return u.name || u.email;
}

export function initials(u: { name: string; email: string }): string {
	const n = (u.name || u.email).trim();
	const parts = n.split(/[\s.@_-]+/).filter(Boolean);
	return ((parts[0]?.[0] ?? '') + (u.name ? (parts[1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function ago(iso: string | null, nowMs = Date.now()): string {
	if (!iso) return '—';
	const s = Math.round((Date.parse(iso) - nowMs) / 1000);
	const a = Math.abs(s);
	if (a < 45) return s <= 0 ? 'just now' : 'in a moment';
	if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
	if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
	if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
	if (a < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), 'month');
	return rtf.format(Math.round(s / (86400 * 365)), 'year');
}

export function date(iso: string | null): string {
	if (!iso) return '—';
	return new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dateTime(iso: string | null): string {
	if (!iso) return '—';
	return new Date(iso).toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function daysLeft(iso: string | null, nowMs = Date.now()): number | null {
	if (!iso) return null;
	return Math.ceil((Date.parse(iso) - nowMs) / 86_400_000);
}

export function duration(days: number | null): string {
	if (days === null) return 'Permanent';
	if (days % 365 === 0) return `${days / 365} ${days === 365 ? 'year' : 'years'}`;
	if (days % 30 === 0 && days >= 30) return `${days / 30} ${days === 30 ? 'month' : 'months'}`;
	if (days % 7 === 0 && days >= 7) return `${days / 7} ${days === 7 ? 'week' : 'weeks'}`;
	return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export const STATUS: Record<RequestStatus, { label: string; badge: string; dot: string }> = {
	pending_approval: { label: 'Awaiting approval', badge: 'badge-warning', dot: 'bg-warning' },
	pending_fulfillment: { label: 'Being set up', badge: 'badge-primary', dot: 'bg-primary' },
	completed: { label: 'Done', badge: 'badge-success', dot: 'bg-success' },
	denied: { label: 'Denied', badge: 'badge-danger', dot: 'bg-danger' },
	cancelled: { label: 'Cancelled', badge: '', dot: 'bg-muted-foreground/50' }
};

export const REVOKE_STATUS: Partial<Record<RequestStatus, string>> = {
	pending_fulfillment: 'Being removed',
	completed: 'Removed'
};

export const REASON: Record<RequestReason, string> = {
	request: 'Requested',
	expired: 'Expired',
	review: 'Access review',
	offboarding: 'Offboarding',
	transfer: 'Transfer',
	manual: 'Revoked by admin'
};

export const CATEGORY: Record<RequestCategory, string> = {
	new_hire: 'New hire',
	transfer: 'Transfer',
	change: 'Permission change',
	new_access: 'Additional access',
	extension: 'Extension',
	removal: 'Removal'
};

export const CAPACITY: Record<ApprovalCapacity, string> = {
	manager: 'Manager',
	system_owner: 'System owner',
	approver: 'Designated approver',
	admin_fallback: 'Admin (fallback)',
	admin_override: 'Admin override',
	self: 'Self-approved',
	'': 'Approver'
};

/** Capacities an auditor would want explained. */
export const EXCEPTION_CAPACITIES: ApprovalCapacity[] = ['admin_fallback', 'admin_override', 'self'];

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export const APPROVAL_LABEL = {
	none: 'No approval',
	manager: 'Their manager',
	approvers: 'Resource approvers',
	manager_then_approvers: 'Manager, then approvers'
} as const;

export const DURATIONS: { days: number | null; label: string }[] = [
	{ days: 1, label: '1 day' },
	{ days: 7, label: '1 week' },
	{ days: 30, label: '30 days' },
	{ days: 90, label: '90 days' },
	{ days: 180, label: '6 months' },
	{ days: 365, label: '1 year' },
	{ days: null, label: 'Permanent' }
];

/** Resource tile colours, as oklch hues (lightness/chroma come from the theme). */
export const HUES: Record<string, number> = {
	violet: 292,
	blue: 255,
	cyan: 215,
	green: 155,
	amber: 80,
	orange: 50,
	red: 25,
	pink: 350,
	slate: 260
};
