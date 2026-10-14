<script lang="ts">
	import { page } from '$app/state';
	import { CreditCard, LoaderCircle, Sparkles, CircleAlert } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { date } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let busy = $state(false);
	const b = $derived(data.billing);
	const LABEL: Record<string, string> = { none: 'Free', trialing: 'Trial', active: 'Team', past_due: 'Payment overdue', unpaid: 'Unpaid', canceled: 'Cancelled', incomplete: 'Incomplete', incomplete_expired: 'Expired', paused: 'Paused' };
	$effect(() => {
		if (page.url.searchParams.get('checkout') === 'done') toast('success', 'Thanks! Your plan is active', 'It can take a few seconds to show here.');
	});

	async function go(path: string) {
		busy = true;
		try {
			location.href = (await api.post<{ url: string }>(path, {})).url;
		} catch (err) {
			toast('error', 'Couldn’t open billing', errorMessage(err));
			busy = false;
		}
	}
</script>

<svelte:head><title>Billing · ac·modern</title></svelte:head>

<div class="max-w-3xl space-y-6 px-8 pb-10">
	{#if !data.enabled}
		<section class="card p-5 text-[0.8125rem] text-muted-foreground">Billing isn’t set up on this server, so every feature is free.</section>
	{:else}
		{#if b.status === 'past_due' || b.status === 'unpaid'}
			<section class="card flex items-start gap-3 border-danger/40 p-4 text-[0.8125rem]">
				<CircleAlert class="mt-0.5 size-4 text-danger" />
				<p>The last payment didn’t go through. Update your card in the billing portal; access requests and approvals keep working meanwhile.</p>
			</section>
		{/if}
		<section class="card p-5">
			<div class="flex flex-wrap items-start justify-between gap-4">
				<div>
					<p class="text-xs text-muted-foreground">Plan</p>
					<p class="mt-0.5 text-xl font-semibold tracking-tight">{LABEL[b.status] ?? b.status}</p>
					<p class="mt-1 text-xs text-muted-foreground">
						{#if b.status === 'trialing' && b.trialEnd}Trial ends {date(b.trialEnd)}.
						{:else if b.paid && b.currentPeriodEnd}{b.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {date(b.currentPeriodEnd)}.
						{:else}Free for up to {b.freeSeats} people.{/if}
					</p>
				</div>
				<div class="text-right">
					<p class="text-xs text-muted-foreground">People</p>
					<p class="mt-0.5 font-mono text-xl font-semibold tabular-nums">{b.used}{#if !b.paid}<span class="text-muted-foreground">/{b.freeSeats}</span>{/if}</p>
					{#if b.paid}<p class="mt-1 text-xs text-muted-foreground">Billed for {b.seats}; updates automatically</p>{/if}
				</div>
			</div>
			{#if !b.paid}
				<div class="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full {b.canGrow ? 'bg-primary' : 'bg-danger'}" style="width:{Math.min(100, (b.used / b.freeSeats) * 100)}%"></div></div>
				{#if !b.canGrow}<p class="mt-2 text-xs text-danger">You’ve used every free seat: new invites, SSO sign-ups and directory additions are paused until you upgrade. Everything else keeps working.</p>{/if}
			{/if}
			<div class="mt-5 flex flex-wrap gap-2">
				{#if !b.paid}
					<button class="btn btn-primary" disabled={busy} onclick={() => go('/api/billing/checkout')}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<Sparkles />{/if}Upgrade to Team</button>
					<span class="self-center text-xs text-muted-foreground">{data.priceLabel}{!b.trialUsed && data.trialDays ? `, ${data.trialDays}-day free trial` : ''}</span>
				{/if}
				{#if b.customerId}<button class="btn btn-secondary" disabled={busy} onclick={() => go('/api/billing/portal')}><CreditCard />Manage billing</button>{/if}
			</div>
		</section>
		<section class="card p-5 text-xs text-muted-foreground">
			<p>You pay for active people: offboarded and deactivated people don’t count. Seats are adjusted automatically (prorated) as your team changes. Invoices, cards and cancellation are in the billing portal.</p>
		</section>
	{/if}
</div>
