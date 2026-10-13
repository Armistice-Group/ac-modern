<script lang="ts">
	import { TriangleAlert } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import { confirmation } from '#lib/client/state.svelte.ts';

	const req = $derived(confirmation.request);

	function finish(ok: boolean) {
		const r = confirmation.request;
		confirmation.request = null;
		r?.resolve(ok);
	}
</script>

<Dialog bind:open={() => !!req, (v) => !v && finish(false)} title={req?.title ?? ''} width="max-w-md">
	{#if req}
		<div class="flex gap-3">
			{#if req.danger}
				<span class="grid size-9 shrink-0 place-items-center rounded-full bg-danger/10 text-danger"><TriangleAlert class="size-4" /></span>
			{/if}
			<div class="min-w-0 flex-1 space-y-3 text-[0.8125rem] text-muted-foreground">
				{#if req.body}<p>{req.body}</p>{/if}
				{#if req.detail}
					<pre class="max-h-48 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-[0.6875rem] whitespace-pre-wrap text-foreground">{req.detail}</pre>
				{/if}
			</div>
		</div>
	{/if}
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => finish(false)}>Cancel</button>
		<!-- svelte-ignore a11y_autofocus -->
		<button class="btn {req?.danger ? 'btn-danger' : 'btn-primary'}" autofocus onclick={() => finish(true)}>{req?.confirmLabel ?? 'Confirm'}</button>
	{/snippet}
</Dialog>
