import { json } from '@sveltejs/kit';
import { getPerson, updateMember } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, handler } from '#lib/server/http.ts';
import { displayName } from '#lib/format.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const p = await getPerson(d, c.org.id, event.params.id!);
	await updateMember(d, c.org.id, p.id, { status: 'active' });
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'member.reactivated', subject: displayName(p), summary: `Reactivated ${displayName(p)}` });
	return json({ ok: true });
});
