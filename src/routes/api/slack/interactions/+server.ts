import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db.ts';
import { handleInteraction } from '#lib/server/slack-interactions.ts';

/** Slack's interactivity endpoint: signed form posts, answered within three seconds. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const raw = await request.text();
	const r = await handleInteraction(await db(), raw, { timestamp: request.headers.get('x-slack-request-timestamp'), signature: request.headers.get('x-slack-signature') }, locals.origin);
	return r.body ? json(r.body, { status: r.status }) : new Response(null, { status: r.status });
};
