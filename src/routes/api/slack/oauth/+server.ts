import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '#lib/server/config.ts';
import { decrypt } from '#lib/server/crypto.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { connectSlack } from '#lib/server/slack.ts';

export const GET: RequestHandler = async ({ url, locals }): Promise<Response> => {
	const back = (msg: string): never => redirect(303, `/settings/integrations?slack=${encodeURIComponent(msg)}`);
	if (!config.slackApp) back('Slack isn’t configured on this server');
	let state: { orgId: string; userId: string; at: number };
	try {
		state = JSON.parse(decrypt(url.searchParams.get('state') ?? '', 'slack-oauth'));
		if (Date.now() - state.at > 15 * 60_000) throw new Error();
	} catch {
		back('That Slack sign-in expired; try again');
	}
	// The browser that started the install must still be signed in as the same admin.
	if (locals.user?.id !== state!.userId) back('Sign in as the admin who started the install');
	if (url.searchParams.get('error')) back(url.searchParams.get('error')!);
	const res = await fetch('https://slack.com/api/oauth.v2.access', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: config.slackApp!.clientId, client_secret: config.slackApp!.clientSecret, code: url.searchParams.get('code') ?? '', redirect_uri: `${locals.origin}/api/slack/oauth` })
	});
	const data = (await res.json()) as { ok: boolean; error?: string; access_token?: string };
	if (!data.ok || !data.access_token) back(`Slack said: ${data.error ?? 'no token'}`);
	const d = await db();
	try {
		const r = await connectSlack(d, state!.orgId, { botToken: data.access_token!, signingSecret: '', shared: true });
		await record(d, { orgId: state!.orgId, actorId: state!.userId, action: 'settings.updated', subject: 'Slack', summary: `Added ac·modern to Slack (${r.team})` });
	} catch (err) {
		back((err as Error).message);
	}
	return back('connected');
};
