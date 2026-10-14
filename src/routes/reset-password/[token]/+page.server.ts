import { db } from '#lib/server/db.ts';
import { resetFor } from '#lib/server/passwords.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const r = await resetFor(await db(), params.token);
	return { email: r?.email ?? null };
};
