<script lang="ts">
	import { CircleCheck, CircleAlert, Info, X } from '@lucide/svelte';
	import { dismiss, toasts } from '#lib/client/state.svelte.ts';
	import { fly } from 'svelte/transition';
</script>

<div class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[22rem] flex-col gap-2">
	{#each toasts as t (t.id)}
		<div
			transition:fly={{ y: 12, duration: 180 }}
			class="card pointer-events-auto flex items-start gap-3 p-3 shadow-surface-lg"
		>
			{#if t.kind === 'success'}
				<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />
			{:else if t.kind === 'error'}
				<CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
			{:else}
				<Info class="mt-0.5 size-4 shrink-0 text-primary" />
			{/if}
			<div class="min-w-0 flex-1">
				<p class="text-[0.8125rem] font-medium">{t.title}</p>
				{#if t.body}<p class="mt-0.5 text-xs break-words text-muted-foreground">{t.body}</p>{/if}
			</div>
			<button class="text-muted-foreground hover:text-foreground" onclick={() => dismiss(t.id)} aria-label="Dismiss"
				><X class="size-3.5" /></button
			>
		</div>
	{/each}
</div>
