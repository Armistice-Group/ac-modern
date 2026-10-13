import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, adminCtx, handler } from '#lib/server/http.ts';
import { closeReview } from '#lib/server/reviews.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	await closeReview(await db(), actor(c), event.params.id!);
	return json({ ok: true });
});
