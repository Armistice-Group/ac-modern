import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db.ts';
import { handleEvent } from '#lib/server/slack-commands.ts';

/** Slack's Events API: direct messages to the app (replies to approval messages). */
export const POST: RequestHandler = async ({ request, locals }) => {
	const raw = await request.text();
	const h = request.headers;
	const r = await handleEvent(await db(), raw, { timestamp: h.get('x-slack-request-timestamp'), signature: h.get('x-slack-signature'), retry: h.get('x-slack-retry-num') }, locals.origin);
	if (r.work) void r.work;
	return r.body ? json(r.body, { status: r.status }) : new Response(null, { status: r.status });
};
