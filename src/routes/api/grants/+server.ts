import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { recordGrant } from '#lib/server/grants.ts';
import { actor, adminCtx, body, handler, ids, str } from '#lib/server/http.ts';

/** Records access people already have. Accepts several people at once. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const userIds = ids(b, 'userIds');
	const created: string[] = [];
	const skipped: string[] = [];
	for (const userId of userIds) {
		try {
			created.push(
				await recordGrant(d, actor(c), {
					userId,
					resourceId: str(b, 'resourceId', { required: true }),
					roleId: str(b, 'roleId', { required: true }),
					expiresAt: str(b, 'expiresAt') || null,
					note: str(b, 'note', { max: 500 }),
					source: 'import'
				})
			);
		} catch (err) {
			if (userIds.length === 1) throw err;
			skipped.push((err as Error).message);
		}
	}
	return json({ created: created.length, skipped });
});
