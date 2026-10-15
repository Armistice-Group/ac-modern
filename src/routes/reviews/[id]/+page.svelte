<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Check, X, Lock, Download, UserRoundCog, ShieldAlert } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { date, displayName } from '#lib/format.ts';
	import type { ReviewItem } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const me = $derived(page.data.viewer?.id);
	let filter = $state<'mine' | 'undecided' | 'all'>('undecided');
	let busy = $state<string | null>(null);
	const open = $derived(data.review.status === 'open');
	const shown = $derived(
		data.items.filter((i) => (filter === 'mine' ? i.reviewerId === me : filter === 'undecided' ? !i.decision : true))
	);
	const groups = $derived.by(() => {
		const m = new Map<string, { name: string; color: string; items: ReviewItem[] }>();
		for (const i of shown) {
			const g = m.get(i.grant.resource.id) ?? { name: i.grant.resource.name, color: i.grant.resource.color, items: [] };
			g.items.push(i);
			m.set(i.grant.resource.id, g);
		}
		return [...m.values()];
	});
	const pct = $derived(data.review.total ? Math.round((data.review.decided / data.review.total) * 100) : 0);

	async function decide(i: ReviewItem, decision: 'keep' | 'revoke') {
		busy = i.id;
		try {
			await api.post(`/api/review-items/${i.id}`, { decision });
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save that', errorMessage(err));
		} finally {
			busy = null;
		}
	}

	async function keepAll(items: ReviewItem[]) {
		for (const i of items.filter((x) => !x.decision && (x.reviewerId === me || data.admin))) await decide(i, 'keep');
	}

	async function close() {
		const left = data.review.total - data.review.decided;
		const ok = await confirmAction({
			title: `Close “${data.review.name}”?`,
			body: left ? `${left} ${left === 1 ? 'grant is' : 'grants are'} still undecided and will be left as they are.` : 'Every grant has been decided.',
			confirmLabel: 'Close review'
		});
		if (!ok) return;
		try {
			await api.post(`/api/reviews/${data.review.id}/close`, {});
			toast('success', 'Review closed');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t close', errorMessage(err));
		}
	}

	const CAP: Record<string, string> = { owner: 'owner', approver: 'approver', manager: 'manager', admin: 'admin', '': '' };

	// Progress per reviewer, for chasing and reassigning.
	const reviewers = $derived.by(() => {
		const m = new Map<string, { id: string; name: string; total: number; left: number }>();
		for (const i of data.items) {
			if (!i.reviewerId) continue;
			const r = m.get(i.reviewerId) ?? { id: i.reviewerId, name: i.reviewerName ?? '—', total: 0, left: 0 };
			r.total++;
			if (!i.decision && i.grant.status !== 'revoked') r.left++;
			m.set(i.reviewerId, r);
		}
		return [...m.values()].sort((a, b) => b.left - a.left);
	});
	let reassigning = $state<string | null>(null);
	let reassignTo = $state('');
	async function reassign(from: string) {
		if (!reassignTo) return;
		try {
			const r = await api.post<{ count: number }>(`/api/reviews/${data.review.id}/reassign`, { from, to: reassignTo });
			toast('success', `Reassigned ${r.count} ${r.count === 1 ? 'item' : 'items'}`);
			reassigning = null;
			reassignTo = '';
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t reassign', errorMessage(err));
		}
	}
</script>

<svelte:head><title>{data.review.name} · ac·modern</title></svelte:head>

<PageHeader
	title={data.review.name}
	description={`${open ? (data.review.dueAt ? `Due ${date(data.review.dueAt)}` : 'Open') : `Closed ${date(data.review.closedAt)}`}${data.review.policyName ? ` · started by the “${data.review.policyName}” policy` : ''}${data.review.scope.scope === 'privileged' ? ' · privileged access only' : ''}${data.review.scope.reviewer === 'manager' ? ' · reviewed by managers' : ''}`}
>
	{#snippet actions()}
		{#if data.admin}
			<a class="btn btn-ghost" href="/api/reviews/{data.review.id}/export" data-sveltekit-reload><Download />Export evidence</a>
			{#if open}<button class="btn btn-secondary" onclick={close}><Lock />Close review</button>{/if}
		{/if}
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	<div class="card mb-5 flex flex-wrap items-center gap-6 p-4">
		<div class="min-w-48 flex-1">
			<div class="h-2 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary transition-[width]" style="width:{pct}%"></div></div>
			<p class="mt-1.5 font-mono text-xs text-muted-foreground tabular-nums">{data.review.decided} of {data.review.total} decided · {pct}%</p>
		</div>
		<div class="flex gap-6 font-mono text-xs tabular-nums">
			<span><span class="text-lg font-semibold text-success">{data.review.decided - data.review.revoked}</span> kept</span>
			<span><span class="text-lg font-semibold text-danger">{data.review.revoked}</span> revoked</span>
		</div>
		<div class="flex rounded-xl border border-border bg-surface p-0.5">
			{#each [['undecided', 'Undecided'], ['mine', 'Assigned to me'], ['all', 'All']] as [id, label] (id)}
				<button class="h-7 rounded-lg px-3 text-xs font-medium {filter === id ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (filter = id as typeof filter)}>{label}</button>
			{/each}
		</div>
	</div>

	{#if data.admin && reviewers.length > 1}
		<section class="card mb-5 p-4">
			<h2 class="mb-2 text-[0.8125rem] font-semibold">Reviewers</h2>
			<ul class="divide-y divide-border">
				{#each reviewers as r (r.id)}
					<li class="flex flex-wrap items-center gap-3 py-2 text-[0.8125rem]">
						<span class="flex-1">{r.name}</span>
						<span class="font-mono text-xs text-muted-foreground tabular-nums">{r.total - r.left}/{r.total}</span>
						{#if r.left === 0}<span class="badge badge-success"><Check />Done</span>{:else}<span class="badge {open && data.review.dueAt && Date.parse(data.review.dueAt) < Date.now() ? 'badge-danger' : 'badge-warning'}">{r.left} left</span>{/if}
						{#if open && r.left}
							{#if reassigning === r.id}
								<select class="input h-8 w-48 text-xs" bind:value={reassignTo}>
									<option value="">Reassign to…</option>
									{#each data.people.filter((p) => p.id !== r.id) as p (p.id)}<option value={p.id}>{p.name || p.email}</option>{/each}
								</select>
								<button class="btn btn-secondary btn-sm" disabled={!reassignTo} onclick={() => reassign(r.id)}>Reassign</button>
							{:else}
								<button class="btn btn-ghost btn-sm" onclick={() => ((reassigning = r.id), (reassignTo = ''))}><UserRoundCog />Reassign</button>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#each groups as g (g.name)}
		<section class="card mb-4 overflow-hidden">
			<header class="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
				<ResourceIcon name={g.name} color={g.color} size="size-6" text="text-[0.6875rem]" />
				<h2 class="flex-1 text-[0.8125rem] font-semibold">{g.name} <span class="font-normal text-muted-foreground">· {g.items.length}</span></h2>
				{#if open && g.items.some((i) => !i.decision)}<button class="btn btn-ghost btn-sm" onclick={() => keepAll(g.items)}><Check />Keep all undecided</button>{/if}
			</header>
			<ul class="divide-y divide-border">
				{#each g.items as i (i.id)}
					{@const mine = i.reviewerId === me || data.admin}
					<li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
						<Avatar user={i.grant.user} size="size-7" />
						<div class="min-w-0 flex-1">
							<p class="truncate text-[0.8125rem] font-medium">
								{displayName(i.grant.user)} <span class="font-normal text-muted-foreground">· {i.grant.role.name}</span>
								{#if i.privileged}<span class="badge badge-warning ml-1"><ShieldAlert />Privileged</span>{/if}
							</p>
							<p class="truncate text-xs text-muted-foreground">
								Since {date(i.grant.grantedAt)}{i.grant.expiresAt ? `, until ${date(i.grant.expiresAt)}` : ''} · reviewer {i.reviewerName ?? '—'}{i.capacity ? ` (${CAP[i.capacity]})` : ''}{i.decidedBy && i.decidedBy !== i.reviewerName ? ` · decided by ${i.decidedBy}` : ''}
								{#if i.removal}
									· removal <a class="text-primary hover:underline" href="/requests/{i.removal.number}">#{i.removal.number}</a> {i.removal.status === 'completed' ? `done ${date(i.removal.closedAt)}` : i.removal.status === 'cancelled' ? 'called off' : 'pending'}
								{/if}
							</p>
						</div>
						{#if i.decision === 'keep'}
							<span class="badge badge-success"><Check />Kept</span>
							{#if open && mine}<button class="btn btn-ghost btn-sm" disabled={busy === i.id} onclick={() => decide(i, 'revoke')}>Revoke instead</button>{/if}
						{:else if i.decision === 'revoke'}
							<span class="badge badge-danger"><X />Revoked</span>
						{:else if i.grant.status === 'revoked'}
							<span class="badge">Removed since</span>
						{:else if open && mine}
							<button class="btn btn-secondary btn-sm" disabled={busy === i.id} onclick={() => decide(i, 'keep')}><Check />Keep</button>
							<button class="btn btn-danger-outline btn-sm" disabled={busy === i.id} onclick={() => decide(i, 'revoke')}><X />Revoke</button>
						{:else}
							<span class="badge">Undecided</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<p class="py-12 text-center text-[0.8125rem] text-muted-foreground">{filter === 'undecided' ? 'Everything here has been decided.' : 'Nothing to show.'}</p>
	{/each}
</div>
