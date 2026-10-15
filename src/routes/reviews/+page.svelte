<script lang="ts">
	import { goto } from '$app/navigation';
	import { invalidateAll } from '$app/navigation';
	import { CalendarClock, ClipboardCheck, Pencil, Play, Plus, LoaderCircle, Trash2 } from '@lucide/svelte';
	import Switch from '#lib/components/Switch.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import { api, errorMessage, wentForApproval } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { date } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let creating = $state(false);
	let busy = $state(false);
	const quarter = () => {
		const d = new Date();
		return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()} access review`;
	};
	const inTwoWeeks = () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
	let form = $state({ name: '', dueAt: '', resourceIds: [] as string[], privilegedOnly: false, reviewer: 'owner' as 'owner' | 'manager' });

	function open() {
		form = { name: quarter(), dueAt: inTwoWeeks(), resourceIds: [], privilegedOnly: false, reviewer: 'owner' };
		creating = true;
	}

	// ── Review policies ──
	type Policy = (typeof data.policies)[number];
	type PolicyDraft = { id: string | null; name: string; enabled: boolean; frequency: Policy['frequency']; scope: Policy['scope']; resourceIds: string[]; reviewer: Policy['reviewer']; dueDays: number; nextRunAt: string };
	const FREQ = [
		['monthly', 'Monthly'],
		['quarterly', 'Quarterly'],
		['semiannual', 'Every six months'],
		['annual', 'Yearly']
	] as const;
	const today = () => new Date().toISOString().slice(0, 10);
	let editing = $state(false);
	let policy = $state<PolicyDraft>({ id: null, name: '', enabled: true, frequency: 'quarterly', scope: 'all', resourceIds: [], reviewer: 'owner', dueDays: 14, nextRunAt: '' });

	function editPolicy(p?: Policy, preset?: 'quarterly' | 'privileged') {
		policy = p
			? { id: p.id, name: p.name, enabled: p.enabled, frequency: p.frequency, scope: p.scope, resourceIds: [...p.resourceIds], reviewer: p.reviewer, dueDays: p.dueDays, nextRunAt: p.nextRunAt.slice(0, 10) }
			: preset === 'privileged'
				? { id: null, name: 'Monthly privileged access review', enabled: true, frequency: 'monthly', scope: 'privileged', resourceIds: [], reviewer: 'owner', dueDays: 7, nextRunAt: today() }
				: { id: null, name: 'Quarterly access review', enabled: true, frequency: 'quarterly', scope: 'all', resourceIds: [], reviewer: 'owner', dueDays: 14, nextRunAt: today() };
		editing = true;
	}

	async function savePolicy(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const { id, ...body } = policy;
			const r = id ? await api.put(`/api/review-policies/${id}`, body) : await api.post('/api/review-policies', body);
			if (wentForApproval(r)) toast('success', 'Sent to another admin', 'The change applies once a second admin approves it (Settings → Changes).');
			else toast('success', id ? 'Policy saved' : 'Policy added', body.nextRunAt <= today() ? 'The first review starts within a few minutes.' : `The first review starts on ${body.nextRunAt}.`);
			editing = false;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save the policy', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function togglePolicy(p: Policy, enabled: boolean) {
		const { id, description, last, lastRunAt, createdAt, updatedAt, ...rest } = p;
		try {
			const r = await api.put(`/api/review-policies/${id}`, { ...rest, enabled });
			if (wentForApproval(r)) toast('success', 'Sent to another admin', 'It changes once a second admin approves it.');
		} catch (err) {
			toast('error', 'Couldn’t change the policy', errorMessage(err));
		}
		await invalidateAll();
	}

	async function runNow(p: Policy) {
		if (!(await confirmAction({ title: `Start “${p.name}” now?`, body: 'Starts a review with this policy’s scope and reviewers. The schedule stays as it is.', confirmLabel: 'Start review' }))) return;
		try {
			const r = await api.post<{ id: string }>(`/api/review-policies/${p.id}/run`, {});
			goto(`/reviews/${r.id}`);
		} catch (err) {
			toast('error', 'Couldn’t start it', errorMessage(err));
		}
	}

	async function removePolicy(p: Policy) {
		if (!(await confirmAction({ title: `Delete “${p.name}”?`, body: 'No more reviews start on this schedule. Reviews it already started stay, with their evidence.', danger: true, confirmLabel: 'Delete' }))) return;
		const r = await api.del(`/api/review-policies/${p.id}`);
		if (wentForApproval(r)) toast('success', 'Sent to another admin', 'It’s deleted once a second admin approves it.');
		await invalidateAll();
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api.post<{ id: string }>('/api/reviews', form);
			toast('success', 'Review started', 'Reviewers have been notified.');
			goto(`/reviews/${r.id}`);
		} catch (err) {
			toast('error', 'Couldn’t start the review', errorMessage(err));
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Reviews · ac·modern</title></svelte:head>

<PageHeader title="Access reviews" description="Every so often, resource owners confirm who should still have access. Anything revoked gets removed.">
	{#snippet actions()}
		{#if data.admin}<button class="btn btn-primary" onclick={open}><Plus />Start a review</button>{/if}
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	{#if data.admin}
		<section class="card mb-6 p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight"><CalendarClock class="size-4 text-primary" />Review policies</h2>
					<p class="mt-1 max-w-2xl text-xs text-muted-foreground">Reviews that start on their own, monthly or quarterly. Reviewers get a reminder 3 days before the due date, and when a review runs late, they and the admins hear about it every week until it’s done.</p>
				</div>
				<button class="btn btn-secondary" onclick={() => editPolicy()}><Plus />New policy</button>
			</div>
			{#if data.policies.length}
				<ul class="mt-4 divide-y divide-border rounded-xl border border-border">
					{#each data.policies as p (p.id)}
						<li class="flex flex-wrap items-center gap-3 px-3 py-3">
							<div class="min-w-0 flex-1">
								<p class="text-[0.8125rem] font-medium {p.enabled ? '' : 'text-muted-foreground'}">{p.name}{#if !p.enabled}<span class="badge ml-2">Off</span>{/if}</p>
								<p class="mt-0.5 text-xs text-muted-foreground">{p.description}.</p>
								<p class="mt-0.5 text-[0.6875rem] text-muted-foreground/80">
									{p.enabled ? `Next: ${date(p.nextRunAt)}` : 'Paused'}{#if p.last} · Last: <a class="text-primary hover:underline" href="/reviews/{p.last.id}">{p.last.name}</a> ({p.last.status === 'closed' ? 'closed' : `${p.last.decided}/${p.last.total} decided`}){/if}
								</p>
							</div>
							<Switch checked={p.enabled} label="Policy on" onchange={(v) => togglePolicy(p, v)} />
							<button class="btn btn-ghost btn-icon btn-sm" title="Start now" onclick={() => runNow(p)}><Play /></button>
							<button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick={() => editPolicy(p)}><Pencil /></button>
							<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete" onclick={() => removePolicy(p)}><Trash2 /></button>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="mt-4 flex flex-wrap gap-2 rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">
					<span class="mr-auto self-center">No schedule yet. A common setup:</span>
					<button class="btn btn-secondary btn-sm" onclick={() => editPolicy(undefined, 'quarterly')}>Quarterly, all access</button>
					<button class="btn btn-secondary btn-sm" onclick={() => editPolicy(undefined, 'privileged')}>Monthly, privileged access</button>
				</div>
			{/if}
		</section>
	{/if}

	{#if data.reviews.length}
		<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{#each data.reviews as r (r.id)}
				{@const pct = r.total ? Math.round((r.decided / r.total) * 100) : 0}
				{@const overdue = r.status === 'open' && r.dueAt && Date.parse(r.dueAt) < Date.now()}
				<a href="/reviews/{r.id}" class="card block p-4 transition-colors hover:border-primary/40">
					<div class="flex items-start justify-between gap-2">
						<h3 class="text-[0.9375rem] font-semibold tracking-tight">{r.name}</h3>
						{#if r.status === 'closed'}<span class="badge">Closed</span>{:else if overdue}<span class="badge badge-danger">Overdue</span>{:else}<span class="badge badge-primary">Open</span>{/if}
					</div>
					<p class="mt-0.5 text-xs text-muted-foreground">{r.status === 'closed' ? `Closed ${date(r.closedAt)}` : r.dueAt ? `Due ${date(r.dueAt)}` : `Started ${date(r.createdAt)}`}{r.policyName ? ' · scheduled' : ''}{r.scope.scope === 'privileged' ? ' · privileged only' : ''}</p>
					<div class="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary" style="width:{pct}%"></div></div>
					<div class="mt-2 flex justify-between font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
						<span>{r.decided}/{r.total} decided</span>
						<span>{r.revoked} revoked{r.revoked ? ` · ${r.removed} removed` : ''}</span>
					</div>
					{#if data.assigned[r.id]}<p class="mt-3 text-xs font-medium text-primary">{data.assigned[r.id]} waiting on you →</p>{/if}
				</a>
			{/each}
		</div>
	{:else}
		<EmptyState
			icon={ClipboardCheck}
			title={data.admin ? 'No reviews yet' : 'Nothing to review'}
			body={data.admin ? 'A review asks each resource owner to keep or revoke every grant. Quarterly is typical, and auditors (SOC 2, ISO 27001) like to see it.' : 'When a review needs your input, it shows up here.'}
		>
			{#snippet action()}{#if data.admin}<button class="btn btn-primary" onclick={open}><Plus />Start a review</button>{/if}{/snippet}
		</EmptyState>
	{/if}
</div>

<Dialog bind:open={creating} title="Start an access review" description="Each grant goes to its resource’s owner (or first approver) to keep or revoke.">
	<form id="review-form" class="space-y-4" onsubmit={create}>
		<div class="grid grid-cols-[1fr_10rem] gap-3">
			<div>
				<label class="label" for="name">Name</label>
				<input id="name" class="input" bind:value={form.name} required />
			</div>
			<div>
				<label class="label" for="due">Due</label>
				<input id="due" class="input" type="date" bind:value={form.dueAt} />
			</div>
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<div>
				<label class="label" for="rv">Reviewed by</label>
				<select id="rv" class="input" bind:value={form.reviewer}><option value="owner">System owners</option><option value="manager">Each person’s manager</option></select>
			</div>
			<label class="flex items-center gap-2 self-end pb-2 text-[0.8125rem]"><input type="checkbox" class="accent-[var(--primary)]" bind:checked={form.privilegedOnly} />Only privileged access</label>
		</div>
		<fieldset>
			<legend class="label">Resources <span class="font-normal">(none ticked = all)</span></legend>
			<div class="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
				{#each data.resources as r (r.id)}
					<label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] hover:bg-accent/50">
						<input type="checkbox" class="accent-[var(--primary)]" value={r.id} bind:group={form.resourceIds} />
						<ResourceIcon name={r.name} color={r.color} size="size-5" text="text-[0.625rem]" />{r.name}
					</label>
				{/each}
			</div>
		</fieldset>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (creating = false)}>Cancel</button>
		<button class="btn btn-primary" form="review-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Start review</button>
	{/snippet}
</Dialog>

<Dialog bind:open={editing} title={policy.id ? 'Edit review policy' : 'New review policy'} description="A review that starts on its own, on a schedule." width="max-w-xl">
	<form id="policy-form" class="space-y-4" onsubmit={savePolicy}>
		<div>
			<label class="label" for="pn">Name</label>
			<input id="pn" class="input" bind:value={policy.name} required maxlength="80" />
			<p class="mt-1 text-[0.6875rem] text-muted-foreground">Each review is named after it and its period, e.g. “{policy.name || 'Quarterly access review'}: Q4 2026”.</p>
		</div>
		<div class="grid gap-3 sm:grid-cols-3">
			<div>
				<label class="label" for="pf">How often</label>
				<select id="pf" class="input" bind:value={policy.frequency}>{#each FREQ as [v, l] (v)}<option value={v}>{l}</option>{/each}</select>
			</div>
			<div>
				<label class="label" for="pd">First review</label>
				<input id="pd" class="input" type="date" bind:value={policy.nextRunAt} required />
			</div>
			<div>
				<label class="label" for="pdd">Days to finish</label>
				<input id="pdd" class="input" type="number" min="1" max="90" bind:value={policy.dueDays} required />
			</div>
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<div>
				<label class="label" for="ps">What</label>
				<select id="ps" class="input" bind:value={policy.scope}><option value="all">All access</option><option value="privileged">Only privileged access</option></select>
			</div>
			<div>
				<label class="label" for="pr">Reviewed by</label>
				<select id="pr" class="input" bind:value={policy.reviewer}><option value="owner">System owners</option><option value="manager">Each person’s manager</option></select>
			</div>
		</div>
		<fieldset>
			<legend class="label">Systems <span class="font-normal">(none ticked = all, including ones added later)</span></legend>
			<div class="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
				{#each data.resources as r (r.id)}
					<label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] hover:bg-accent/50">
						<input type="checkbox" class="accent-[var(--primary)]" value={r.id} bind:group={policy.resourceIds} />
						<ResourceIcon name={r.name} color={r.color} size="size-5" text="text-[0.625rem]" />{r.name}
					</label>
				{/each}
			</div>
		</fieldset>
		<p class="text-xs text-muted-foreground">Nobody reviews their own access: those items go to the system owner, an approver, or an admin. Changes to policies are in the audit log.</p>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (editing = false)}>Cancel</button>
		<button class="btn btn-primary" form="policy-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}{policy.id ? 'Save' : 'Add policy'}</button>
	{/snippet}
</Dialog>
