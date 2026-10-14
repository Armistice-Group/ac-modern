import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, body, handler } from '#lib/server/http.ts';
import { getResource, parseResourceInput, saveResource } from '#lib/server/resources.ts';

export const PUT = handler(async (event) => {
	const c = adminCtx(event.locals);
	const input = parseResourceInput(await body(event));
	const d = await db();
	const before = await getResource(d, c.org.id, event.params.id!);
	await saveResource(d, c.org.id, before.id, input);
	const changed: string[] = (['name', 'approval', 'fulfillment', 'maxDays', 'defaultDays', 'requestable', 'ownerId'] as const).filter((k) => before[k] !== input[k]);
	const privBefore = before.roles.filter((r) => r.privileged).map((r) => r.name).sort().join(', ');
	const privAfter = input.roles.filter((r) => r.privileged).map((r) => r.name).sort().join(', ');
	if (privBefore !== privAfter) changed.push('privileged');
	const value = (k: string, side: 'from' | 'to') => (k === 'privileged' ? (side === 'from' ? privBefore : privAfter) : (side === 'from' ? before : input)[k as 'name']);
	await record(d, {
		orgId: c.org.id,
		actorId: c.user.id,
		action: 'resource.updated',
		subject: input.name,
		summary: `Updated resource ${input.name}${changed.length ? ` (${changed.join(', ')})` : ''}`,
		data: Object.fromEntries(changed.map((k) => [k, { from: value(k, 'from'), to: value(k, 'to') }]))
	});
	return json({ id: before.id });
});
