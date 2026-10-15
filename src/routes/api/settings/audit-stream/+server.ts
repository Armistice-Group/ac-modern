import { json } from '@sveltejs/kit';
import { deleteStream, getStream, saveStream } from '#lib/server/audit.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler, str } from '#lib/server/http.ts';

export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	return json(await getStream(await db(), c.org.id));
});

/** Sets the URL; a new stream (or `rotate`) gets a new signing secret, shown once. */
export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const url = str(b, 'url', { required: true, max: 500 });
	const r = await saveStream(d, c.org.id, url, b.rotate === true);
	await record(d, {
		orgId: c.org.id,
		actorId: c.user.id,
		action: 'settings.updated',
		subject: 'Audit stream',
		summary: `${r.secret ? (b.rotate === true ? 'Rotated the signing secret for' : 'Started') : 'Changed'} streaming the audit log to ${new URL(url).host}`
	});
	return json(r);
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	await deleteStream(d, c.org.id);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: 'Audit stream', summary: 'Stopped streaming the audit log' });
	return json({ ok: true });
});
