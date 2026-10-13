<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	let { icon: Icon, title, body, action }: { icon: Component; title: string; body?: string; action?: Snippet } = $props();
</script>

<div class="card flex flex-col items-center px-6 py-12 text-center">
	<span class="grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><Icon class="size-5" /></span>
	<h3 class="mt-4 text-[0.9375rem] font-semibold tracking-tight">{title}</h3>
	{#if body}<p class="mt-1 max-w-sm text-[0.8125rem] text-muted-foreground">{body}</p>{/if}
	{#if action}<div class="mt-5">{@render action()}</div>{/if}
</div>
