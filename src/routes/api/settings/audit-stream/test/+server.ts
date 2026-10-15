import { json } from '@sveltejs/kit';
import { testStream } from '#lib/server/audit.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, handler, HttpError } from '#lib/server/http.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	try {
		await testStream(await db(), c.org.id);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(422, (err as Error).message);
	}
	return json({ ok: true });
});
