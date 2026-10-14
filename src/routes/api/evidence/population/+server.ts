import { db } from '#lib/server/db.ts';
import { evidenceRows, populationCsv } from '#lib/server/evidence.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';
import { period } from '#lib/server/period.ts';
import { CATEGORY, CAPACITY } from '#lib/format.ts';
import type { RequestCategory } from '#lib/types.ts';

/** The population CSV auditors sample from. */
export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const { from, to, fromDate, toDate } = period(event.url);
	const categories = (event.url.searchParams.get('types') ?? '').split(',').filter(Boolean) as RequestCategory[];
	const d = await db();
	const rows = await evidenceRows(d, c.org.id, {
		from,
		to,
		categories,
		privileged: event.url.searchParams.get('privileged') === '1',
		exceptions: event.url.searchParams.get('exceptions') === '1'
	});
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'evidence.exported', subject: 'population', summary: `Exported access request population ${fromDate} to ${toDate} (${rows.length} requests)` });
	return new Response(populationCsv(rows, (x) => CAPACITY[x], (x) => CATEGORY[x]), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="access-requests-${fromDate}-to-${toDate}.csv"`
		}
	});
});
