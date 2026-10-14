import { redirect } from '@sveltejs/kit';
import { billingEnabled, getBilling } from '#lib/server/billing.ts';
import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db.ts';
import { adminCtx } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const c = adminCtx(locals);
	if (config.mode !== 'cloud') redirect(303, '/settings');
	return { enabled: billingEnabled(), billing: await getBilling(await db(), c.org.id), priceLabel: config.billing?.priceLabel ?? '', trialDays: config.billing?.trialDays ?? 0 };
};
