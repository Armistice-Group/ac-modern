import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler, str } from '#lib/server/http.ts';
import { verifyDomain } from '#lib/server/sso.ts';

export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const domain = str(await body(event), 'domain', { required: true, max: 200 });
	const d = await db();
	await verifyDomain(d, c.org.id, domain);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: domain, summary: `Verified email domain ${domain}` });
	return json({ ok: true });
});
