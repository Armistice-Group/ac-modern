import { orgSettings } from './accounts.ts';
import { config } from './config.ts';
import { getSlack, slackApi, slackUserId } from './slack.ts';
import type { Db } from './db.ts';
import { db as getDb } from './db.ts';

/**
 * Something a person should hear about. Workflow code collects these while it runs in a
 * transaction and hands them to deliver() once the change is committed, so nobody is told
 * about a change that rolled back.
 */
export interface Notice {
	orgId: string;
	/** User ids to email. */
	to: string[];
	subject: string;
	text: string;
	/** App path the message links to, e.g. /requests/12. */
	path: string;
	/** Also post to the organisation's Slack channel. */
	slack?: boolean;
	/** An approval request: Slack DMs get Approve/Deny buttons for this request id. */
	approve?: { requestId: string; number: number; summary: string; justification: string; privileged: boolean };
}

let transport: { sendMail: (m: Record<string, unknown>) => Promise<unknown> } | null | undefined;

async function mailer() {
	if (transport !== undefined) return transport;
	if (!config.smtp) return (transport = null);
	const { default: nodemailer } = await import('nodemailer');
	transport = nodemailer.createTransport(config.smtp.url);
	return transport;
}

/** Sent messages, newest last; tests and the dev console read this when no SMTP server is set. */
export const outbox: { to: string; subject: string; text: string }[] = [];

export async function deliver(notices: Notice[], origin = config.publicUrl) {
	if (!notices.length) return;
	const db = await getDb();
	for (const n of notices) {
		const link = `${origin}${n.path}`;
		const ids = [...new Set(n.to)];
		const recipients = ids.length
			? await db.all<{ email: string }>(
					`SELECT u.email FROM users u JOIN members m ON m.user_id = u.id AND m.org_id = ? WHERE m.status = 'active' AND u.id IN (${ids.map(() => '?').join(',')})`,
					[n.orgId, ...ids]
				)
			: [];
		await slackDms(db, n, recipients.map((r) => r.email), link);
		for (const r of recipients) {
			const text = `${n.text}\n\n${link}\n\n— ac·modern`;
			outbox.push({ to: r.email, subject: n.subject, text });
			if (outbox.length > 200) outbox.shift();
			try {
				const t = await mailer();
				if (t) await t.sendMail({ from: config.smtp!.from, to: r.email, subject: n.subject, text });
			} catch (err) {
				console.warn(`[ac-modern] Email to ${r.email} failed: ${(err as Error).message}`);
			}
		}
		if (n.slack) {
			try {
				const { slackWebhook } = await orgSettings(db, n.orgId);
				if (slackWebhook) await postSlack(slackWebhook, `*${n.subject}*\n${n.text}\n<${link}|Open in ac·modern>`);
			} catch (err) {
				console.warn(`[ac-modern] Slack notification failed: ${(err as Error).message}`);
			}
		}
	}
}

export async function postSlack(url: string, text: string) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ text }),
		signal: AbortSignal.timeout(10_000)
	});
	if (!res.ok) throw new Error(`Slack answered ${res.status} ${await res.text().catch(() => '')}`.trim());
}

/** Direct messages through the org's Slack app, when one is connected. Never throws. */
async function slackDms(db: Db, n: Notice, emails: string[], link: string) {
	if (!emails.length) return;
	let cfg;
	try {
		cfg = await getSlack(db, n.orgId);
	} catch {
		return;
	}
	if (!cfg?.botToken) return;
	for (const email of emails) {
		try {
			const user = await slackUserId(cfg, email);
			if (!user) continue;
			const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*${escape(n.subject)}*\n${escape(n.text)}` } }];
			if (n.approve) {
				blocks.push({
					type: 'actions',
					block_id: `acm:${n.approve.requestId}`,
					elements: [
						{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve', value: n.approve.requestId },
						{ type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny…' }, action_id: 'deny', value: n.approve.requestId },
						{ type: 'button', text: { type: 'plain_text', text: 'Open' }, action_id: 'open', url: link }
					]
				});
				blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Or reply in this thread: *y* to approve, *n* and the reason to deny.' }] });
			} else blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|Open in ac·modern>` }] });
			const sent = await slackApi<{ channel: string; ts: string }>(cfg.botToken, 'chat.postMessage', { channel: user, text: n.subject, blocks, unfurl_links: false });
			if (n.approve && sent.channel && sent.ts) {
				const { rememberApprovalMessage } = await import('./slack-commands.ts');
				await rememberApprovalMessage(db, n.orgId, n.approve.requestId, sent.channel, sent.ts);
			}
		} catch (err) {
			console.warn(`[ac-modern] Slack DM to ${email} failed: ${(err as Error).message}`);
		}
	}
}

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** One email to one address (password resets). Returns whether SMTP actually sent it. */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
	outbox.push({ to, subject, text });
	if (outbox.length > 200) outbox.shift();
	const t = await mailer();
	if (!t) return false;
	await t.sendMail({ from: config.smtp!.from, to, subject, text });
	return true;
}
