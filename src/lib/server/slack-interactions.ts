import { membership, userByEmail } from './accounts.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';
import { decide, effects, flush, getRequest } from './requests.ts';
import { getSlack, orgForTeam, signingSecretFor, slackApi, slackEmail, verifySignature } from './slack.ts';

/**
 * Handles Slack button clicks and the "why are you denying" modal. The clicker is matched
 * to their ac·modern account by email, and the approval goes through the same checks as
 * on the web: only the approvers for the current step can act.
 */
export async function handleInteraction(
	db: Db,
	raw: string,
	headers: { timestamp: string | null; signature: string | null },
	origin: string,
	post: (url: string, body: unknown) => Promise<unknown> = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
): Promise<{ status: number; body?: unknown }> {
	const payload = JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}');
	const teamId = payload.team?.id ?? payload.user?.team_id;
	const orgId = teamId ? await orgForTeam(db, teamId) : null;
	const cfg = orgId ? await getSlack(db, orgId) : null;
	if (!orgId || !cfg || !verifySignature(signingSecretFor(cfg), headers.timestamp, raw, headers.signature)) return { status: 401 };

	const email = await slackEmail(cfg, payload.user?.id);
	const user = email ? await userByEmail(db, email) : undefined;
	const m = user ? await membership(db, orgId, user.id) : undefined;
	const reply = (url: string | undefined, text: string, replace = false) =>
		url ? post(url, { text, replace_original: replace, response_type: 'ephemeral' }).catch(() => {}) : Promise.resolve();

	if (payload.type === 'block_actions') {
		const action = payload.actions?.[0];
		if (!action || action.action_id === 'open') return { status: 200 };
		if (!user || !m) {
			await reply(payload.response_url, `Your Slack email (${email ?? 'hidden'}) doesn’t match an ac·modern account in this organisation.`);
			return { status: 200 };
		}
		const actor = { orgId, userId: user.id, admin: m.role === 'owner' || m.role === 'admin' };
		if (action.action_id === 'deny') {
			await slackApi(cfg.botToken, 'views.open', {
				trigger_id: payload.trigger_id,
				view: {
					type: 'modal',
					callback_id: 'acm_deny',
					private_metadata: JSON.stringify({ requestId: action.value, responseUrl: payload.response_url }),
					title: { type: 'plain_text', text: 'Deny request' },
					submit: { type: 'plain_text', text: 'Deny' },
					close: { type: 'plain_text', text: 'Cancel' },
					blocks: [{ type: 'input', block_id: 'reason', label: { type: 'plain_text', text: 'Why? They’ll see this.' }, element: { type: 'plain_text_input', action_id: 'reason', multiline: true } }]
				}
			});
			return { status: 200 };
		}
		if (action.action_id === 'approve') {
			const fx = effects();
			try {
				await decide(db, actor, action.value, 'approved', '', fx, 'slack');
				const req = await getRequest(db, orgId, { id: action.value });
				await reply(payload.response_url, `✅ You approved #${req.number}: ${req.user.name || req.user.email} → ${req.resource.name} (${req.role.name}). <${origin}/requests/${req.number}|Open>`, true);
			} catch (err) {
				await reply(payload.response_url, `⚠️ ${err instanceof HttpError ? err.message : 'Something went wrong'}`);
			}
			void flush(db, orgId, fx, origin).catch((e) => console.error('[ac-modern] slack flush', e));
		}
		return { status: 200 };
	}

	if (payload.type === 'view_submission' && payload.view?.callback_id === 'acm_deny') {
		const meta = JSON.parse(payload.view.private_metadata || '{}') as { requestId: string; responseUrl?: string };
		const reason = String(payload.view.state?.values?.reason?.reason?.value ?? '').trim();
		if (!user || !m) return { status: 200, body: { response_action: 'errors', errors: { reason: 'Your Slack email doesn’t match an ac·modern account here.' } } };
		const fx = effects();
		try {
			await decide(db, { orgId, userId: user.id, admin: m.role === 'owner' || m.role === 'admin' }, meta.requestId, 'denied', reason, fx, 'slack');
		} catch (err) {
			return { status: 200, body: { response_action: 'errors', errors: { reason: err instanceof HttpError ? err.message : 'Something went wrong' } } };
		}
		const req = await getRequest(db, orgId, { id: meta.requestId });
		await reply(meta.responseUrl, `❌ You denied #${req.number}: “${reason}”`, true);
		void flush(db, orgId, fx, origin).catch((e) => console.error('[ac-modern] slack flush', e));
		return { status: 200 };
	}
	return { status: 200 };
}
