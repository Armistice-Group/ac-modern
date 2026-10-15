import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';
import { getReconciliation, reconciliationCsv, reconciliationItems } from '#lib/server/reconcile.ts';

/** A reconciliation as CSV evidence. Exporting is logged, like other evidence. */
export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const run = await getReconciliation(d, c.org.id, event.params.id!);
	const csv = reconciliationCsv(run, await reconciliationItems(d, c.org.id, run.id));
	const day = run.createdAt.slice(0, 10);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'evidence.exported', subject: run.resource.name, summary: `Exported the ${run.resource.name} reconciliation of ${day}`, data: { reconciliationId: run.id } });
	const name = `${run.resource.name.replace(/\W+/g, '-').toLowerCase()}-reconciliation-${day}.csv`;
	return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` } });
});
