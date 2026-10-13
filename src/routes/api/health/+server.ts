import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';

export const GET = async () => {
	try {
		const d = await db();
		await d.get('SELECT 1 AS ok');
		return json({ ok: true, version: __APP_VERSION__, database: d.kind });
	} catch (err) {
		return json({ ok: false, message: (err as Error).message }, { status: 503 });
	}
};
