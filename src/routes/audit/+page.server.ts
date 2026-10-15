import { getStream, listAnchors } from '#lib/server/audit.ts';
import { db } from '#lib/server/db.ts';
import { listEvents } from '#lib/server/events.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const c = adminCtx(locals);
	const q = url.searchParams.get('q') ?? '';
	const before = url.searchParams.get('before') ?? undefined;
	const d = await db();
	const events = await listEvents(d, c.org.id, { q, before, limit: 100 });
	const anchors = await listAnchors(d, c.org.id);
	const lastCheck = await d.get<{ at: string; data: string }>("SELECT at, data FROM events WHERE org_id = ? AND action = 'audit.verified' ORDER BY at DESC, id DESC LIMIT 1", [c.org.id]);
	return {
		events,
		q,
		more: events.length === 100 ? events.at(-1)!.at : null,
		integrity: {
			days: anchors.length,
			firstDay: anchors[0]?.day ?? null,
			lastSealed: anchors.at(-1)?.day ?? null,
			lastCheck: lastCheck ? { at: lastCheck.at, ok: !!JSON.parse(lastCheck.data || '{}').ok } : null
		},
		stream: await getStream(d, c.org.id)
	};
};
