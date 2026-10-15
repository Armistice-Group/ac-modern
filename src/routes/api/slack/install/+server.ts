import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '#lib/server/config.ts';
import { encrypt } from '#lib/server/crypto.ts';
import { adminCtx } from '#lib/server/http.ts';
import { SLACK_SCOPES } from '#lib/server/slack.ts';

/** Cloud: "Add to Slack" with the shared app. */
export const GET: RequestHandler = async ({ locals }) => {
	const c = adminCtx(locals);
	if (!config.slackApp) redirect(303, '/settings/integrations');
	const state = encrypt(JSON.stringify({ orgId: c.org.id, userId: c.user.id, at: Date.now() }), 'slack-oauth');
	const u = new URL('https://slack.com/oauth/v2/authorize');
	u.searchParams.set('client_id', config.slackApp.clientId);
	u.searchParams.set('scope', SLACK_SCOPES.join(','));
	u.searchParams.set('redirect_uri', `${locals.origin}/api/slack/oauth`);
	u.searchParams.set('state', state);
	redirect(303, u.href, { external: true });
};
