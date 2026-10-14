import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { disconnect, saveSource } from '#lib/server/directory.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler, oneOf } from '#lib/server/http.ts';

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const kind = oneOf(b, 'kind', ['scim', 'google', 'okta', 'entra'] as const);
	const raw = (b.config ?? {}) as Record<string, unknown>;
	const config = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v).slice(0, 20_000)]));
	const d = await db();
	await saveSource(d, c.org.id, { kind, config, onDeactivate: oneOf(b, 'onDeactivate', ['offboard', 'deactivate'] as const, 'offboard'), createMembers: b.createMembers !== false });
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: `Connected directory sync (${kind})` });
	return json({ ok: true });
});

export const DELETE = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	await disconnect(d, c.org.id);
	await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'settings.updated', subject: c.org.name, summary: 'Disconnected directory sync' });
	return json({ ok: true });
});
