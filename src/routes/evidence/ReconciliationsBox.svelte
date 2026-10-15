<script lang="ts">
	import { GitCompareArrows } from '@lucide/svelte';
	import { dateTime } from '#lib/format.ts';
	import type { Reconciliation } from '#lib/types.ts';

	let { runs }: { runs: Reconciliation[] } = $props();
	const systems = $derived(new Set(runs.map((r) => r.resource.id)).size);
</script>

<section class="card overflow-hidden">
	<header class="border-b border-border px-4 py-3">
		<h2 class="flex items-center gap-2 text-[0.8125rem] font-semibold"><GitCompareArrows class="size-4 text-primary" />Reconciliations <span class="font-normal text-muted-foreground">· {runs.length} across {systems} {systems === 1 ? 'system' : 'systems'}</span></h2>
		<p class="text-[0.6875rem] text-muted-foreground">Each system’s real user list compared with the access recorded here: accounts nobody approved, records with no account, and levels that differ. Open one to export it.</p>
	</header>
	<ul class="max-h-72 divide-y divide-border overflow-y-auto">
		{#each runs as r (r.id)}
			<li>
				<a href="/resources/{r.resource.id}/reconcile/{r.id}" class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs hover:bg-accent/40">
					<span class="w-36 text-muted-foreground">{dateTime(r.createdAt)}</span>
					<span class="flex-1 font-medium">{r.resource.name}</span>
					<span class="font-mono text-muted-foreground tabular-nums">{r.counts.accounts} accounts · {r.counts.unknown} unapproved · {r.counts.missing} stale · {r.counts.level_mismatch} level</span>
					{#if r.unresolved}<span class="badge badge-warning">{r.unresolved} unresolved</span>{:else}<span class="badge badge-success">Resolved</span>{/if}
				</a>
			</li>
		{:else}
			<li class="px-4 py-6 text-center text-xs text-muted-foreground">No reconciliations in this period. Run one from a system’s page (Reconcile).</li>
		{/each}
	</ul>
</section>
