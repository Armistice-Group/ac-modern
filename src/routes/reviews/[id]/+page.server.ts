import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { ctx, isAdmin } from '#lib/server/http.ts';
import { getReview, reviewItems } from '#lib/server/reviews.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const c = ctx(locals);
	const d = await db();
	const admin = isAdmin(c);
	const review = await getReview(d, c.org.id, params.id).catch(() => error(404, 'That review doesn’t exist'));
	const items = await reviewItems(d, c.org.id, review.id);
	const visible = admin ? items : items.filter((i) => i.reviewerId === c.user.id);
	if (!visible.length && !admin) error(404, 'That review doesn’t exist');
	return { review, items: visible, admin };
};
