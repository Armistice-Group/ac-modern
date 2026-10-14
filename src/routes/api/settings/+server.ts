import { json } from '@sveltejs/kit';
import { renameOrg, saveOrgSettings } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, badRequest, body, handler, int, str } from '#lib/server/http.ts';
import { APPROVAL_POLICIES } from '#lib/server/resources.ts';
import type { ApprovalPolicy, OrgSettings } from '#lib/types.ts';

export const PATCH = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const patch: Partial<OrgSettings> = {};
	const changed: string[] = [];
	if (b.name !== undefined) {
		const name = str(b, 'name', { required: true, max: 80 });
		await renameOrg(d, c.org.id, name);
		changed.push('name');
	}
	if (b.slackWebhook !== undefined) {
		const url = str(b, 'slackWebhook', { max: 500 });
		if (url && !/^https:\/\/hooks\.slack\.com\//.test(url)) throw badRequest('That doesn’t look like a Slack incoming-webhook URL (https://hooks.slack.com/…)');
		patch.slackWebhook = url || undefined;
		changed.push('Slack');
	}
	if (b.allowOnBehalf !== undefined) (patch.allowOnBehalf = b.allowOnBehalf === true), changed.push('requests on behalf');
	if (b.expiryReminderDays !== undefined) (patch.expiryReminderDays = int(b, 'expiryReminderDays', { min: 0, max: 60 }) ?? 0), changed.push('expiry reminders');
	if (b.requirePrivilegedApproval !== undefined) (patch.requirePrivilegedApproval = b.requirePrivilegedApproval === true), changed.push(`privileged approval ${b.requirePrivilegedApproval ? 'required' : 'not required'}`);
	if (b.allowAdminOverride !== undefined) (patch.allowAdminOverride = b.allowAdminOverride === true), changed.push(`admin override ${b.allowAdminOverride ? 'allowed' : 'not allowed'}`);
	if (b.defaultApproval !== undefined) {
		if (!APPROVAL_POLICIES.includes(b.defaultApproval as ApprovalPolicy)) throw badRequest('Unknown approval policy');
		patch.defaultApproval = b.defaultApproval as ApprovalPolicy;
		changed.push('default approval');
	}
	await saveOrgSettings(d, c.org.id, patch);
	if (changed.length) await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: `Changed settings: ${changed.join(', ')}` });
	return json({ ok: true });
});
