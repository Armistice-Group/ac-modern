import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { billingEnabled, handleStripeEvent, verifyStripeSignature } from '#lib/server/billing.ts';
import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db.ts';

/** Stripe events (signed). */
export const POST: RequestHandler = async ({ request }) => {
	if (!billingEnabled()) return json({ ok: false }, { status: 404 });
	const payload = await request.text();
	if (!verifyStripeSignature(payload, request.headers.get('stripe-signature'), config.billing!.webhookSecret)) return json({ error: 'bad signature' }, { status: 400 });
	try {
		await handleStripeEvent(await db(), JSON.parse(payload));
	} catch (err) {
		console.error('[ac-modern] Stripe webhook', err);
		// Stripe retries non-2xx answers.
		return json({ error: 'failed' }, { status: 500 });
	}
	return json({ received: true });
};
