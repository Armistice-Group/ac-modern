import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';
import { getReview, reviewCsv, reviewItems } from '#lib/server/reviews.ts';

/** The review's evidence as CSV. Exporting is logged, like other evidence. */
export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const review = await getReview(d, c.org.id, event.params.id!);
	const csv = reviewCsv(review, await reviewItems(d, c.org.id, review.id));
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'evidence.exported', subject: review.name, summary: `Exported evidence for review “${review.name}”`, data: { reviewId: review.id } });
	return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${review.name.replace(/\W+/g, '-').toLowerCase()}.csv"` } });
});
