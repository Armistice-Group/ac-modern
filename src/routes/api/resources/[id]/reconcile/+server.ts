import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { actor, adminCtx, body, handler, HttpError, oneOf, str } from '#lib/server/http.ts';
import { ProviderError } from '#lib/server/idp/http.ts';
import { parseAccounts, pullAccounts, runReconciliation } from '#lib/server/reconcile.ts';
import { getResource } from '#lib/server/resources.ts';

/** Compares the system's user list (an uploaded export, or pulled from its integration) with recorded access. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const b = await body(event);
	const d = await db();
	const resource = await getResource(d, c.org.id, event.params.id!);
	const source = oneOf(b, 'source', ['csv', 'idp'] as const);
	let accounts;
	try {
		accounts = source === 'csv' ? parseAccounts(str(b, 'csv', { required: true, max: 5_000_000 })).accounts : await pullAccounts(d, c.org.id, resource);
	} catch (err) {
		if (err instanceof ProviderError || err instanceof TypeError) throw new HttpError(422, err.message);
		throw err;
	}
	const id = await runReconciliation(d, actor(c), resource.id, { source, filename: source === 'csv' ? str(b, 'filename', { max: 200 }) : '', accounts });
	return json({ id });
});
