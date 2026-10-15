<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { ArrowLeft, CircleCheck, Download, LoaderCircle } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { dateTime, RECONCILIATION_ACTIONS, RECONCILIATION_RESOLUTION, RECONCILIATION_STATUS } from '#lib/format.ts';
	import type { ReconciliationItem, ReconciliationResolution, ReconciliationStatus } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const r = $derived(data.run);
	let filter = $state<'open' | ReconciliationStatus | 'all'>('open');
	const shown = $derived(
		data.items.filter((i) => (filter === 'all' ? true : filter === 'open' ? i.status !== 'matched' && !i.resolution : i.status === filter))
	);
	const BADGE: Record<ReconciliationStatus, string> = { matched: 'badge-success', unknown: 'badge-danger', missing: 'badge-warning', level_mismatch: 'badge-warning' };
	const HINT: Record<ReconciliationResolution, string> = {
		recorded: 'They were approved outside ac·modern (or before it). Records the access, with your reason, so reviews and offboarding cover it.',
		removed_in_system: 'You removed the account (or fixed its level) in the system itself.',
		service_account: 'Not a person: a bot, integration or shared login. Say who owns it and why it needs access.',
		closed: 'They don’t have it any more. Closes ac·modern’s record without changing the system.',
		kept: 'The record is right (e.g. the export leaves some users out). Say why.'
	};

	let item = $state<ReconciliationItem | null>(null);
	let resolving = $state(false);
	let resolution = $state<ReconciliationResolution>('recorded');
	let note = $state('');
	let roleId = $state('');
	let busy = $state(false);

	function open(i: ReconciliationItem) {
		item = i;
		resolution = RECONCILIATION_ACTIONS[i.status].find((x) => x !== 'recorded' || (i.user && i.user.member === 'active')) ?? RECONCILIATION_ACTIONS[i.status][0];
		note = '';
		roleId = i.roleId ?? '';
		resolving = true;
	}

	async function resolve(e: SubmitEvent) {
		e.preventDefault();
		if (!item) return;
		busy = true;
		try {
			await api.post(`/api/reconciliation-items/${item.id}`, { resolution, note, roleId: resolution === 'recorded' ? roleId : null });
			toast('success', RECONCILIATION_RESOLUTION[resolution]);
			resolving = false;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t resolve that', errorMessage(err));
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{r.resource.name} reconciliation · ac·modern</title></svelte:head>

<PageHeader
	title="{r.resource.name} reconciliation"
	description="{dateTime(r.createdAt)} · {r.source === 'csv' ? r.filename || 'uploaded list' : 'pulled from the integration'} · by {r.runBy?.name || r.runBy?.email || '—'}"
>
	{#snippet actions()}
		<a href="/resources/{r.resource.id}/reconcile" class="btn btn-ghost"><ArrowLeft />All reconciliations</a>
		<a href="/api/reconciliations/{r.id}/export" class="btn btn-secondary" data-sveltekit-reload><Download />Export evidence</a>
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	<div class="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
		{#each [['all', 'Accounts compared', r.counts.accounts], ['matched', 'Matched', r.counts.matched], ['unknown', 'Not in ac·modern', r.counts.unknown], ['missing', 'Not in the system', r.counts.missing], ['level_mismatch', 'Different level', r.counts.level_mismatch]] as [k, label, n] (k)}
			<button class="card p-3 text-left transition-colors hover:border-primary/40 {filter === k ? 'border-primary/50' : ''}" onclick={() => (filter = k as typeof filter)}>
				<p class="text-xs text-muted-foreground">{label}</p>
				<p class="mt-1 font-mono text-xl font-semibold tabular-nums">{n}</p>
			</button>
		{/each}
	</div>

	<div class="mb-3 flex items-center gap-3">
		<div class="flex rounded-xl border border-border bg-surface p-0.5">
			{#each [['open', `To resolve · ${r.unresolved}`], ['all', 'All']] as [id, label] (id)}
				<button class="h-7 rounded-lg px-3 text-xs font-medium {filter === id ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (filter = id as typeof filter)}>{label}</button>
			{/each}
		</div>
		{#if !r.unresolved}<span class="flex items-center gap-1.5 text-xs text-success"><CircleCheck class="size-3.5" />Every finding is resolved</span>{/if}
	</div>

	<section class="card overflow-hidden">
		<ul class="divide-y divide-border">
			{#each shown as i (i.id)}
				<li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
					<div class="min-w-0 flex-1">
						<p class="truncate text-[0.8125rem] font-medium">
							{i.user?.name || i.account}
							{#if i.user && i.user.name}<span class="font-normal text-muted-foreground">· {i.account}</span>{/if}
							{#if i.level}<span class="font-normal text-muted-foreground">· {i.level}</span>{/if}
						</p>
						<p class="truncate text-xs text-muted-foreground">
							{i.detail || RECONCILIATION_STATUS[i.status]}
							{#if i.resolution} · <span class="text-foreground/80">{RECONCILIATION_RESOLUTION[i.resolution]}</span> by {i.resolvedBy} {dateTime(i.resolvedAt)}: “{i.note}”{/if}
						</p>
					</div>
					<span class="badge {BADGE[i.status]}">{RECONCILIATION_STATUS[i.status]}</span>
					{#if i.status !== 'matched' && !i.resolution}<button class="btn btn-secondary btn-sm" onclick={() => open(i)}>Resolve</button>{/if}
				</li>
			{:else}
				<li class="px-4 py-10 text-center text-xs text-muted-foreground">{filter === 'open' ? 'Nothing left to resolve.' : 'Nothing here.'}</li>
			{/each}
		</ul>
	</section>
</div>

<Dialog bind:open={resolving} title="Resolve: {item?.user?.name || item?.account}" description={item ? `${RECONCILIATION_STATUS[item.status]}${item.level ? ` · ${item.level}` : ''}` : ''}>
	{#if item}
		<form id="resolve-form" class="space-y-3" onsubmit={resolve}>
			<div class="space-y-1.5">
				{#each RECONCILIATION_ACTIONS[item.status] as a (a)}
					{@const disabled = a === 'recorded' && !(item.user && item.user.member === 'active')}
					<label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5 text-[0.8125rem] {resolution === a ? 'border-primary/50 bg-primary-soft' : ''} {disabled ? 'opacity-50' : ''}">
						<input type="radio" class="mt-1 accent-[var(--primary)]" value={a} bind:group={resolution} {disabled} />
						<span>
							<span class="font-medium">{RECONCILIATION_RESOLUTION[a]}</span><br />
							<span class="text-xs text-muted-foreground">{disabled ? 'Only for active members of ac·modern. Add them first, or justify it another way.' : HINT[a]}</span>
						</span>
					</label>
				{/each}
			</div>
			{#if resolution === 'recorded'}
				<div>
					<label class="label" for="rl">Access level they have</label>
					<select id="rl" class="input" bind:value={roleId} required>
						<option value="" disabled>Pick a level</option>
						{#each data.roles as x (x.id)}<option value={x.id}>{x.name}{x.privileged ? ' (privileged)' : ''}</option>{/each}
					</select>
				</div>
			{/if}
			<div>
				<label class="label" for="rn">Why</label>
				<textarea id="rn" class="input h-20 resize-none py-2" required minlength="3" placeholder={resolution === 'service_account' ? 'Billing export bot, owned by Finance' : 'For the record, e.g. who approved it or what you changed'} bind:value={note}></textarea>
			</div>
		</form>
	{/if}
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (resolving = false)}>Cancel</button>
		<button class="btn btn-primary" form="resolve-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Resolve</button>
	{/snippet}
</Dialog>
