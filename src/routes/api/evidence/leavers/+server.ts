import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';
import { leavers, leaversCsv } from '#lib/server/leavers.ts';
import { period } from '#lib/server/period.ts';

/** Leavers in the period and how long their access took to remove. */
export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const { from, to, fromDate, toDate } = period(event.url);
	const d = await db();
	const r = await leavers(d, c.org.id, from, to);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'evidence.exported', subject: 'leavers', summary: `Exported leavers ${fromDate} to ${toDate} (${r.rows.length} people)` });
	return new Response(leaversCsv(r.rows, r.slaHours), {
		headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="leavers-${fromDate}-to-${toDate}.csv"` }
	});
});
