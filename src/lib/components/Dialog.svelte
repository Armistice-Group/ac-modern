<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';

	let {
		open = $bindable(false),
		title,
		description,
		width = 'max-w-lg',
		children,
		footer
	}: {
		open: boolean;
		title: string;
		description?: string;
		width?: string;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let dialog: HTMLDialogElement;

	$effect(() => {
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	onclose={() => (open = false)}
	onclick={(e) => e.target === dialog && (open = false)}
	class="m-auto w-[calc(100%-2rem)] {width} rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-surface-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm open:animate-[pop_.16s_ease-out]"
>
	{#if open}
		<div class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
			<div>
				<h2 class="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
				{#if description}<p class="mt-0.5 text-[0.8125rem] text-muted-foreground">{description}</p>{/if}
			</div>
			<button class="btn btn-ghost btn-icon btn-sm -mr-1" onclick={() => (open = false)} aria-label="Close"><X /></button>
		</div>
		<div class="max-h-[70vh] overflow-y-auto px-5 py-4">
			{@render children()}
		</div>
		{#if footer}
			<div class="flex items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3 rounded-b-2xl">
				{@render footer()}
			</div>
		{/if}
	{/if}
</dialog>

<style>
	@keyframes -global-pop {
		from {
			opacity: 0;
			transform: translateY(6px) scale(0.98);
		}
	}
</style>
