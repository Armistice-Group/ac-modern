import { json } from '@sveltejs/kit';
import { orgSettings } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, badRequest, handler, HttpError } from '#lib/server/http.ts';
import { postSlack } from '#lib/server/notify.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const { slackWebhook } = await orgSettings(await db(), c.org.id);
	if (!slackWebhook) throw badRequest('Save a Slack webhook URL first');
	try {
		await postSlack(slackWebhook, `:wave: ac·modern is connected. Access requests for *${c.org.name}* will show up here.`);
	} catch (err) {
		throw new HttpError(502, (err as Error).message);
	}
	return json({ ok: true });
});
