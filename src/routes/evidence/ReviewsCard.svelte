<script lang="ts">
	import { ClipboardCheck, Download } from '@lucide/svelte';
	import { date } from '#lib/format.ts';
	import type { Review } from '#lib/types.ts';

	let { reviews }: { reviews: Review[] } = $props();
</script>

<section class="card overflow-hidden">
	<header class="border-b border-border px-4 py-3">
		<h2 class="flex items-center gap-2 text-[0.8125rem] font-semibold"><ClipboardCheck class="size-4 text-primary" />Access reviews <span class="font-normal text-muted-foreground">· {reviews.length}</span></h2>
		<p class="text-[0.6875rem] text-muted-foreground">Reviews started or closed in this period: completion, whether they finished on time, and whether revoked access was removed.</p>
	</header>
	{#if reviews.length}
		<ul class="divide-y divide-border">
			{#each reviews as r (r.id)}
				{@const late = r.dueAt && (r.closedAt ? r.closedAt > r.dueAt : Date.now() > Date.parse(r.dueAt))}
				<li class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs">
					<div class="min-w-0 flex-1">
						<a class="font-medium hover:underline" href="/reviews/{r.id}">{r.name}</a>
						<p class="text-[0.6875rem] text-muted-foreground">{r.policyName ? 'Scheduled' : 'Started by hand'} {date(r.createdAt)}{r.dueAt ? ` · due ${date(r.dueAt)}` : ''}{r.closedAt ? ` · closed ${date(r.closedAt)}` : ''}</p>
					</div>
					<span class="font-mono tabular-nums text-muted-foreground">{r.decided}/{r.total} decided · {r.revoked} revoked · {r.removed} removed</span>
					{#if r.status === 'open'}<span class="badge {late ? 'badge-danger' : 'badge-primary'}">{late ? 'Overdue' : 'Open'}</span>
					{:else if late}<span class="badge badge-warning">Closed late</span>
					{:else}<span class="badge badge-success">On time</span>{/if}
					<a class="btn btn-ghost btn-icon btn-sm" title="Export evidence" href="/api/reviews/{r.id}/export" data-sveltekit-reload><Download /></a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="px-4 py-6 text-center text-xs text-muted-foreground">No reviews in this period. Set up <a class="text-primary hover:underline" href="/reviews">review policies</a> so they run on schedule.</p>
	{/if}
</section>
