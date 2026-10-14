import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb, setDb } from '../src/lib/server/db.ts';
import { config } from '../src/lib/server/config.ts';
import { addMember, createUser } from '../src/lib/server/accounts.ts';
import { setupOrg } from '../src/lib/server/auth.ts';
import { assertCanAddMembers, checkout, getBilling, handleStripeEvent, setStripeFetch, stripeForm, syncSeats, verifyStripeSignature } from '../src/lib/server/billing.ts';

process.env.ACM_SECRET_KEY = 'test-secret';

test('stripe form encoding', () => {
	assert.equal(decodeURIComponent(stripeForm({ a: 1, line_items: [{ price: 'p', quantity: 2 }], sub: { metadata: { org_id: 'o' } }, skip: undefined }).toString()), 'a=1&line_items[0][price]=p&line_items[0][quantity]=2&sub[metadata][org_id]=o');
});

test('cloud billing: free seats, checkout with trial, webhooks, seat sync, cancellation', async () => {
	const c = config as unknown as { mode: string; billing: unknown };
	const saved = { mode: c.mode, billing: c.billing };
	c.mode = 'cloud';
	c.billing = { secretKey: 'sk_test', webhookSecret: 'whsec', priceId: 'price_1', priceLabel: '$4', freeSeats: 3, trialDays: 14 };
	try {
		const db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
		setDb(db);
		const tag = Math.random().toString(36).slice(2, 7);
		const { user: owner, org } = await setupOrg({ orgName: 'Acme', email: `o-${tag}@acme.test`, name: 'O', password: 'password123' });
		for (const n of ['a', 'b']) {
			const u = await createUser(db, { email: `${n}-${tag}@acme.test`, name: n, passwordHash: null });
			await addMember(db, org.id, u.id, 'member');
		}
		assert.equal((await getBilling(db, org.id)).canGrow, false, '3 of 3 free seats');
		await assert.rejects(assertCanAddMembers(db, org.id), /free plan covers 3/);

		const calls: { path: string; body: string }[] = [];
		setStripeFetch(async (input, init) => {
			const path = new URL(String(input)).pathname;
			calls.push({ path, body: decodeURIComponent(String(init?.body ?? '')) });
			const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
			if (path === '/v1/customers') return json({ id: 'cus_1' });
			if (path === '/v1/checkout/sessions') return json({ url: 'https://checkout.stripe.test/s' });
			return json({});
		});
		assert.equal(await checkout(db, org, owner, 'https://acm.test'), 'https://checkout.stripe.test/s');
		const session = calls.find((x) => x.path === '/v1/checkout/sessions')!.body;
		assert.match(session, /line_items\[0\]\[quantity\]=3/);
		assert.match(session, /subscription_data\[trial_period_days\]=14/);
		assert.match(session, new RegExp(`client_reference_id=${org.id}`));

		// Signed webhook → trialing: people can be added.
		const sub = { id: 'sub_1', customer: 'cus_1', status: 'trialing', trial_end: 2_000_000_000, current_period_end: 2_000_000_000, cancel_at_period_end: false, metadata: { org_id: org.id }, items: { data: [{ id: 'si_1', quantity: 3 }] } };
		const payload = JSON.stringify({ type: 'customer.subscription.created', data: { object: sub } });
		const t = Math.floor(Date.now() / 1000);
		const header = `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${payload}`).digest('hex')}`;
		assert.equal(verifyStripeSignature(payload, header, 'whsec'), true);
		assert.equal(verifyStripeSignature(payload, header, 'other'), false);
		assert.equal(verifyStripeSignature(`${payload} `, header, 'whsec'), false);
		await handleStripeEvent(db, JSON.parse(payload));
		const b = await getBilling(db, org.id);
		assert.equal(b.status, 'trialing');
		assert.equal(b.canGrow, true);
		await assertCanAddMembers(db, org.id, 10);

		// A 4th person: seats follow.
		const d = await createUser(db, { email: `d-${tag}@acme.test`, name: 'd', passwordHash: null });
		await addMember(db, org.id, d.id, 'member');
		await syncSeats(db, org.id);
		const seatCall = calls.find((x) => x.path === '/v1/subscription_items/si_1');
		assert.match(seatCall!.body, /quantity=4/);
		assert.equal((await getBilling(db, org.id)).seats, 4);

		// Cancelled: back to the free limit, and no second trial.
		await handleStripeEvent(db, { type: 'customer.subscription.deleted', data: { object: { ...sub, status: 'canceled' } } });
		const after = await getBilling(db, org.id);
		assert.equal(after.canGrow, false);
		assert.equal(after.trialUsed, true);
		calls.length = 0;
		await checkout(db, org, owner, 'https://acm.test');
		assert.doesNotMatch(calls.find((x) => x.path === '/v1/checkout/sessions')!.body, /trial_period_days/);
	} finally {
		c.mode = saved.mode;
		c.billing = saved.billing;
	}
});
