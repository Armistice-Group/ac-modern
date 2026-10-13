import { json } from '@sveltejs/kit';
import { endSession } from '#lib/server/auth.ts';
import { handler } from '#lib/server/http.ts';

export const POST = handler(async ({ cookies }) => {
	await endSession(cookies);
	return json({ ok: true });
});
