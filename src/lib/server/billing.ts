import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, isCloud } from './config.ts';
import type { Db } from './db.ts';
import { record } from './events.ts';
import { HttpError } from './http.ts';

/**
 * Cloud billing with Stripe: per-seat subscriptions (seats = active members), a free tier,
 * a trial, Checkout and the Customer Portal. Self-hosted installs, and cloud installs
 * without a Stripe key, have no billing at all.
 *
 * Only *adding* people is ever blocked by billing. Approvals, removals and offboarding
 * always work: holding security operations hostage to an invoice would be the wrong way round.
 */

export const billingEnabled = () => isCloud() && !!config.billing;

export type BillingStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';

export interface Billing {
	status: BillingStatus;
	seats: number;
	used: number;
	freeSeats: number;
	/** Can people be added right now? */
	canGrow: boolean;
	paid: boolean;
	trialEnd: string | null;
	currentPeriodEnd: string | null;
	cancelAtPeriodEnd: boolean;
	trialUsed: boolean;
	customerId: string | null;
	subscriptionId: string | null;
	subscriptionItemId: string | null;
}

/** Statuses where the subscription covers the seats (past_due gets a grace period from Stripe's retries). */
const PAID: BillingStatus[] = ['trialing', 'active', 'past_due'];

let stripeFetch: typeof fetch = (...a) => fetch(...a);
export function setStripeFetch(f: typeof fetch) {
	stripeFetch = f;
}

/** Stripe's form encoding: { a: { b: [ { c: 1 } ] } } → a[b][0][c]=1. */
export function stripeForm(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		const key = prefix ? `${prefix}[${k}]` : k;
		if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? stripeForm(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
		else if (typeof v === 'object') stripeForm(v as Record<string, unknown>, key, out);
		else out.append(key, String(v));
	}
	return out;
}

export async function stripe<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<T> {
	const res = await stripeFetch(`https://api.stripe.com/v1${path}`, {
		method,
		headers: { authorization: `Bearer ${config.billing!.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20' },
		body: body ? stripeForm(body).toString() : undefined,
		signal: AbortSignal.timeout(20_000)
	});
	const data = (await res.json().catch(() => ({}))) as { error?: { message: string } } & T;
	if (!res.ok) throw new HttpError(422, `Stripe: ${data.error?.message ?? res.status}`);
	return data;
}

async function activeMembers(db: Db, orgId: string) {
	return (await db.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM members WHERE org_id = ? AND status = 'active'", [orgId]))!.n;
}

export async function getBilling(db: Db, orgId: string): Promise<Billing> {
	const r = await db.get<{ customer_id: string | null; subscription_id: string | null; subscription_item_id: string | null; status: BillingStatus; seats: number; trial_used: number; trial_end: string | null; current_period_end: string | null; cancel_at_period_end: number }>(
		'SELECT * FROM org_billing WHERE org_id = ?',
		[orgId]
	);
	const used = await activeMembers(db, orgId);
	const freeSeats = config.billing?.freeSeats ?? Infinity;
	const status = r?.status ?? 'none';
	const paid = PAID.includes(status);
	return {
		status,
		seats: Number(r?.seats ?? 0),
		used,
		freeSeats,
		paid,
		canGrow: !billingEnabled() || paid || used < freeSeats,
		trialEnd: r?.trial_end ?? null,
		currentPeriodEnd: r?.current_period_end ?? null,
		cancelAtPeriodEnd: !!r?.cancel_at_period_end,
		trialUsed: !!r?.trial_used,
		customerId: r?.customer_id ?? null,
		subscriptionId: r?.subscription_id ?? null,
		subscriptionItemId: r?.subscription_item_id ?? null
	};
}

/** Throws 402 when billing says no more people can be added. */
export async function assertCanAddMembers(db: Db, orgId: string, adding = 1) {
	if (!billingEnabled()) return;
	const b = await getBilling(db, orgId);
	if (b.paid) return;
	if (b.used + adding > b.freeSeats)
		throw new HttpError(402, `The free plan covers ${b.freeSeats} people and you have ${b.used}. Upgrade under Settings → Billing to add more.`, { upgrade: '/settings/billing' });
}

async function upsert(db: Db, orgId: string, patch: Record<string, unknown>) {
	const now = new Date().toISOString();
	await db.run('INSERT INTO org_billing (org_id, updated_at) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING', [orgId, now]);
	const keys = Object.keys(patch);
	if (keys.length) await db.run(`UPDATE org_billing SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE org_id = ?`, [...(Object.values(patch) as never[]), now, orgId]);
}

/** Starts Checkout for the per-seat plan; the trial applies the first time only. */
export async function checkout(db: Db, org: { id: string; name: string }, admin: { email: string }, origin: string): Promise<string> {
	if (!billingEnabled() || !config.billing!.priceId) throw new HttpError(400, 'Billing isn’t set up on this server');
	const b = await getBilling(db, org.id);
	if (b.paid && b.subscriptionId) throw new HttpError(409, 'You already have a plan; manage it in the billing portal');
	let customer = b.customerId;
	if (!customer) {
		customer = (await stripe<{ id: string }>('POST', '/customers', { name: org.name, email: admin.email, metadata: { org_id: org.id } })).id;
		await upsert(db, org.id, { customer_id: customer });
	}
	const session = await stripe<{ url: string }>('POST', '/checkout/sessions', {
		mode: 'subscription',
		customer,
		client_reference_id: org.id,
		line_items: [{ price: config.billing!.priceId, quantity: Math.max(b.used, 1) }],
		subscription_data: { metadata: { org_id: org.id }, ...(b.trialUsed || !config.billing!.trialDays ? {} : { trial_period_days: config.billing!.trialDays }) },
		allow_promotion_codes: true,
		success_url: `${origin}/settings/billing?checkout=done`,
		cancel_url: `${origin}/settings/billing`
	});
	return session.url;
}

export async function portal(db: Db, orgId: string, origin: string): Promise<string> {
	const b = await getBilling(db, orgId);
	if (!b.customerId) throw new HttpError(400, 'No billing account yet');
	return (await stripe<{ url: string }>('POST', '/billing_portal/sessions', { customer: b.customerId, return_url: `${origin}/settings/billing` })).url;
}

/** Stripe's webhook signature: header "t=…,v1=…", HMAC-SHA256 of "<t>.<payload>", within five minutes. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, now = Date.now()): boolean {
	if (!header || !secret) return false;
	const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
	const t = Number(parts.t);
	if (!t || Math.abs(now / 1000 - t) > 300) return false;
	const want = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
	return header
		.split(',')
		.filter((p) => p.startsWith('v1='))
		.some((p) => {
			const got = p.slice(3);
			return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
		});
}

interface StripeSubscription {
	id: string;
	customer: string;
	status: BillingStatus;
	trial_end: number | null;
	current_period_end: number;
	cancel_at_period_end: boolean;
	metadata?: { org_id?: string };
	items: { data: { id: string; quantity: number }[] };
}

const iso = (s: number | null) => (s ? new Date(s * 1000).toISOString() : null);

async function orgForCustomer(db: Db, customer: string, metaOrg?: string) {
	if (metaOrg && (await db.get('SELECT 1 FROM orgs WHERE id = ?', [metaOrg]))) return metaOrg;
	return (await db.get<{ org_id: string }>('SELECT org_id FROM org_billing WHERE customer_id = ?', [customer]))?.org_id ?? null;
}

async function applySubscription(db: Db, sub: StripeSubscription) {
	const orgId = await orgForCustomer(db, sub.customer, sub.metadata?.org_id);
	if (!orgId) return;
	const before = await getBilling(db, orgId);
	const item = sub.items.data[0];
	await upsert(db, orgId, {
		customer_id: sub.customer,
		subscription_id: sub.status === 'canceled' ? null : sub.id,
		subscription_item_id: sub.status === 'canceled' ? null : (item?.id ?? null),
		status: sub.status === 'canceled' ? 'canceled' : sub.status,
		seats: item?.quantity ?? 0,
		trial_used: before.trialUsed || !!sub.trial_end ? 1 : 0,
		trial_end: iso(sub.trial_end),
		current_period_end: iso(sub.current_period_end),
		cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0
	});
	if (before.status !== sub.status) await record(db, { orgId, actorId: null, action: 'billing.updated', summary: `Subscription ${sub.status === 'canceled' ? 'ended' : `is ${sub.status.replace('_', ' ')}`}` });
}

/** Handles a verified Stripe event. */
export async function handleStripeEvent(db: Db, event: { type: string; data: { object: Record<string, unknown> } }) {
	const o = event.data.object;
	switch (event.type) {
		case 'checkout.session.completed': {
			if (o.client_reference_id && o.customer) await upsert(db, String(o.client_reference_id), { customer_id: String(o.customer) });
			if (o.subscription) await applySubscription(db, await stripe<StripeSubscription>('GET', `/subscriptions/${o.subscription}`));
			break;
		}
		case 'customer.subscription.created':
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted':
		case 'customer.subscription.paused':
		case 'customer.subscription.resumed':
			await applySubscription(db, o as unknown as StripeSubscription);
			break;
	}
}

/** Keeps the subscription's quantity equal to active members (run by the jobs loop). */
export async function syncSeats(db: Db, orgId: string) {
	if (!billingEnabled()) return;
	const b = await getBilling(db, orgId);
	if (!b.paid || !b.subscriptionItemId) return;
	const want = Math.max(b.used, 1);
	if (want === b.seats) return;
	await stripe('POST', `/subscription_items/${b.subscriptionItemId}`, { quantity: want, proration_behavior: 'create_prorations' });
	await upsert(db, orgId, { seats: want });
	await record(db, { orgId, actorId: null, action: 'billing.seats', summary: `Seats updated from ${b.seats} to ${want}` });
}
