<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Inbox, Search, LayoutGrid } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RequestRow from '#lib/components/RequestRow.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let q = $state('');
	$effect(() => {
		q = data.q;
	});

	const tabs = $derived([
		{ id: 'approve', label: 'To approve', count: data.counts.approve },
		{ id: 'fulfill', label: 'To set up', count: data.counts.fulfill },
		{ id: 'mine', label: 'Mine' },
		...(data.canSeeAll ? [{ id: 'all', label: page.data.viewer?.role === 'member' ? 'My resources' : 'Everyone' }] : [])
	]);
	const filterable = $derived(data.view === 'mine' || data.view === 'all');

	function nav(patch: Record<string, string>) {
		const u = new URL(page.url.href);
		for (const [k, v] of Object.entries(patch)) v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
		goto(u, { reset: false, replace: true });
	}
</script>

<svelte:head><title>Requests · ac·modern</title></svelte:head>

<PageHeader title="Requests" description="Access asked for, approved, set up and removed.">
	{#snippet actions()}
		<a href="/catalog" class="btn btn-primary"><LayoutGrid />Request access</a>
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	<div class="mb-4 flex flex-wrap items-center gap-3">
		<div class="flex rounded-xl border border-border bg-surface p-0.5">
			{#each tabs as t (t.id)}
				<button
					class="flex h-7 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors {data.view === t.id ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => nav({ view: t.id, q: '' })}
				>
					{t.label}
					{#if t.count}<span class="rounded-full bg-primary-soft px-1.5 font-mono text-[0.625rem] text-primary">{t.count}</span>{/if}
				</button>
			{/each}
		</div>
		{#if filterable}
			<select class="input h-8 w-auto text-xs" value={data.status} onchange={(e) => nav({ status: e.currentTarget.value })}>
				<option value="open">Open</option>
				<option value="closed">Closed</option>
				<option value="all">All</option>
			</select>
			<form class="relative w-full max-w-xs" onsubmit={(e) => (e.preventDefault(), nav({ q }))}>
				<Search class="pointer-events-none absolute top-2 left-3 size-4 text-muted-foreground" />
				<input class="input h-8 pl-9 text-xs" placeholder="Person, resource or #number" bind:value={q} />
			</form>
		{/if}
	</div>

	{#if data.requests.length}
		<div class="card divide-y divide-border overflow-hidden">
			{#each data.requests as r (r.id)}<RequestRow {r} />{/each}
		</div>
	{:else}
		<EmptyState
			icon={Inbox}
			title={data.view === 'approve' ? 'Nothing to approve' : data.view === 'fulfill' ? 'Nothing to set up' : 'No requests here'}
			body={data.view === 'approve'
				? 'When someone asks for access you approve, it lands here.'
				: data.view === 'fulfill'
					? 'Approved access that you need to grant or remove by hand lands here.'
					: 'Try another filter, or request something new.'}
		/>
	{/if}
</div>
