<script lang="ts">
	import { Boxes, Plus, Webhook, Hand, EyeOff, Search, ScanSearch, Plug } from '@lucide/svelte';
	import { INTEGRATIONS } from '#lib/integrations.ts';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import { APPROVAL_LABEL, displayName, duration } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let q = $state('');
	let showArchived = $state(false);
	const shown = $derived(data.resources.filter((r) => (showArchived || !r.archived) && `${r.name} ${r.category}`.toLowerCase().includes(q.toLowerCase())));
	const archivedCount = $derived(data.resources.filter((r) => r.archived).length);
	const person = (id: string | null) => data.people.find((p) => p.id === id);
</script>

<svelte:head><title>Resources · ac·modern</title></svelte:head>

<PageHeader title="Resources" description="The apps and systems people can request, and the rules for each.">
	{#snippet actions()}
		<a href="/resources/import" class="btn btn-secondary"><ScanSearch />Import from IdP</a>
		<a href="/resources/new" class="btn btn-primary"><Plus />Add resource</a>
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	{#if data.resources.length}
		<div class="mb-4 flex items-center gap-3">
			<div class="relative w-full max-w-xs">
				<Search class="pointer-events-none absolute top-2 left-3 size-4 text-muted-foreground" />
				<input class="input h-8 pl-9 text-xs" placeholder="Filter…" bind:value={q} />
			</div>
			{#if archivedCount}
				<label class="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" class="accent-[var(--primary)]" bind:checked={showArchived} />Show archived ({archivedCount})</label>
			{/if}
		</div>
		<div class="card overflow-x-auto">
			<table class="w-full text-[0.8125rem]">
				<thead>
					<tr class="border-b border-border text-left text-xs text-muted-foreground">
						<th class="px-4 py-2.5 font-medium">Resource</th>
						<th class="px-4 py-2.5 font-medium">Levels</th>
						<th class="px-4 py-2.5 font-medium">Approval</th>
						<th class="px-4 py-2.5 font-medium">Setup</th>
						<th class="px-4 py-2.5 font-medium">Owner</th>
						<th class="px-4 py-2.5 text-right font-medium">Holders</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each shown as r (r.id)}
						{@const owner = person(r.ownerId)}
						<tr class="relative transition-colors hover:bg-accent/30 {r.archived ? 'opacity-60' : ''}">
							<td class="px-4 py-2.5">
								<a href="/resources/{r.id}" class="flex items-center gap-2.5 after:absolute after:inset-0">
									<ResourceIcon name={r.name} color={r.color} size="size-7" text="text-xs" />
									<span>
										<span class="flex items-center gap-1.5 font-medium">{r.name}{#if !r.requestable}<EyeOff class="size-3 text-muted-foreground" />{/if}{#if r.archived}<span class="badge">Archived</span>{/if}</span>
										<span class="block text-xs text-muted-foreground capitalize">{r.category}</span>
									</span>
								</a>
							</td>
							<td class="px-4 py-2.5 text-xs text-muted-foreground">{r.roles.map((x) => x.name).join(', ')}</td>
							<td class="px-4 py-2.5 text-xs">{APPROVAL_LABEL[r.approval]}<span class="block text-muted-foreground">{r.maxDays ? `max ${duration(r.maxDays).toLowerCase()}` : 'no time limit'}</span></td>
							<td class="px-4 py-2.5 text-xs text-muted-foreground"><span class="flex items-center gap-1.5">{#if r.fulfillment === 'webhook'}<Webhook class="size-3.5" />Webhook{:else if r.fulfillment === 'integration' && r.integration}<Plug class="size-3.5" />{INTEGRATIONS[r.integration].name}{:else}<Hand class="size-3.5" />By hand{/if}</span></td>
							<td class="px-4 py-2.5 text-xs">{#if owner}<span class="flex items-center gap-1.5"><Avatar user={owner} size="size-5" />{displayName(owner)}</span>{:else}<span class="text-muted-foreground">—</span>{/if}</td>
							<td class="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
								{data.grants[r.id] ?? 0}
								{#if data.open[r.id]}<span class="ml-1.5 badge badge-warning">{data.open[r.id]} open</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<EmptyState icon={Boxes} title="Add the tools your team uses" body="For each one, list its access levels, who approves, and who sets it up. Start from a template or from scratch.">
			{#snippet action()}<a href="/resources/new" class="btn btn-primary"><Plus />Add your first resource</a>{/snippet}
		</EmptyState>
	{/if}
</div>
