import { json } from '@sveltejs/kit';
import { getPerson } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx, forbidden, handler } from '#lib/server/http.ts';
import { resetMfa } from '#lib/server/mfa.ts';

/** Clears someone's two-step setup when they've lost their phone and recovery codes. Owners only for owners. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const d = await db();
	const p = await getPerson(d, c.org.id, event.params.id!);
	if (p.id === c.user.id) throw forbidden('Use a recovery code, or ask another admin');
	if (p.role === 'owner' && c.role !== 'owner') throw forbidden('Only owners can reset an owner’s two-step verification');
	await resetMfa(d, c.org.id, c.user.id, p.id);
	return json({ ok: true });
});
