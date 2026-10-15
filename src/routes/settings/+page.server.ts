import { orgSettings } from '#lib/server/accounts.ts';
import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	const d = await db();
	const s = await orgSettings(d, c.org.id);
	return {
		name: c.org.name,
		slackConfigured: !!s.slackWebhook,
		allowOnBehalf: !!s.allowOnBehalf,
		expiryReminderDays: s.expiryReminderDays ?? 3,
		defaultApproval: s.defaultApproval ?? 'approvers',
		requirePrivilegedApproval: s.requirePrivilegedApproval !== false,
		allowAdminOverride: !!s.allowAdminOverride,
		removalSlaHours: s.removalSlaHours ?? 24,
		sessionMaxHours: s.sessionMaxHours ?? 720,
		sessionIdleMinutes: s.sessionIdleMinutes ?? 0,
		requireSecondAdmin: !!s.requireSecondAdmin,
		requireMfa: !!s.requireMfa,
		mfaCoverage: await d.get<{ total: number; enabled: number }>(
			"SELECT CAST(COUNT(*) AS INTEGER) AS total, CAST(COALESCE(SUM(CASE WHEN u.totp_enabled_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS INTEGER) AS enabled FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.status = 'active' AND u.password_hash IS NOT NULL",
			[c.org.id]
		),
		smtp: !!config.smtp,
		database: d.kind,
		mode: config.mode
	};
};
