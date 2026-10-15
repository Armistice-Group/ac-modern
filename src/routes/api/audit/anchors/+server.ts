import { json } from '@sveltejs/kit';
import { listAnchors } from '#lib/server/audit.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, handler } from '#lib/server/http.ts';

/** The daily digests, to keep a copy outside ac·modern (that's what makes a rewrite detectable). */
export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const anchors = await listAnchors(await db(), c.org.id);
	return json(
		{ org: { id: c.org.id, name: c.org.name }, algorithm: 'sha256(prev_digest + JSON of [id, at, actor_id, action, request_id, subject, summary, data] per event, ordered by at, id)', anchors },
		{ headers: event.url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="audit-anchors-${new Date().toISOString().slice(0, 10)}.json"` } : {} }
	);
});
