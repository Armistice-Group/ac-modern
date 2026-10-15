import { membership, userByEmail } from './accounts.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';
import { findLevel } from './mcp.ts';
import { createRequest, decide, effects, flush, getRequest, listRequests, waitingOn, type Actor } from './requests.ts';
import { listResources } from './resources.ts';
import { getSlack, orgForTeam, signingSecretFor, slackApi, slackEmail, verifySignature, type SlackConfig } from './slack.ts';
import type { AccessRequest } from '#lib/types.ts';

/**
 * Slack beyond buttons: the /access command (a request form, and what's waiting on you)
 * and replies to approval messages ("y" in the thread approves, "n <reason>" denies).
 * People are matched by email, and every action runs through the normal workflow.
 */

const who = (u: { name: string; email: string }) => u.name || u.email;
const what = (r: AccessRequest) => `${r.resource.name} (${r.role.name})`;

/** The ac·modern member behind a Slack user, or why there isn't one. */
async function slackActor(db: Db, orgId: string, cfg: SlackConfig, slackUser: string): Promise<{ actor: Actor & { userId: string } } | { error: string }> {
	const email = await slackEmail(cfg, slackUser);
	const user = email ? await userByEmail(db, email) : undefined;
	const m = user ? await membership(db, orgId, user.id) : undefined;
	const active = user ? await db.get<{ status: string }>('SELECT status FROM members WHERE org_id = ? AND user_id = ?', [orgId, user.id]) : undefined;
	if (!user || !m || active?.status !== 'active') return { error: `Your Slack email (${email ?? 'hidden'}) doesn’t match an active ac·modern account in this organisation.` };
	return { actor: { orgId, userId: user.id, admin: m.role === 'owner' || m.role === 'admin' } };
}

async function orgAndConfig(db: Db, teamId: string | undefined) {
	const orgId = teamId ? await orgForTeam(db, teamId) : null;
	const cfg = orgId ? await getSlack(db, orgId) : null;
	return orgId && cfg ? { orgId, cfg } : null;
}

const HELP = [
	'*/access* — request access to a system',
	'*/access github admin* — the same, with the system and level filled in',
	'*/access mine* — your open requests, and what’s waiting on you',
	'To approve, click *Approve* on the message, or reply *y* in its thread. To deny, reply *n* and the reason, e.g. _n not needed for this project_.'
].join('\n');

// ── The request form ──────────────────────────────────────────────────────────

const label = (s: string) => (s.length > 75 ? `${s.slice(0, 74)}…` : s);

function requestView(initial?: { text: string; value: string }) {
	return {
		type: 'modal',
		callback_id: 'acm_request',
		title: { type: 'plain_text', text: 'Request access' },
		submit: { type: 'plain_text', text: 'Request' },
		close: { type: 'plain_text', text: 'Cancel' },
		blocks: [
			{
				type: 'input',
				block_id: 'level',
				label: { type: 'plain_text', text: 'System and access level' },
				element: {
					type: 'external_select',
					action_id: 'level',
					min_query_length: 0,
					placeholder: { type: 'plain_text', text: 'Search systems' },
					...(initial ? { initial_option: { text: { type: 'plain_text', text: label(initial.text) }, value: initial.value } } : {})
				}
			},
			{
				type: 'input',
				block_id: 'days',
				optional: true,
				label: { type: 'plain_text', text: 'For how many days?' },
				hint: { type: 'plain_text', text: 'Leave blank for the system’s default.' },
				element: { type: 'number_input', action_id: 'days', is_decimal_allowed: false, min_value: '1' }
			},
			{
				type: 'input',
				block_id: 'why',
				label: { type: 'plain_text', text: 'Why do you need it?' },
				hint: { type: 'plain_text', text: 'Approvers and auditors read this.' },
				element: { type: 'plain_text_input', action_id: 'why', multiline: true }
			}
		]
	};
}

/** Options for the system picker, filtered by what's typed. */
export async function levelOptions(db: Db, orgId: string, admin: boolean, query: string) {
	const q = query.trim().toLowerCase();
	const options = [];
	for (const r of await listResources(db, orgId)) {
		if (r.archived || (!r.requestable && !admin)) continue;
		for (const x of r.roles) {
			const text = `${r.name} — ${x.name}${x.privileged ? ' (privileged)' : ''}`;
			if (q && !text.toLowerCase().includes(q)) continue;
			options.push({ text: { type: 'plain_text', text: label(text) }, value: `${r.id}:${x.id}` });
			if (options.length === 100) return options;
		}
	}
	return options;
}

/** A submitted request form: creates the request, or says which field to fix. */
export async function submitRequest(db: Db, orgId: string, cfg: SlackConfig, payload: Record<string, any>, origin: string): Promise<{ body: unknown; work?: Promise<void> }> {
	const a = await slackActor(db, orgId, cfg, payload.user?.id);
	if ('error' in a) return { body: { response_action: 'errors', errors: { level: a.error } } };
	const v = payload.view?.state?.values ?? {};
	const [resourceId, roleId] = String(v.level?.level?.selected_option?.value ?? '').split(':');
	const daysRaw = v.days?.days?.value;
	const days = daysRaw ? Number(daysRaw) : null;
	const why = String(v.why?.why?.value ?? '');
	if (!resourceId || !roleId) return { body: { response_action: 'errors', errors: { level: 'Pick a system and level' } } };
	const fx = effects();
	let req: AccessRequest;
	try {
		req = await createRequest(db, a.actor, { userId: a.actor.userId, resourceId, roleId, justification: why, durationDays: days, via: 'slack' }, fx);
	} catch (err) {
		if (!(err instanceof HttpError)) throw err;
		const m = err.message;
		const field = /day|duration/i.test(m) ? 'days' : /why|reason|briefly/i.test(m) ? 'why' : 'level';
		return { body: { response_action: 'errors', errors: { [field]: m } } };
	}
	// Answer Slack within its three seconds; setup and messages follow.
	const work = (async () => {
		await flush(db, orgId, fx, origin);
		const now = await getRequest(db, orgId, { id: req.id });
		const state =
			now.status === 'pending_approval'
				? 'It’s waiting for approval; you’ll hear here when it’s decided.'
				: now.status === 'completed'
					? 'Access is set up.'
					: now.autoRule
						? `Auto-approved by the rule “${now.autoRule.name}”; it’s being set up.`
						: 'No approval needed; it’s being set up.';
		await slackApi(cfg.botToken, 'chat.postMessage', { channel: payload.user.id, text: `📨 Request #${now.number} for ${what(now)}. ${state} <${origin}/requests/${now.number}|Open>`, unfurl_links: false });
	})().catch((e) => console.error('[ac-modern] slack request', e));
	return { body: { response_action: 'clear' }, work };
}

// ── /access ───────────────────────────────────────────────────────────────────

export async function handleCommand(db: Db, raw: string, headers: { timestamp: string | null; signature: string | null }, origin: string): Promise<{ status: number; body?: unknown }> {
	const form = new URLSearchParams(raw);
	const found = await orgAndConfig(db, form.get('team_id') ?? undefined);
	if (!found || !verifySignature(signingSecretFor(found.cfg), headers.timestamp, raw, headers.signature)) return { status: 401 };
	const { orgId, cfg } = found;
	const ephemeral = (text: string) => ({ status: 200, body: { response_type: 'ephemeral', text } });
	const text = (form.get('text') ?? '').trim();
	const a = await slackActor(db, orgId, cfg, form.get('user_id') ?? '');
	if ('error' in a) return ephemeral(a.error);

	if (/^(help|\?)$/i.test(text)) return ephemeral(HELP);
	if (/^(mine|status|list|me)$/i.test(text)) {
		const { toApprove, toFulfill } = await waitingOn(db, orgId, a.actor.userId);
		const mine = await listRequests(db, orgId, { involving: a.actor.userId, statuses: ['pending_approval', 'pending_fulfillment'], limit: 20 });
		const line = (r: AccessRequest) => `• <${origin}/requests/${r.number}|#${r.number}> ${who(r.user)} → ${what(r)}`;
		const parts = [
			toApprove.length ? `*Waiting for your approval*\n${toApprove.map(line).join('\n')}` : '',
			toFulfill.length ? `*Waiting for you to set up*\n${toFulfill.map(line).join('\n')}` : '',
			mine.length ? `*Your open requests*\n${mine.map((r) => `${line(r)} — ${r.status === 'pending_approval' ? 'waiting for approval' : 'being set up'}`).join('\n')}` : ''
		].filter(Boolean);
		return ephemeral(parts.join('\n\n') || 'Nothing open, and nothing waiting on you.');
	}

	// "/access github admin": fill in the system (and level) when the words match one.
	let initial: { text: string; value: string } | undefined;
	if (text) {
		const words = text.split(/\s+/);
		const tries: [string, string | undefined][] = [[text, undefined]];
		if (words.length > 1) tries.push([words.slice(0, -1).join(' '), words.at(-1)]);
		for (const [system, level] of tries) {
			try {
				const { resource, roleId } = await findLevel(db, orgId, system, level);
				const role = resource.roles.find((x) => x.id === roleId)!;
				initial = { text: `${resource.name} — ${role.name}${role.privileged ? ' (privileged)' : ''}`, value: `${resource.id}:${roleId}` };
				break;
			} catch {}
		}
	}
	try {
		await slackApi(cfg.botToken, 'views.open', { trigger_id: form.get('trigger_id'), view: requestView(initial) });
	} catch (err) {
		return ephemeral(`⚠️ Couldn’t open the form: ${(err as Error).message}`);
	}
	return { status: 200 };
}

// ── Replies to approval messages ──────────────────────────────────────────────

// Deliberately short: "ok, will look later" mustn't approve anything.
const YES = new Set(['y', 'yes', 'approve', 'approved', 'lgtm', ':+1:', ':thumbsup:', ':white_check_mark:', ':heavy_check_mark:', '👍', '✅']);
const NO = new Set(['n', 'no', 'deny', 'denied', 'reject', ':-1:', ':thumbsdown:', ':x:', '👎', '❌']);

/** "y", "approve 42 looks fine", "n not needed", "deny #42: wrong team". */
export function parseReply(text: string): { decision: 'approved' | 'denied' | null; number: number | null; note: string } {
	const m = /^(\S+?)[.!,:]*(?:\s+|$)(.*)$/s.exec(text.trim());
	if (!m) return { decision: null, number: null, note: '' };
	const word = m[1].toLowerCase();
	const decision = YES.has(word) ? 'approved' : NO.has(word) ? 'denied' : null;
	if (!decision) return { decision: null, number: null, note: '' };
	const n = /^#?(\d+)\b[\s:,.\-–—]*(.*)$/s.exec(m[2]);
	return { decision, number: n ? Number(n[1]) : null, note: (n ? n[2] : m[2]).replace(/^[\s:,\-–—]+/, '').trim() };
}

/** Remembers an approval DM, so a reply in its thread can be matched to the request. */
export async function rememberApprovalMessage(db: Db, orgId: string, requestId: string, channel: string, ts: string) {
	await db.run('INSERT INTO slack_messages (channel, ts, org_id, request_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (channel, ts) DO NOTHING', [channel, ts, orgId, requestId, new Date().toISOString()]);
}

async function onDirectMessage(db: Db, orgId: string, cfg: SlackConfig, event: Record<string, any>, origin: string) {
	const channel = String(event.channel);
	const thread = event.thread_ts ? String(event.thread_ts) : null;
	const say = (text: string) => slackApi(cfg.botToken, 'chat.postMessage', { channel, text, ...(thread ? { thread_ts: thread } : {}), unfurl_links: false }).catch(() => {});
	const text = String(event.text ?? '').trim();
	if (/^(help|\?)$/i.test(text)) return say(HELP);
	const r = parseReply(text);
	const linked = thread ? await db.get<{ request_id: string }>('SELECT request_id FROM slack_messages WHERE org_id = ? AND channel = ? AND ts = ?', [orgId, channel, thread]) : undefined;
	if (!r.decision) {
		// Chatter outside an approval thread gets the help once; inside one, a nudge.
		return linked ? say('Reply *y* to approve, or *n* and the reason to deny.') : thread ? undefined : say(HELP);
	}
	let requestId = linked?.request_id;
	if (!requestId && r.number) {
		try {
			requestId = (await getRequest(db, orgId, { number: r.number })).id;
		} catch {
			return say(`There’s no request #${r.number}.`);
		}
	}
	if (!requestId) return say(`Which request? Reply in the request’s thread, or say *${r.decision === 'approved' ? 'approve' : 'deny'} 42*${r.decision === 'denied' ? ' and the reason' : ''}.`);
	if (r.decision === 'denied' && !r.note) return say('Say why after the *n*, e.g. _n not needed for this project_. They’ll see it.');

	const a = await slackActor(db, orgId, cfg, String(event.user));
	if ('error' in a) return say(a.error);
	const fx = effects();
	try {
		await decide(db, a.actor, requestId, r.decision, r.note, fx, 'slack');
	} catch (err) {
		return say(`⚠️ ${err instanceof HttpError ? err.message : 'Something went wrong'}`);
	}
	const req = await getRequest(db, orgId, { id: requestId });
	const done = r.decision === 'approved' ? `✅ You approved #${req.number}: ${who(req.user)} → ${what(req)}.` : `❌ You denied #${req.number}: “${r.note}”`;
	await say(`${done} <${origin}/requests/${req.number}|Open>`);
	// Take the buttons off the original message(s) so nobody clicks a stale Approve.
	for (const m of await db.all<{ channel: string; ts: string }>('SELECT channel, ts FROM slack_messages WHERE org_id = ? AND request_id = ? AND channel = ?', [orgId, requestId, channel]))
		await slackApi(cfg.botToken, 'chat.update', { channel: m.channel, ts: m.ts, text: done, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: done } }] }).catch(() => {});
	await flush(db, orgId, fx, origin);
}

/**
 * Slack's Events API. Answers at once (Slack wants a reply within three seconds and
 * retries otherwise); the work runs after, in `work`.
 */
export async function handleEvent(
	db: Db,
	raw: string,
	headers: { timestamp: string | null; signature: string | null; retry: string | null },
	origin: string
): Promise<{ status: number; body?: unknown; work?: Promise<void> }> {
	let body: Record<string, any>;
	try {
		body = JSON.parse(raw);
	} catch {
		return { status: 400 };
	}
	// Slack checks the URL when the app is created, before ac·modern has its signing secret.
	// Echoing the challenge reveals and changes nothing.
	if (body.type === 'url_verification') return { status: 200, body: { challenge: body.challenge } };
	const found = await orgAndConfig(db, body.team_id);
	if (!found || !verifySignature(signingSecretFor(found.cfg), headers.timestamp, raw, headers.signature)) return { status: 401 };
	// We answered the first delivery straight away; a retry would act twice.
	if (headers.retry) return { status: 200 };
	const event = body.event ?? {};
	if (body.type !== 'event_callback' || event.type !== 'message' || event.channel_type !== 'im' || event.subtype || event.bot_id || !event.user) return { status: 200 };
	const work = onDirectMessage(db, found.orgId, found.cfg, event, origin).then(
		() => {},
		(e) => console.error('[ac-modern] slack event', e)
	);
	return { status: 200, work };
}
