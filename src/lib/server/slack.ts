import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import type { Db } from './db.ts';
import { getIntegration, saveIntegration, deleteIntegration } from './integrations.ts';

/**
 * The Slack app: direct messages to approvers with Approve/Deny buttons, and updates to
 * requesters. Each org connects its own app (bot token + signing secret), or in cloud mode
 * installs the shared app through OAuth.
 */
export interface SlackConfig {
	botToken: string;
	/** Empty when the shared cloud app is used (its secret comes from the environment). */
	signingSecret: string;
	teamId: string;
	teamName: string;
	shared?: boolean;
}

let slackFetch: typeof fetch = (...a) => fetch(...a);
export function setSlackFetch(f: typeof fetch) {
	slackFetch = f;
}

export async function slackApi<T = Record<string, unknown>>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
	const res = await slackFetch(`https://slack.com/api/${method}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000)
	});
	const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; error?: string } & T;
	if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? 'failed'}`);
	return data;
}

export const getSlack = (db: Db, orgId: string) => getIntegration<SlackConfig>(db, orgId, 'slack');

export async function connectSlack(db: Db, orgId: string, input: { botToken: string; signingSecret: string; shared?: boolean }) {
	const auth = await slackApi<{ team_id: string; team: string }>(input.botToken, 'auth.test');
	const taken = await db.get<{ org_id: string }>('SELECT org_id FROM slack_teams WHERE team_id = ?', [auth.team_id]);
	if (taken && taken.org_id !== orgId) throw new Error('That Slack workspace is connected to another organisation');
	await saveIntegration(db, orgId, 'slack', { botToken: input.botToken, signingSecret: input.signingSecret, teamId: auth.team_id, teamName: auth.team, shared: !!input.shared });
	await db.run('DELETE FROM slack_teams WHERE org_id = ?', [orgId]);
	await db.run('INSERT INTO slack_teams (team_id, org_id) VALUES (?, ?)', [auth.team_id, orgId]);
	return { team: auth.team };
}

export async function disconnectSlack(db: Db, orgId: string) {
	await deleteIntegration(db, orgId, 'slack');
	await db.run('DELETE FROM slack_teams WHERE org_id = ?', [orgId]);
}

export async function orgForTeam(db: Db, teamId: string) {
	return (await db.get<{ org_id: string }>('SELECT org_id FROM slack_teams WHERE team_id = ?', [teamId]))?.org_id ?? null;
}

/** Slack's request signing: v0=HMAC-SHA256(secret, "v0:<ts>:<raw body>"), within five minutes. */
export function verifySignature(secret: string, timestamp: string | null, body: string, signature: string | null, now = Date.now()): boolean {
	if (!secret || !timestamp || !signature) return false;
	if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
	const want = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
	return want.length === signature.length && timingSafeEqual(Buffer.from(want), Buffer.from(signature));
}

export function signingSecretFor(cfg: SlackConfig): string {
	return cfg.shared ? (config.slackApp?.signingSecret ?? '') : cfg.signingSecret;
}

const slackIds = new Map<string, { id: string; at: number }>();
/** A person's Slack user id, by email (cached for an hour). */
export async function slackUserId(cfg: SlackConfig, email: string): Promise<string | null> {
	const key = `${cfg.teamId}:${email}`;
	const hit = slackIds.get(key);
	if (hit && Date.now() - hit.at < 3_600_000) return hit.id;
	try {
		const r = await slackApi<{ user: { id: string } }>(cfg.botToken, 'users.lookupByEmail', { email });
		slackIds.set(key, { id: r.user.id, at: Date.now() });
		return r.user.id;
	} catch {
		return null;
	}
}

export async function slackEmail(cfg: SlackConfig, slackUser: string): Promise<string | null> {
	try {
		const r = await slackApi<{ user: { profile: { email?: string } } }>(cfg.botToken, 'users.info', { user: slackUser });
		return r.user.profile.email?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

/** The app manifest for "Create an app from a manifest". */
export function manifest(orgName: string, interactionsUrl: string) {
	return {
		display_information: { name: 'ac·modern', description: `Access requests for ${orgName}`, background_color: '#5b21b6' },
		features: { bot_user: { display_name: 'ac·modern', always_online: true } },
		oauth_config: { scopes: { bot: ['chat:write', 'im:write', 'users:read', 'users:read.email'] } },
		settings: { interactivity: { is_enabled: true, request_url: interactionsUrl }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false }
	};
}
