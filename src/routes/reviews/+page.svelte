<script lang="ts">
	import { goto } from '$app/navigation';
	import { ClipboardCheck, Plus, LoaderCircle } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { date } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let creating = $state(false);
	let busy = $state(false);
	const quarter = () => {
		const d = new Date();
		return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()} access review`;
	};
	const inTwoWeeks = () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
	let form = $state({ name: '', dueAt: '', resourceIds: [] as string[] });

	function open() {
		form = { name: quarter(), dueAt: inTwoWeeks(), resourceIds: [] };
		creating = true;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api.post<{ id: string }>('/api/reviews', form);
			toast('success', 'Review started', 'Reviewers have been notified.');
			goto(`/reviews/${r.id}`);
		} catch (err) {
			toast('error', 'Couldn’t start the review', errorMessage(err));
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Reviews · ac·modern</title></svelte:head>

<PageHeader title="Access reviews" description="Every so often, resource owners confirm who should still have access. Anything revoked gets removed.">
	{#snippet actions()}
		{#if data.admin}<button class="btn btn-primary" onclick={open}><Plus />Start a review</button>{/if}
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	{#if data.reviews.length}
		<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{#each data.reviews as r (r.id)}
				{@const pct = r.total ? Math.round((r.decided / r.total) * 100) : 0}
				{@const overdue = r.status === 'open' && r.dueAt && Date.parse(r.dueAt) < Date.now()}
				<a href="/reviews/{r.id}" class="card block p-4 transition-colors hover:border-primary/40">
					<div class="flex items-start justify-between gap-2">
						<h3 class="text-[0.9375rem] font-semibold tracking-tight">{r.name}</h3>
						{#if r.status === 'closed'}<span class="badge">Closed</span>{:else if overdue}<span class="badge badge-danger">Overdue</span>{:else}<span class="badge badge-primary">Open</span>{/if}
					</div>
					<p class="mt-0.5 text-xs text-muted-foreground">{r.status === 'closed' ? `Closed ${date(r.closedAt)}` : r.dueAt ? `Due ${date(r.dueAt)}` : `Started ${date(r.createdAt)}`}</p>
					<div class="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary" style="width:{pct}%"></div></div>
					<div class="mt-2 flex justify-between font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
						<span>{r.decided}/{r.total} decided</span>
						<span>{r.revoked} revoked</span>
					</div>
					{#if data.assigned[r.id]}<p class="mt-3 text-xs font-medium text-primary">{data.assigned[r.id]} waiting on you →</p>{/if}
				</a>
			{/each}
		</div>
	{:else}
		<EmptyState
			icon={ClipboardCheck}
			title={data.admin ? 'No reviews yet' : 'Nothing to review'}
			body={data.admin ? 'A review asks each resource owner to keep or revoke every grant. Quarterly is typical, and auditors (SOC 2, ISO 27001) like to see it.' : 'When a review needs your input, it shows up here.'}
		>
			{#snippet action()}{#if data.admin}<button class="btn btn-primary" onclick={open}><Plus />Start a review</button>{/if}{/snippet}
		</EmptyState>
	{/if}
</div>

<Dialog bind:open={creating} title="Start an access review" description="Each grant goes to its resource’s owner (or first approver) to keep or revoke.">
	<form id="review-form" class="space-y-4" onsubmit={create}>
		<div class="grid grid-cols-[1fr_10rem] gap-3">
			<div>
				<label class="label" for="name">Name</label>
				<input id="name" class="input" bind:value={form.name} required />
			</div>
			<div>
				<label class="label" for="due">Due</label>
				<input id="due" class="input" type="date" bind:value={form.dueAt} />
			</div>
		</div>
		<fieldset>
			<legend class="label">Resources <span class="font-normal">(none ticked = all)</span></legend>
			<div class="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
				{#each data.resources as r (r.id)}
					<label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] hover:bg-accent/50">
						<input type="checkbox" class="accent-[var(--primary)]" value={r.id} bind:group={form.resourceIds} />
						<ResourceIcon name={r.name} color={r.color} size="size-5" text="text-[0.625rem]" />{r.name}
					</label>
				{/each}
			</div>
		</fieldset>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (creating = false)}>Cancel</button>
		<button class="btn btn-primary" form="review-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Start review</button>
	{/snippet}
</Dialog>
