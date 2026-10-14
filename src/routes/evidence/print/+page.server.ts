import { db } from '#lib/server/db.ts';
import { ticket } from '#lib/server/evidence.ts';
import { record } from '#lib/server/events.ts';
import { adminCtx, badRequest } from '#lib/server/http.ts';
import { CAPACITY_LABEL } from '#lib/server/requests.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const c = adminCtx(locals);
	const numbers = [...new Set((url.searchParams.get('numbers') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
	if (!numbers.length) throw badRequest('Choose requests to print');
	if (numbers.length > 500) throw badRequest('Print at most 500 tickets at a time');
	const d = await db();
	const tickets = [];
	for (const n of numbers.sort((a, b) => a - b)) tickets.push(await ticket(d, c.org.id, n).catch(() => null));
	await record(d, {
		orgId: c.org.id,
		actorId: c.user.id,
		action: 'evidence.exported',
		subject: 'tickets',
		summary: `Generated evidence for ${numbers.length === 1 ? `request #${numbers[0]}` : `${numbers.length} requests`}`
	});
	return {
		tickets: tickets.filter((t) => t !== null),
		generatedBy: c.user.name || c.user.email,
		generatedAt: new Date().toISOString(),
		org: c.org.name,
		capacityLabel: CAPACITY_LABEL
	};
};
