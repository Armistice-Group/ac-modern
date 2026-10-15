<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Check, Undo2, X } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { ago, dateTime } from '#lib/format.ts';
	import type { PendingChange } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let rejecting = $state<string | null>(null);
	let note = $state('');
	let busy = $state<string | null>(null);

	async function decide(c: PendingChange, decision: 'approved' | 'rejected') {
		busy = c.id;
		try {
			await api.post(`/api/settings/changes/${c.id}`, { decision, note });
			toast('success', decision === 'approved' ? 'Approved and applied' : 'Rejected');
			rejecting = null;
			note = '';
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t do that', errorMessage(err));
		} finally {
			busy = null;
		}
	}
	async function withdraw(c: PendingChange) {
		await api.del(`/api/settings/changes/${c.id}`);
		await invalidateAll();
	}
	const STATUS: Record<string, string> = { approved: 'badge-success', rejected: 'badge-danger', cancelled: '', failed: 'badge-danger' };
</script>

<svelte:head><title>Control changes · ac·modern</title></svelte:head>

<div class="max-w-3xl space-y-6 px-8 pb-10">
	<section class="card p-5">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Waiting for a second admin</h2>
		<p class="mt-1 text-xs text-muted-foreground">Changes to approval controls take effect when an admin other than the one who asked approves them. Turn this on or off under General → Approval controls.</p>
		<ul class="mt-4 divide-y divide-border rounded-xl border border-border">
			{#each data.pending as c (c.id)}
				{@const mine = c.requestedBy?.id === data.me}
				<li class="px-3 py-3">
					<div class="flex flex-wrap items-start gap-3">
						<div class="min-w-0 flex-1">
							<p class="text-[0.8125rem] font-medium">{c.summary}</p>
							<p class="mt-0.5 text-xs text-muted-foreground">Asked by {c.requestedBy?.name ?? 'someone'} {ago(c.requestedAt)}</p>
						</div>
						{#if mine}
							<span class="badge">Waiting for another admin</span>
							<button class="btn btn-ghost btn-sm" onclick={() => withdraw(c)}><Undo2 />Withdraw</button>
						{:else}
							<button class="btn btn-primary btn-sm" disabled={busy === c.id} onclick={() => decide(c, 'approved')}><Check />Approve</button>
							<button class="btn btn-danger-outline btn-sm" disabled={busy === c.id} onclick={() => ((rejecting = c.id), (note = ''))}><X />Reject</button>
						{/if}
					</div>
					{#if rejecting === c.id}
						<form class="mt-2 flex gap-2" onsubmit={(e) => (e.preventDefault(), decide(c, 'rejected'))}>
							<input class="input" placeholder="Why? They’ll see this." bind:value={note} required />
							<button class="btn btn-danger" disabled={busy === c.id}>Reject</button>
						</form>
					{/if}
				</li>
			{:else}
				<li class="px-3 py-6 text-center text-xs text-muted-foreground">Nothing waiting.</li>
			{/each}
		</ul>
	</section>

	{#if data.recent.length}
		<section class="card p-5">
			<h2 class="text-[0.9375rem] font-semibold tracking-tight">Decided</h2>
			<ul class="mt-3 divide-y divide-border">
				{#each data.recent as c (c.id)}
					<li class="flex flex-wrap items-center gap-3 py-2.5 text-xs">
						<span class="min-w-0 flex-1">{c.summary}<span class="block text-[0.6875rem] text-muted-foreground">Asked by {c.requestedBy?.name ?? '—'}{c.decidedBy ? `, ${c.status} by ${c.decidedBy.name}` : ''} · {dateTime(c.decidedAt ?? c.requestedAt)}{c.note ? ` · “${c.note}”` : ''}</span></span>
						<span class="badge {STATUS[c.status]}">{c.status[0].toUpperCase() + c.status.slice(1)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
