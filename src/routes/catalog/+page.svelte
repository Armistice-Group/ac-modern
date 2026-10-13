<script lang="ts">
	import { page } from '$app/state';
	import { Search, Zap, UserCheck, Clock, Plus, Boxes, ExternalLink } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import RequestDialog from '#lib/components/RequestDialog.svelte';
	import { APPROVAL_LABEL, duration } from '#lib/format.ts';
	import type { Resource } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let q = $state('');
	let category = $state('all');
	let requesting = $state<Resource | null>(null);
	let requestRole = $state('');

	const admin = $derived(page.data.viewer?.role !== 'member');
	const categories = $derived([...new Set(data.resources.map((r) => r.category))].sort());
	const shown = $derived(
		data.resources.filter(
			(r) =>
				(category === 'all' || r.category === category) &&
				`${r.name} ${r.description} ${r.roles.map((x) => x.name).join(' ')}`.toLowerCase().includes(q.toLowerCase())
		)
	);

	$effect(() => {
		const id = page.url.searchParams.get('resource');
		if (id) {
			const r = data.resources.find((x) => x.id === id);
			if (r) {
				requestRole = page.url.searchParams.get('role') ?? '';
				requesting = r;
			}
		}
	});
</script>

<svelte:head><title>Request access · ac·modern</title></svelte:head>

<PageHeader title="Request access" description="Everything your team can ask for. Pick a tool, choose a level, say why.">
	{#snippet actions()}
		{#if admin}<a href="/resources/new" class="btn btn-secondary"><Plus />Add resource</a>{/if}
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	{#if data.resources.length}
		<div class="mb-5 flex flex-wrap items-center gap-2">
			<div class="relative w-full max-w-xs">
				<Search class="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
				<input class="input pl-9" placeholder="Search tools and roles…" bind:value={q} />
			</div>
			{#if categories.length > 1}
				<div class="flex flex-wrap gap-1">
					{#each ['all', ...categories] as c (c)}
						<button class="btn btn-sm {category === c ? 'btn-secondary text-foreground' : 'btn-ghost'} capitalize" onclick={() => (category = c)}>{c}</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{#each shown as r (r.id)}
				{@const held = data.held.filter((h) => h.resourceId === r.id)}
				{@const pending = data.open.find((o) => o.resourceId === r.id)}
				<article class="card flex flex-col p-4">
					<div class="flex items-start gap-3">
						<ResourceIcon name={r.name} color={r.color} size="size-10" text="text-[0.9375rem]" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<h3 class="truncate text-[0.9375rem] font-semibold tracking-tight">{r.name}</h3>
								{#if r.url}<a href={r.url} target="_blank" rel="noreferrer" class="text-muted-foreground hover:text-foreground" title="Open {r.name}"><ExternalLink class="size-3.5" /></a>{/if}
							</div>
							<p class="text-xs text-muted-foreground capitalize">{r.category}{#if !r.requestable} · <span class="normal-case">hidden from members</span>{/if}</p>
						</div>
					</div>
					{#if r.description}<p class="mt-3 line-clamp-2 text-[0.8125rem] text-muted-foreground">{r.description}</p>{/if}
					<div class="mt-3 flex flex-wrap gap-1">
						{#each r.roles as role (role.id)}
							{@const has = held.find((h) => h.roleId === role.id)}
							<span class="badge {has ? 'badge-success' : ''}" title={role.description}>{role.name}{#if has}<span class="ml-0.5">✓</span>{/if}</span>
						{/each}
					</div>
					<div class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-4 text-[0.6875rem] whitespace-nowrap text-muted-foreground">
						<span class="flex items-center gap-1">{#if r.approval === 'none'}<Zap class="size-3" />Instant{:else}<UserCheck class="size-3" />{APPROVAL_LABEL[r.approval]}{/if}</span>
						<span class="flex items-center gap-1"><Clock class="size-3" />{r.maxDays ? `Up to ${duration(r.maxDays).toLowerCase()}` : 'No time limit'}</span>
						<span class="flex-1"></span>
						{#if pending}
							<a href="/requests/{pending.number}" class="btn btn-ghost btn-sm">Pending #{pending.number}</a>
						{:else}
							<button class="btn btn-secondary btn-sm" onclick={() => ((requestRole = ''), (requesting = r))}>{held.length ? 'Request more' : 'Request'}</button>
						{/if}
					</div>
				</article>
			{:else}
				<p class="col-span-full py-10 text-center text-[0.8125rem] text-muted-foreground">Nothing matches “{q}”.</p>
			{/each}
		</div>
	{:else}
		<EmptyState icon={Boxes} title="Nothing to request yet" body={admin ? 'Add the apps and systems your team uses, with who approves access to each.' : 'An admin hasn’t added any tools yet.'}>
			{#snippet action()}
				{#if admin}<a href="/resources/new" class="btn btn-primary"><Plus />Add your first resource</a>{/if}
			{/snippet}
		</EmptyState>
	{/if}
</div>

<RequestDialog bind:resource={requesting} roleId={requestRole} people={data.people} me={page.data.viewer?.id ?? ''} canRequestFor={data.canRequestFor} />
