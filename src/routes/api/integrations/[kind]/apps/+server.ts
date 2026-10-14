import { json } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import { discoverApps, importApps, SCAN_KINDS, type ScanKind } from '#lib/server/discovery.ts';
import { adminCtx, badRequest, body, handler, HttpError, notFound } from '#lib/server/http.ts';
import { ProviderError } from '#lib/server/idp/http.ts';
import { orgSettings } from '#lib/server/accounts.ts';

const kindOf = (k: string) => {
	if (!SCAN_KINDS.includes(k as ScanKind)) throw notFound();
	return k as ScanKind;
};
// The IdP's errors are about its settings, not ours: 422, so a proxy doesn't hide them.
const idpErrors = async <T>(fn: () => Promise<T>) => {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ProviderError || err instanceof TypeError) throw new HttpError(422, (err as Error).message);
		throw err;
	}
};

/** Scans the IdP for apps and who each one lets in. */
export const GET = handler(async (event) => {
	const c = adminCtx(event.locals);
	const kind = kindOf(event.params.kind!);
	const d = await db();
	return json({ apps: await idpErrors(() => discoverApps(d, c.org.id, kind)) });
});

/** Imports the chosen apps as resources, recording who already has them. */
export const POST = handler(async (event) => {
	const c = adminCtx(event.locals);
	const kind = kindOf(event.params.kind!);
	const b = await body(event);
	const refs = Array.isArray(b.refs) ? b.refs.filter((r): r is string => typeof r === 'string').slice(0, 500) : [];
	if (!refs.length) throw badRequest('Choose at least one app');
	const d = await db();
	const approval = (await orgSettings(d, c.org.id)).defaultApproval ?? 'approvers';
	return json(await idpErrors(() => importApps(d, c.org.id, c.user.id, kind, refs, { approval })));
});
