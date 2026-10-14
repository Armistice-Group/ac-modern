import { json } from '@sveltejs/kit';
import { countOwners, getPerson, updateMember } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, badRequest, body, forbidden, handler, oneOf, str } from '#lib/server/http.ts';
import { displayName } from '#lib/format.ts';

export const PATCH = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const id = event.params.id!;
	const person = await getPerson(d, c.org.id, id);
	const patch: Parameters<typeof updateMember>[3] = {};
	if (b.role !== undefined) {
		const role = oneOf(b, 'role', ['owner', 'admin', 'member'] as const);
		if ((role === 'owner' || person.role === 'owner') && c.role !== 'owner') throw forbidden('Only owners can change who is an owner');
		if (person.role === 'owner' && role !== 'owner' && (await countOwners(d, c.org.id)) <= 1) throw badRequest('Make someone else an owner first');
		patch.role = role;
	}
	if (b.title !== undefined) patch.title = str(b, 'title', { max: 120 });
	if (b.managerId !== undefined) {
		const m = str(b, 'managerId') || null;
		if (m === id) throw badRequest('Someone can’t be their own manager');
		if (m) await getPerson(d, c.org.id, m);
		patch.managerId = m;
	}
	await updateMember(d, c.org.id, id, patch);
	const changes: string[] = [];
	if (patch.role && patch.role !== person.role) changes.push(`role ${person.role} → ${patch.role}`);
	if (patch.title !== undefined && patch.title !== person.title) changes.push(`title “${patch.title}”`);
	if (patch.managerId !== undefined && patch.managerId !== person.managerId) changes.push('manager');
	if (changes.length) {
		const data: Record<string, unknown> = { ...patch };
		if (patch.role && patch.role !== person.role) data.role = { from: person.role, to: patch.role };
		else delete data.role;
		await record(d, { orgId: c.org.id, actorId: c.user.id, action: 'member.updated', subject: displayName(person), summary: `Updated ${displayName(person)}: ${changes.join(', ')}`, data });
	}
	return json(await getPerson(d, c.org.id, id));
});
