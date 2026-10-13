<script lang="ts">
	import type { Snippet } from 'svelte';
	import Logo from './Logo.svelte';
	let { title, subtitle, children, width = 'max-w-sm' }: { title: string; subtitle?: string; children: Snippet; width?: string } = $props();
</script>

<div class="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
	<div class="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70"></div>
	<div class="glow-top pointer-events-none absolute inset-x-0 top-0 h-[480px]"></div>
	<div class="card relative w-full {width} p-7 shadow-surface-lg">
		<div class="mb-6 flex flex-col items-center text-center">
			<Logo size={44} />
			<h1 class="mt-4 text-lg font-semibold tracking-tight">{title}</h1>
			{#if subtitle}<p class="mt-1 text-[0.8125rem] text-muted-foreground">{subtitle}</p>{/if}
		</div>
		{@render children()}
	</div>
</div>
