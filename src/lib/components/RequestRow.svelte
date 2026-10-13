<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ArrowRight, Minus } from '@lucide/svelte';
	import ResourceIcon from './ResourceIcon.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import { ago, displayName, duration, REASON } from '#lib/format.ts';
	import type { AccessRequest } from '#lib/types.ts';

	let { r, showUser = true, actions }: { r: AccessRequest; showUser?: boolean; actions?: Snippet } = $props();
</script>

<div class="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40">
	<ResourceIcon name={r.resource.name} color={r.resource.color} />
	<div class="min-w-0 flex-1">
		<a href="/requests/{r.number}" class="flex items-center gap-1.5 text-[0.8125rem] font-medium after:absolute after:inset-0">
			{#if showUser}<span class="truncate">{displayName(r.user)}</span>
				{#if r.kind === 'grant'}<ArrowRight class="size-3 shrink-0 text-muted-foreground" />{:else}<Minus class="size-3 shrink-0 text-danger" />{/if}
			{/if}
			<span class="truncate">{r.resource.name}</span>
			<span class="truncate font-normal text-muted-foreground">· {r.role.name}</span>
		</a>
		<p class="mt-0.5 truncate text-xs text-muted-foreground">
			<span class="font-mono">#{r.number}</span>
			· {r.kind === 'revoke' ? `Removal: ${REASON[r.reason].toLowerCase()}` : duration(r.durationDays)}
			{#if r.justification}· “{r.justification}”{/if}
		</p>
	</div>
	<div class="relative z-10 flex shrink-0 items-center gap-2">
		{#if actions}{@render actions()}{/if}
		{#if !actions}<StatusBadge status={r.status} kind={r.kind} />{/if}
		<span class="hidden w-20 text-right text-[0.6875rem] text-muted-foreground sm:block" title={r.createdAt}>{ago(r.createdAt)}</span>
	</div>
</div>
