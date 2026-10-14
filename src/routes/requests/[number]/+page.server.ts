import { error } from '@sveltejs/kit';
import { listPeople } from '#lib/server/accounts.ts';
import { db } from '#lib/server/db.ts';
import { requestTimeline } from '#lib/server/events.ts';
import { ticket } from '#lib/server/evidence.ts';
import { actor, ctx, isAdmin } from '#lib/server/http.ts';
import { abilities, getRequest, stepsFor } from '#lib/server/requests.ts';
import { getResource } from '#lib/server/resources.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const c = ctx(locals);
	const d = await db();
	const number = Number(params.number);
	if (!Number.isInteger(number)) error(404, 'Not found');
	const req = await getRequest(d, c.org.id, { number }).catch(() => error(404, 'That request doesn’t exist'));
	const resource = await getResource(d, c.org.id, req.resource.id);
	const can = await abilities(d, actor(c), req, resource);
	if (!can.view) error(404, 'That request doesn’t exist');
	const people = await listPeople(d, c.org.id, { includeDeactivated: true });
	const pick = (ids: string[]) => people.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, name: p.name, email: p.email }));
	const grant = req.grantId
		? await d.get<{ status: string; expires_at: string | null }>('SELECT status, expires_at FROM grants WHERE id = ?', [req.grantId])
		: undefined;
	return {
		req,
		resource: { id: resource.id, name: resource.name, url: resource.url, color: resource.color, approval: resource.approval, fulfillment: resource.fulfillment, webhookUrl: resource.webhookUrl },
		steps: stepsFor(req.policy),
		evidence: await ticket(d, c.org.id, req.number).then((t) => ({ approvals: t.approvals, flags: t.flags, snapshot: t.snapshot })),
		admin: isAdmin(c),
		can: { approve: can.approve, fulfill: can.fulfill, cancel: can.cancel, comment: can.comment },
		approvers: pick(can.approverIds),
		approverVia: can.approverVia,
		fulfillers: pick(can.fulfillerIds),
		grant: grant ? { status: grant.status, expiresAt: grant.expires_at } : null,
		timeline: await requestTimeline(d, c.org.id, req.id)
	};
};
