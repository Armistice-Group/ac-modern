<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { Inbox, Wrench, KeyRound, Hourglass, LayoutGrid, Check, CircleCheck, Circle, ClipboardCheck, ArrowRight } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import StatCard from '#lib/components/StatCard.svelte';
	import RequestRow from '#lib/components/RequestRow.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { ago, daysLeft, displayName } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const greeting = $derived.by(() => {
		const h = new Date().getHours();
		return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
	});
	const first = $derived((page.data.viewer?.name || '').split(' ')[0]);
	const expiring = $derived(data.myGrants.filter((g) => g.expiresAt && (daysLeft(g.expiresAt) ?? 99) <= 14));
	const needs = $derived(data.work.toApprove.length + data.work.toFulfill.length + page.data.badges.review);
	let busy = $state<string | null>(null);

	async function quickApprove(id: string) {
		busy = id;
		try {
			const r = await api.post<{ number: number }>(`/api/requests/${id}/approve`, {});
			toast('success', `Approved #${r.number}`);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t approve', errorMessage(err));
		} finally {
			busy = null;
		}
	}

	const steps = $derived(
		data.org
			? [
					{ done: data.org.setup.resources, label: 'Add the tools and systems people ask for', href: '/resources/new', cta: 'Add a resource' },
					{ done: data.org.setup.people, label: 'Invite your team', href: '/people?invite=1', cta: 'Invite people' },
					{ done: data.org.setup.grants, label: 'Record who already has access', href: '/access?record=1', cta: 'Record access' },
					{ done: data.org.setup.slack, label: 'Post requests to a Slack channel (optional)', href: '/settings#notifications', cta: 'Connect Slack' }
				]
			: []
	);
	const setupLeft = $derived(steps.filter((s) => !s.done).length);
</script>

<svelte:head><title>Overview · ac·modern</title></svelte:head>

<PageHeader title="{greeting}{first ? `, ${first}` : ''}" description={needs ? `${needs} ${needs === 1 ? 'thing needs' : 'things need'} you.` : 'Nothing is waiting on you.'}>
	{#snippet actions()}
		<a href="/catalog" class="btn btn-primary"><LayoutGrid />Request access</a>
	{/snippet}
</PageHeader>

<div class="space-y-6 px-8 pb-10">
	{#if data.org && setupLeft > 0}
		<section class="card overflow-hidden">
			<div class="flex items-center justify-between border-b border-border px-5 py-3.5">
				<div>
					<h2 class="text-[0.9375rem] font-semibold tracking-tight">Get set up</h2>
					<p class="text-xs text-muted-foreground">{steps.length - setupLeft} of {steps.length} done</p>
				</div>
				<div class="h-1.5 w-32 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary" style="width:{((steps.length - setupLeft) / steps.length) * 100}%"></div></div>
			</div>
			<ul class="divide-y divide-border">
				{#each steps as s (s.label)}
					<li class="flex items-center gap-3 px-5 py-2.5">
						{#if s.done}<CircleCheck class="size-4 text-success" />{:else}<Circle class="size-4 text-muted-foreground/60" />{/if}
						<span class="flex-1 text-[0.8125rem] {s.done ? 'text-muted-foreground line-through' : ''}">{s.label}</span>
						{#if !s.done}<a href={s.href} class="btn btn-secondary btn-sm">{s.cta}</a>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		<StatCard label="Waiting for your approval" value={data.work.toApprove.length} icon={Inbox} tone={data.work.toApprove.length ? 'warning' : 'default'} href="/requests?view=approve" />
		<StatCard label="For you to set up" value={data.work.toFulfill.length} icon={Wrench} tone={data.work.toFulfill.length ? 'primary' : 'default'} href="/requests?view=fulfill" />
		{#if data.org}
			<StatCard label="Active grants" value={data.org.activeGrants} hint="{data.org.resources} resources · {data.org.people} people" icon={KeyRound} href="/access" />
			<StatCard label="Expiring in 7 days" value={data.org.expiringSoon} icon={Hourglass} tone={data.org.expiringSoon ? 'warning' : 'default'} href="/access?expiring=7" />
		{:else}
			<StatCard label="Your access" value={data.myGrants.length} icon={KeyRound} href="/access?mine=1" />
			<StatCard label="Yours expiring soon" value={expiring.length} icon={Hourglass} tone={expiring.length ? 'warning' : 'default'} href="/access?mine=1" />
		{/if}
	</div>

	<div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
		<div class="space-y-6">
			<section class="card overflow-hidden">
				<header class="flex items-center justify-between border-b border-border px-4 py-3">
					<h2 class="text-[0.8125rem] font-semibold">Needs you</h2>
					<a href="/requests?view=approve" class="text-xs text-muted-foreground hover:text-foreground">All requests →</a>
				</header>
				{#if needs === 0}
					<div class="flex flex-col items-center px-6 py-10 text-center">
						<span class="grid size-10 place-items-center rounded-xl bg-success/10 text-success"><Check class="size-5" /></span>
						<p class="mt-3 text-[0.8125rem] font-medium">All caught up</p>
						<p class="mt-0.5 text-xs text-muted-foreground">Approvals, setup tasks and reviews assigned to you show up here.</p>
					</div>
				{:else}
					<div class="divide-y divide-border">
						{#each data.work.toApprove as r (r.id)}
							<RequestRow {r}>
								{#snippet actions()}
									<button class="btn btn-secondary btn-sm" disabled={busy === r.id} onclick={() => quickApprove(r.id)}><Check />Approve</button>
								{/snippet}
							</RequestRow>
						{/each}
						{#each data.work.toFulfill as r (r.id)}
							<RequestRow {r}>
								{#snippet actions()}
									<a class="btn btn-secondary btn-sm" href="/requests/{r.number}"><Wrench />{r.kind === 'grant' ? 'Set up' : 'Remove'}</a>
								{/snippet}
							</RequestRow>
						{/each}
						{#if page.data.badges.review}
							<a href="/reviews" class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40">
								<span class="grid size-8 place-items-center rounded-lg bg-primary-soft text-primary"><ClipboardCheck class="size-4" /></span>
								<span class="flex-1 text-[0.8125rem] font-medium">{page.data.badges.review} {page.data.badges.review === 1 ? 'grant' : 'grants'} to review</span>
								<ArrowRight class="size-4 text-muted-foreground" />
							</a>
						{/if}
					</div>
				{/if}
			</section>

			<section class="card overflow-hidden">
				<header class="flex items-center justify-between border-b border-border px-4 py-3">
					<h2 class="text-[0.8125rem] font-semibold">Your requests</h2>
					<a href="/requests?view=mine" class="text-xs text-muted-foreground hover:text-foreground">See all →</a>
				</header>
				{#if data.mine.length}
					<div class="divide-y divide-border">
						{#each data.mine as r (r.id)}<RequestRow {r} showUser={r.user.id !== page.data.viewer?.id} />{/each}
					</div>
				{:else}
					<p class="px-4 py-8 text-center text-xs text-muted-foreground">You haven’t requested anything yet. <a class="text-primary hover:underline" href="/catalog">Browse what you can request →</a></p>
				{/if}
			</section>
		</div>

		<div class="space-y-6">
			<section class="card overflow-hidden">
				<header class="flex items-center justify-between border-b border-border px-4 py-3">
					<h2 class="text-[0.8125rem] font-semibold">Your access</h2>
					<a href="/access?mine=1" class="text-xs text-muted-foreground hover:text-foreground">{data.myGrants.length} total →</a>
				</header>
				{#if data.myGrants.length}
					<ul class="divide-y divide-border">
						{#each data.myGrants.slice(0, 6) as g (g.id)}
							{@const left = daysLeft(g.expiresAt)}
							<li class="flex items-center gap-3 px-4 py-2.5">
								<ResourceIcon name={g.resource.name} color={g.resource.color} size="size-7" text="text-xs" />
								<div class="min-w-0 flex-1">
									<p class="truncate text-[0.8125rem] font-medium">{g.resource.name}</p>
									<p class="truncate text-xs text-muted-foreground">{g.role.name}</p>
								</div>
								{#if g.status === 'pending_revoke'}
									<span class="badge badge-danger">Being removed</span>
								{:else if left !== null}
									<span class="badge {left <= 7 ? 'badge-warning' : ''}">{left <= 0 ? 'Expiring' : `${left}d left`}</span>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="px-4 py-8 text-center text-xs text-muted-foreground">No access recorded for you yet.</p>
				{/if}
			</section>

			{#if data.org}
				<section class="card overflow-hidden">
					<header class="flex items-center justify-between border-b border-border px-4 py-3">
						<h2 class="text-[0.8125rem] font-semibold">Recent activity</h2>
						<a href="/audit" class="text-xs text-muted-foreground hover:text-foreground">Audit log →</a>
					</header>
					<ul class="space-y-3 px-4 py-3.5">
						{#each data.org.events as e (e.id)}
							<li class="flex gap-2.5 text-xs">
								<span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60"></span>
								<div class="min-w-0">
									<p class="text-foreground/90">{e.summary}</p>
									<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">{displayName(e.actor)} · {ago(e.at)}</p>
								</div>
							</li>
						{:else}
							<li class="text-xs text-muted-foreground">Nothing yet.</li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>
	</div>
</div>

