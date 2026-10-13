import { db } from '#lib/server/db.ts';
import { listEvents } from '#lib/server/events.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const c = adminCtx(locals);
	const q = url.searchParams.get('q') ?? '';
	const before = url.searchParams.get('before') ?? undefined;
	const events = await listEvents(await db(), c.org.id, { q, before, limit: 100 });
	return { events, q, more: events.length === 100 ? events.at(-1)!.at : null };
};
