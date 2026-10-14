import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler, HttpError, str } from '#lib/server/http.ts';
import { connectSlack, disconnectSlack, manifest } from '#lib/server/slack.ts';

export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	return json(manifest(c.org.name, `${event.locals.origin}/api/slack/interactions`));
});

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	try {
		const r = await connectSlack(d, c.org.id, { botToken: str(b, 'botToken', { required: true, max: 300 }), signingSecret: str(b, 'signingSecret', { required: true, max: 200 }) });
		await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: 'Slack', summary: `Connected the Slack app (${r.team})` });
		return json(r);
	} catch (err) {
		throw new HttpError(422, (err as Error).message);
	}
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	await disconnectSlack(d, c.org.id);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: 'Slack', summary: 'Disconnected the Slack app' });
	return json({ ok: true });
});
