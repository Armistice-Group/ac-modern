import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { deliver } from '#lib/server/notify.ts';
import { actor, body, ctx, forbidden, handler, notFound, str } from '#lib/server/http.ts';
import { abilities, addComment, cancel, complete, decide, effects, flush, getRequest, runWebhook } from '#lib/server/requests.ts';
import { getResource } from '#lib/server/resources.ts';

export const POST = handler(async (event) => {
	const c = ctx(event.locals);
	const b = await body(event);
	const d = await db();
	const a = actor(c);
	const id = event.params.id!;
	const fx = effects();
	const note = str(b, 'comment', { max: 4000 });
	switch (event.params.action) {
		case 'approve':
			await decide(d, a, id, 'approved', note, fx);
			break;
		case 'deny':
			await decide(d, a, id, 'denied', note, fx);
			break;
		case 'complete':
			await complete(d, a, id, note, fx);
			break;
		case 'cancel':
			await cancel(d, a, id, note);
			break;
		case 'comment':
			await deliver([await addComment(d, a, id, note)], event.locals.origin);
			break;
		case 'retry': {
			const req = await getRequest(d, c.org.id, { id });
			const can = await abilities(d, a, req, await getResource(d, c.org.id, req.resource.id));
			if (!can.fulfill) throw forbidden();
			await runWebhook(d, c.org.id, id, event.locals.origin);
			break;
		}
		default:
			throw notFound('Unknown action');
	}
	await flush(d, c.org.id, fx, event.locals.origin);
	return json(await getRequest(d, c.org.id, { id }));
});
