import { json } from '@sveltejs/kit';
import { adminIds, orgSettings, renameOrg, saveOrgSettings } from '#lib/server/accounts.ts';
import { changeOrPropose, changeResponse, describeSettings } from '#lib/server/control-changes.ts';
import { effects, flush } from '#lib/server/requests.ts';
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
	// Approval controls: applied now, or sent to a second admin when that's required.
	const controls: Partial<OrgSettings> = {};
	if (b.requirePrivilegedApproval !== undefined) controls.requirePrivilegedApproval = b.requirePrivilegedApproval === true;
	if (b.allowAdminOverride !== undefined) controls.allowAdminOverride = b.allowAdminOverride === true;
	if (b.defaultApproval !== undefined) {
		if (!APPROVAL_POLICIES.includes(b.defaultApproval as ApprovalPolicy)) throw badRequest('Unknown approval policy');
		controls.defaultApproval = b.defaultApproval as ApprovalPolicy;
	}
	if (b.removalSlaHours !== undefined) controls.removalSlaHours = int(b, 'removalSlaHours', { min: 1, max: 720 }) ?? 24;
	if (b.sessionMaxHours !== undefined) controls.sessionMaxHours = int(b, 'sessionMaxHours', { min: 1, max: 2160 }) ?? 720;
	if (b.sessionIdleMinutes !== undefined) controls.sessionIdleMinutes = int(b, 'sessionIdleMinutes', { min: 0, max: 1440 }) ?? 0;
	if (b.requireSecondAdmin !== undefined) controls.requireSecondAdmin = b.requireSecondAdmin === true;

	await saveOrgSettings(d, c.org.id, patch);
	if (changed.length) await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: `Changed settings: ${changed.join(', ')}` });
	if (!Object.keys(controls).length) return json({ ok: true });

	const current = await orgSettings(d, c.org.id);
	if (controls.requireSecondAdmin && !current.requireSecondAdmin && (await adminIds(d, c.org.id)).length < 2) throw badRequest('Make someone else an admin first: there has to be a second admin to approve changes.');
	// Turning two-person control on only tightens things, so it never waits.
	const tightening = Object.keys(controls).length === 1 && controls.requireSecondAdmin === true;
	const fx = effects();
	const r = await changeOrPropose(d, c.org.id, c.user.id, { kind: 'settings', action: 'update', targetId: null, payload: controls, summary: `Change approval controls: ${describeSettings(controls)}` }, fx, !tightening);
	await flush(d, c.org.id, fx, event.locals.origin);
	return changeResponse(r);
});
