import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, badRequest, body, handler, str } from '#lib/server/http.ts';
import { deleteSso, saveSso, ssoSettings } from '#lib/server/sso.ts';

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	if ((await ssoSettings(d, c.org.id))?.source === 'env') throw badRequest('Single sign-on is set by ACM_OIDC_* environment variables');
	await saveSso(d, c.org.id, {
		issuer: str(b, 'issuer', { required: true, max: 500 }),
		clientId: str(b, 'clientId', { required: true, max: 300 }),
		clientSecret: typeof b.clientSecret === 'string' ? b.clientSecret : undefined,
		name: str(b, 'name', { max: 40 }),
		scopes: str(b, 'scopes', { max: 300 }),
		autoCreate: b.autoCreate !== false,
		required: b.required === true
	});
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: `Changed single sign-on${b.required === true ? ' (required)' : ''}` });
	return json({ ok: true });
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	await deleteSso(d, c.org.id);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: 'Turned off single sign-on' });
	return json({ ok: true });
});
