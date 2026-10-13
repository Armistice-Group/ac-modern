<script lang="ts">
	import type { Component } from 'svelte';
	let { label, value, hint, icon: Icon, href, tone = 'default' }: { label: string; value: number | string; hint?: string; icon: Component; href?: string; tone?: 'default' | 'primary' | 'warning' | 'danger' } = $props();
	const toneClass = $derived({ default: 'bg-muted text-muted-foreground', primary: 'bg-primary-soft text-primary', warning: 'bg-warning/10 text-warning', danger: 'bg-danger/10 text-danger' }[tone]);
</script>

<svelte:element this={href ? 'a' : 'div'} {href} class="card group flex items-start gap-3 p-4 transition-colors {href ? 'hover:border-primary/40' : ''}">
	<span class="grid size-9 shrink-0 place-items-center rounded-lg {toneClass}"><Icon class="size-4" /></span>
	<div class="min-w-0">
		<p class="text-xs text-muted-foreground">{label}</p>
		<p class="mt-0.5 font-mono text-xl font-semibold tracking-tight tabular-nums">{value}</p>
		{#if hint}<p class="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{hint}</p>{/if}
	</div>
</svelte:element>
