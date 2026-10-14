import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { syncDirectory } from '#lib/server/directory.ts';
import { adminCtx, handler, HttpError } from '#lib/server/http.ts';
import { effects, flush } from '#lib/server/requests.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const fx = effects();
	try {
		const result = await syncDirectory(d, c.org.id, fx);
		await flush(d, c.org.id, fx, event.locals.origin);
		return json(result);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(422, (err as Error).message);
	}
});
