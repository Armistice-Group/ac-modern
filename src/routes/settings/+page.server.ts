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
		smtp: !!config.smtp,
		database: d.kind,
		mode: config.mode
	};
};
