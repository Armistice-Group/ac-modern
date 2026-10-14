<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Check, X, Wrench, Ban, RotateCw, MessageSquare, ExternalLink, LoaderCircle, Circle, CircleCheck, CircleX, CircleDot, Webhook, Send, ShieldAlert, FileCheck2 } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import StatusBadge from '#lib/components/StatusBadge.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { ago, APPROVAL_LABEL, CAPACITY, CATEGORY, date, dateTime, displayName, duration, EXCEPTION_CAPACITIES, REASON } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const r = $derived(data.req);
	let note = $state('');
	let comment = $state('');
	let busy = $state<string | null>(null);

	async function act(action: string, body: Record<string, unknown> = {}, success?: string) {
		busy = action;
		try {
			await api.post(`/api/requests/${r.id}/${action}`, body);
			if (success) toast('success', success);
			note = '';
			if (action === 'comment') comment = '';
			await invalidateAll();
		} catch (err) {
			toast('error', 'That didn’t work', errorMessage(err));
		} finally {
			busy = null;
		}
	}

	async function cancel() {
		const ok = await confirmAction({
			title: r.kind === 'grant' ? `Cancel request #${r.number}?` : `Keep ${displayName(r.user)}’s access?`,
			body: r.kind === 'grant' ? 'Approvers won’t be asked any more.' : 'The removal is called off and the access stays in place.',
			confirmLabel: r.kind === 'grant' ? 'Cancel request' : 'Keep access',
			danger: r.kind === 'grant'
		});
		if (ok) act('cancel', {}, 'Cancelled');
	}

	type Stage = { label: string; detail?: string; state: 'done' | 'current' | 'todo' | 'failed'; exception?: boolean };
	const stages = $derived.by((): Stage[] => {
		const out: Stage[] = [{ label: r.kind === 'grant' ? 'Requested' : 'Removal opened', detail: dateTime(r.createdAt), state: 'done' }];
		const denied = r.status === 'denied';
		if (r.kind === 'grant') {
			data.steps.forEach((s, i) => {
				const step = i + 1;
				const decided = data.evidence.approvals.find((a) => a.step === step);
				const state: Stage['state'] = decided ? (decided.decision === 'denied' ? 'failed' : 'done') : r.status === 'pending_approval' && r.step === step ? 'current' : r.step > step ? 'done' : 'todo';
				out.push({
					label: s === 'manager' ? 'Manager approval' : 'System owner / approver',
					detail: decided
						? `${decided.approver.name || decided.approver.email} as ${CAPACITY[decided.capacity].toLowerCase()} · ${ago(decided.at)}`
						: state === 'current'
							? data.approvers.map(displayName).join(', ')
							: undefined,
					state,
					exception: !!decided && EXCEPTION_CAPACITIES.includes(decided.capacity)
				});
			});
		}
		if (!denied) {
			out.push({
				label: r.kind === 'grant' ? (data.resource.fulfillment === 'webhook' ? 'Set up automatically' : 'Set up') : 'Removed',
				detail: r.status === 'pending_fulfillment' ? data.fulfillers.map(displayName).join(', ') : r.status === 'completed' ? ago(r.closedAt) : undefined,
				state: r.status === 'completed' ? 'done' : r.status === 'pending_fulfillment' ? 'current' : r.status === 'cancelled' ? 'failed' : 'todo'
			});
		}
		return out;
	});

	const ICON: Record<string, typeof Check> = {
		'request.approved': CircleCheck,
		'request.denied': CircleX,
		'request.cancelled': Ban,
		'grant.created': CircleCheck,
		'grant.revoked': CircleCheck,
		'request.webhook_failed': Webhook
	};
	const TONE: Record<string, string> = {
		'request.approved': 'text-success',
		'grant.created': 'text-success',
		'grant.revoked': 'text-success',
		'request.denied': 'text-danger',
		'request.webhook_failed': 'text-danger'
	};
</script>

<svelte:head><title>#{r.number} {r.resource.name} · ac·modern</title></svelte:head>

<PageHeader title="{r.kind === 'revoke' ? 'Remove ' : ''}{r.resource.name} · {r.role.name}" description="#{r.number} · {r.kind === 'grant' ? 'for' : 'from'} {displayName(r.user)}">
	{#snippet actions()}
		<span class="badge {r.category === 'new_hire' ? 'badge-primary' : ''}">{CATEGORY[r.category]}</span>
		{#if r.privileged}<span class="badge badge-warning"><ShieldAlert />Privileged</span>{/if}
		<StatusBadge status={r.status} kind={r.kind} />
		{#if data.admin}<a href="/evidence/print?numbers={r.number}" target="_blank" class="btn btn-secondary btn-sm"><FileCheck2 />Evidence</a>{/if}
		{#if data.resource.url}<a href={data.resource.url} target="_blank" rel="noreferrer" class="btn btn-secondary btn-sm"><ExternalLink />Open {data.resource.name}</a>{/if}
	{/snippet}
</PageHeader>

<div class="grid gap-6 px-8 pb-10 lg:grid-cols-[22rem_minmax(0,1fr)]">
	<div class="space-y-4">
		{#if data.can.approve || data.can.fulfill}
			<section class="card border-primary/40 p-4 shadow-[0_0_0_3px_var(--primary-soft)]">
				{#if data.can.approve}
					<h2 class="text-[0.8125rem] font-semibold">Your approval</h2>
					<p class="mt-0.5 text-xs text-muted-foreground">
						{#if data.approverVia === 'self'}Nobody else can approve this, so you can approve your own request. It’s noted in the audit log.
						{:else if !data.approvers.some((a) => a.id === page.data.viewer?.id)}You’re approving as an admin, on behalf of {data.approvers.map(displayName).join(', ')}.
						{:else}Approve if {displayName(r.user)} should have {r.role.name} access{r.durationDays ? ` for ${duration(r.durationDays).toLowerCase()}` : ''}.{/if}
					</p>
					<textarea class="input mt-3 h-16 resize-none py-2 text-[0.8125rem]" placeholder="Note (required to deny)" bind:value={note}></textarea>
					<div class="mt-3 flex gap-2">
						<button class="btn btn-primary flex-1" disabled={!!busy} onclick={() => act('approve', { comment: note }, `Approved #${r.number}`)}>
							{#if busy === 'approve'}<LoaderCircle class="animate-spin" />{:else}<Check />{/if}Approve
						</button>
						<button class="btn btn-danger-outline flex-1" disabled={!!busy} onclick={() => act('deny', { comment: note }, `Denied #${r.number}`)}><X />Deny</button>
					</div>
				{:else}
					<h2 class="text-[0.8125rem] font-semibold">{r.kind === 'grant' ? 'Set up this access' : 'Remove this access'}</h2>
					<p class="mt-0.5 text-xs text-muted-foreground">
						{r.kind === 'grant' ? 'Give' : 'Remove'}
						<span class="font-medium text-foreground">{r.user.email}</span>
						{r.kind === 'grant' ? '' : '’s'}
						<span class="font-medium text-foreground">{r.role.name}</span> in {r.resource.name}, then mark it done.
					</p>
					<input class="input mt-3 text-[0.8125rem]" placeholder="Note (optional), e.g. invited to the org" bind:value={note} />
					<div class="mt-3 flex gap-2">
						<button class="btn btn-primary flex-1" disabled={!!busy} onclick={() => act('complete', { comment: note }, r.kind === 'grant' ? 'Marked as set up' : 'Marked as removed')}>
							{#if busy === 'complete'}<LoaderCircle class="animate-spin" />{:else}<Wrench />{/if}Mark done
						</button>
						{#if data.resource.fulfillment === 'webhook'}
							<button class="btn btn-secondary" disabled={!!busy} title="Call the webhook again" onclick={() => act('retry', {}, '')}><RotateCw />Retry webhook</button>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		<section class="card p-4">
			<h2 class="mb-3 text-[0.8125rem] font-semibold">Progress</h2>
			<ol class="relative space-y-4">
				{#each stages as s, i (i)}
					<li class="relative flex gap-3">
						{#if i < stages.length - 1}<span class="absolute top-5 bottom-[-1rem] left-[0.4375rem] w-px bg-border"></span>{/if}
						<span class="relative mt-0.5">
							{#if s.state === 'done'}<CircleCheck class="size-4 text-success" />
							{:else if s.state === 'failed'}<CircleX class="size-4 text-danger" />
							{:else if s.state === 'current'}<CircleDot class="size-4 text-primary" />
							{:else}<Circle class="size-4 text-muted-foreground/50" />{/if}
						</span>
						<div class="min-w-0">
							<p class="text-[0.8125rem] {s.state === 'todo' ? 'text-muted-foreground' : 'font-medium'}">{s.label}</p>
							{#if s.detail}<p class="text-xs {s.exception ? 'text-danger' : 'text-muted-foreground'}">{s.state === 'current' ? 'Waiting on ' : ''}{s.detail}</p>{/if}
						</div>
					</li>
				{/each}
			</ol>
		</section>

		<section class="card divide-y divide-border text-[0.8125rem]">
			<div class="flex items-center gap-3 p-4">
				<ResourceIcon name={r.resource.name} color={r.resource.color} size="size-9" />
				<div class="min-w-0">
					<p class="font-medium">{r.resource.name}</p>
					<p class="text-xs text-muted-foreground">{r.role.name}</p>
				</div>
			</div>
			<dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 p-4 text-xs">
				<dt class="text-muted-foreground">{r.kind === 'grant' ? 'For' : 'From'}</dt>
				<dd class="flex items-center gap-1.5 truncate"><Avatar user={r.user} size="size-4" />{displayName(r.user)}</dd>
				{#if r.requester && r.requester.id !== r.user.id}
					<dt class="text-muted-foreground">Requested by</dt>
					<dd class="truncate">{displayName(r.requester)}</dd>
				{/if}
				{#if r.kind === 'grant'}
					<dt class="text-muted-foreground">Duration</dt>
					<dd>{duration(r.durationDays)}</dd>
				{:else}
					<dt class="text-muted-foreground">Reason</dt>
					<dd>{REASON[r.reason]}</dd>
				{/if}
				{#if data.grant && r.kind === 'grant' && r.status === 'completed'}
					<dt class="text-muted-foreground">Access ends</dt>
					<dd>{data.grant.status === 'revoked' ? 'Removed' : data.grant.expiresAt ? date(data.grant.expiresAt) : 'Never'}</dd>
				{/if}
				<dt class="text-muted-foreground">Opened</dt>
				<dd title={r.createdAt}>{dateTime(r.createdAt)}</dd>
				{#if r.closedAt}
					<dt class="text-muted-foreground">Closed</dt>
					<dd title={r.closedAt}>{dateTime(r.closedAt)}</dd>
				{/if}
				<dt class="text-muted-foreground">Approval rule</dt>
				<dd>{APPROVAL_LABEL[r.policy]}{#if r.privileged && r.policy !== data.resource.approval} <span class="text-muted-foreground">(privileged)</span>{/if}</dd>
				{#if data.evidence.snapshot.manager}
					<dt class="text-muted-foreground">Manager then</dt>
					<dd class="truncate">{data.evidence.snapshot.manager.name || data.evidence.snapshot.manager.email}</dd>
				{/if}
				<dt class="text-muted-foreground">Set up</dt>
				<dd>{data.resource.fulfillment === 'webhook' ? 'Webhook' : 'By hand'}</dd>
			</dl>
			{#if data.can.cancel}
				<div class="p-3">
					<button class="btn btn-ghost btn-sm w-full" onclick={cancel}><Ban />{r.kind === 'grant' ? 'Cancel request' : 'Call off removal'}</button>
				</div>
			{/if}
		</section>
	</div>

	<div class="space-y-4">
		{#if r.justification}
			<section class="card p-5">
				<p class="text-xs font-medium text-muted-foreground">{r.kind === 'grant' ? 'Why they need it' : 'Note'}</p>
				<p class="mt-1.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap">{r.justification}</p>
			</section>
		{/if}

		<section class="card">
			<header class="border-b border-border px-5 py-3"><h2 class="text-[0.8125rem] font-semibold">Activity</h2></header>
			<ol class="space-y-4 px-5 py-4">
				{#each data.timeline as e (e.id)}
					{@const Icon = ICON[e.action]}
					<li class="flex gap-3">
						{#if e.action === 'request.comment'}
							<Avatar user={e.actor ?? { name: 'System', email: '' }} size="size-6" />
							<div class="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3.5 py-2.5">
								<p class="text-xs"><span class="font-medium">{displayName(e.actor)}</span> <span class="text-muted-foreground">· {ago(e.at)}</span></p>
								<p class="mt-1 text-[0.8125rem] whitespace-pre-wrap">{e.summary}</p>
							</div>
						{:else}
							<span class="grid size-6 shrink-0 place-items-center">
								{#if Icon}<Icon class="size-4 {TONE[e.action] ?? 'text-muted-foreground'}" />{:else}<span class="size-1.5 rounded-full bg-muted-foreground/60"></span>{/if}
							</span>
							<div class="min-w-0 flex-1 pt-0.5">
								<p class="text-[0.8125rem]">{e.summary}</p>
								{#if e.data.comment || e.data.note}<p class="mt-1 border-l-2 border-border pl-2.5 text-xs text-muted-foreground">“{e.data.comment || e.data.note}”</p>{/if}
								<p class="mt-0.5 text-[0.6875rem] text-muted-foreground" title={e.at}>{displayName(e.actor)} · {ago(e.at)}</p>
							</div>
						{/if}
					</li>
				{/each}
			</ol>
			{#if data.can.comment}
				<form class="flex items-end gap-2 border-t border-border p-4" onsubmit={(e) => (e.preventDefault(), act('comment', { comment }))}>
					<div class="relative flex-1">
						<MessageSquare class="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
						<input class="input pl-9" placeholder="Add a comment…" bind:value={comment} />
					</div>
					<button class="btn btn-secondary" disabled={!comment.trim() || !!busy}><Send />Send</button>
				</form>
			{/if}
		</section>
	</div>
</div>
