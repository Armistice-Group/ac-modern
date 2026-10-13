<script lang="ts">
	import type { Snippet } from 'svelte';
	let { title, description, actions }: { title: string; description?: string; actions?: Snippet } = $props();
</script>

<div class="relative">
	<div class="glow-top pointer-events-none absolute inset-x-0 -top-10 h-64"></div>
	<header class="relative flex flex-wrap items-end justify-between gap-4 px-8 pt-8 pb-6">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
			{#if description}<p class="mt-1 text-sm text-muted-foreground">{description}</p>{/if}
		</div>
		{#if actions}<div class="flex items-center gap-2">{@render actions()}</div>{/if}
	</header>
</div>
