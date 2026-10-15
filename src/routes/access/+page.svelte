<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { KeyRound, Search, Plus, LoaderCircle, Download, RefreshCw } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import PeoplePicker from '#lib/components/PeoplePicker.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { date, daysLeft, displayName } from '#lib/format.ts';
	import type { Grant } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const me = $derived(page.data.viewer?.id);
	const admin = $derived(page.data.viewer?.role !== 'member');
	let q = $state('');
	$effect(() => {
		q = data.filters.q;
	});

	function nav(patch: Record<string, string>) {
		const u = new URL(page.url.href);
		for (const [k, v] of Object.entries(patch)) v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
		goto(u, { reset: false, replace: true });
	}

	async function revoke(g: Grant) {
		const own = g.user.id === me;
		const ok = await confirmAction({
			title: own ? `Give up ${g.resource.name} (${g.role.name})?` : `Revoke ${displayName(g.user)}’s ${g.resource.name} access?`,
			body: own
				? 'A removal request goes to whoever manages this tool. Request it again any time.'
				: 'This opens a removal request. The access is marked removed once someone confirms it’s gone (or the webhook does).',
			confirmLabel: own ? 'Give it up' : 'Revoke',
			danger: true
		});
		if (!ok) return;
		try {
			const r = await api.post<{ number: number | null }>(`/api/grants/${g.id}/revoke`, {});
			toast('success', 'Removal started', r.number ? `Request #${r.number}` : undefined);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t revoke', errorMessage(err));
		}
	}

	// ── Record existing access ──
	let recording = $state(false);
	let rec = $state({ resourceId: '', roleId: '', userIds: [] as string[], expiresAt: '', note: '' });
	let recBusy = $state(false);
	const recResource = $derived(data.resources.find((r) => r.id === rec.resourceId));
	$effect(() => {
		if (page.url.searchParams.get('record') === '1' && admin) recording = true;
	});

	async function saveRecord(e: SubmitEvent) {
		e.preventDefault();
		recBusy = true;
		try {
			const r = await api.post<{ created: number; skipped: string[] }>('/api/grants', rec);
			toast('success', `Recorded ${r.created} ${r.created === 1 ? 'grant' : 'grants'}`, r.skipped.length ? `Skipped: ${r.skipped.join('; ')}` : undefined);
			recording = false;
			rec = { resourceId: rec.resourceId, roleId: '', userIds: [], expiresAt: '', note: '' };
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t record that', errorMessage(err));
		} finally {
			recBusy = false;
		}
	}

	function exportCsv() {
		const rows = [['person', 'email', 'resource', 'access level', 'status', 'source', 'granted', 'expires']];
		for (const g of data.grants) rows.push([g.user.name, g.user.email, g.resource.name, g.role.name, g.status, g.source, g.grantedAt, g.expiresAt ?? '']);
		const csv = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n');
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		a.download = `access-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
	}
</script>

<svelte:head><title>Access · ac·modern</title></svelte:head>

<PageHeader title="Access" description={data.mine ? 'What you have, and until when.' : 'Who has what, right now.'}>
	{#snippet actions()}
		{#if data.grants.length}<button class="btn btn-ghost" onclick={exportCsv}><Download />Export CSV</button>{/if}
		{#if admin}<button class="btn btn-secondary" onclick={() => (recording = true)}><Plus />Record existing access</button>{/if}
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	<div class="mb-4 flex flex-wrap items-center gap-2">
		{#if data.canSeeOthers}
			<div class="flex rounded-xl border border-border bg-surface p-0.5">
				{#each [{ v: '', l: admin ? 'Everyone' : 'My resources' }, { v: '1', l: 'Mine' }] as t (t.v)}
					<button class="h-7 rounded-lg px-3 text-xs font-medium transition-colors {(t.v === '1') === data.mine ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}" onclick={() => nav({ mine: t.v })}>{t.l}</button>
				{/each}
			</div>
		{/if}
		<select class="input h-8 w-auto text-xs" value={data.filters.resourceId} onchange={(e) => nav({ resource: e.currentTarget.value })}>
			<option value="">All resources</option>
			{#each data.resources as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
		</select>
		<select class="input h-8 w-auto text-xs" value={String(data.filters.expiring ?? '')} onchange={(e) => nav({ expiring: e.currentTarget.value })}>
			<option value="">Any expiry</option>
			<option value="7">Expiring in 7 days</option>
			<option value="30">Expiring in 30 days</option>
		</select>
		{#if data.canSeeOthers && !data.mine}
			<label class="flex items-center gap-1.5 text-xs text-muted-foreground" title="Who had access at the end of this day, including access removed since">
				As of
				<input type="date" class="input h-8 w-auto text-xs" value={data.filters.asOf} max={new Date().toISOString().slice(0, 10)} onchange={(e) => nav({ asOf: e.currentTarget.value })} />
			</label>
		{/if}
		<form class="relative w-full max-w-xs" onsubmit={(e) => (e.preventDefault(), nav({ q }))}>
			<Search class="pointer-events-none absolute top-2 left-3 size-4 text-muted-foreground" />
			<input class="input h-8 pl-9 text-xs" placeholder="Person, resource or level" bind:value={q} />
		</form>
		<span class="ml-auto font-mono text-xs text-muted-foreground">{data.grants.length} {data.grants.length === 1 ? 'grant' : 'grants'}</span>
	</div>

	{#if data.filters.asOf}
		<p class="mb-3 rounded-xl border border-primary/30 bg-primary-soft px-3 py-2 text-xs text-primary">Showing who had access at the end of {data.filters.asOf}, including access removed since. <button class="underline" onclick={() => nav({ asOf: '' })}>Back to now</button></p>
	{/if}
	{#if data.grants.length}
		<div class="card overflow-x-auto">
			<table class="w-full text-[0.8125rem]">
				<thead>
					<tr class="border-b border-border text-left text-xs text-muted-foreground">
						{#if !data.mine}<th class="px-4 py-2.5 font-medium">Person</th>{/if}
						<th class="px-4 py-2.5 font-medium">Resource</th>
						<th class="px-4 py-2.5 font-medium">Since</th>
						<th class="px-4 py-2.5 font-medium">Ends</th>
						<th class="px-4 py-2.5 font-medium">Source</th>
						<th class="px-4 py-2.5"></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each data.grants as g (g.id)}
						{@const left = daysLeft(g.expiresAt)}
						<tr class="transition-colors hover:bg-accent/30">
							{#if !data.mine}
								<td class="px-4 py-2.5">
									<a href={admin ? `/people/${g.user.id}` : undefined} class="flex items-center gap-2 {admin ? 'hover:text-primary' : ''}"><Avatar user={g.user} size="size-6" /><span class="truncate">{displayName(g.user)}</span></a>
								</td>
							{/if}
							<td class="px-4 py-2.5">
								<div class="flex items-center gap-2.5">
									<ResourceIcon name={g.resource.name} color={g.resource.color} size="size-6" text="text-[0.6875rem]" />
									<span class="font-medium">{g.resource.name}</span>
									<span class="text-muted-foreground">{g.role.name}</span>
								</div>
							</td>
							<td class="px-4 py-2.5 text-xs whitespace-nowrap text-muted-foreground">{date(g.grantedAt)}</td>
							<td class="px-4 py-2.5 text-xs whitespace-nowrap">
								{#if g.status === 'pending_revoke'}<span class="badge badge-danger">Being removed</span>
								{:else if left === null}<span class="text-muted-foreground">Never</span>
								{:else}<span class={left <= 7 ? 'text-warning' : 'text-muted-foreground'} title={g.expiresAt}>{date(g.expiresAt)} · {left <= 0 ? 'today' : `${left}d`}</span>{/if}
							</td>
							<td class="px-4 py-2.5 text-xs whitespace-nowrap text-muted-foreground">
								{#if g.requestNumber}<a href="/requests/{g.requestNumber}" class="font-mono hover:text-primary">#{g.requestNumber}</a>{:else}{g.source === 'import' ? 'Recorded' : 'Manual'}{/if}
							</td>
							<td class="px-4 py-2.5 text-right whitespace-nowrap">
								{#if g.status === 'active'}
									{#if g.user.id === me && g.expiresAt}
										<a class="btn btn-ghost btn-sm" href="/catalog?resource={g.resource.id}&role={g.role.id}" title="Request more time"><RefreshCw />Extend</a>
									{/if}
									{#if g.user.id === me || admin || data.stewarded.includes(g.resource.id)}
										<button class="btn btn-ghost btn-sm text-danger hover:text-danger" onclick={() => revoke(g)}>{g.user.id === me ? 'Give up' : 'Revoke'}</button>
									{/if}
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<EmptyState
			icon={KeyRound}
			title={data.mine ? 'You don’t have any access recorded' : 'No access recorded yet'}
			body={data.mine ? 'Request what you need from the catalog.' : 'Access shows up here once requests are set up, or when you record what people already have.'}
		>
			{#snippet action()}
				{#if admin && !data.mine}<button class="btn btn-primary" onclick={() => (recording = true)}><Plus />Record existing access</button>
				{:else}<a href="/catalog" class="btn btn-primary">Browse the catalog</a>{/if}
			{/snippet}
		</EmptyState>
	{/if}
</div>

<Dialog bind:open={recording} title="Record existing access" description="Already set up outside ac·modern? Record it so it shows up in reviews and offboarding. It skips approval, so it’s listed separately in the audit evidence.">
	<form id="record-form" class="space-y-4" onsubmit={saveRecord}>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="res">Resource</label>
				<select id="res" class="input" bind:value={rec.resourceId} onchange={() => (rec.roleId = recResource?.roles[0]?.id ?? '')} required>
					<option value="" disabled>Choose…</option>
					{#each data.resources as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
				</select>
			</div>
			<div>
				<label class="label" for="role">Access level</label>
				<select id="role" class="input" bind:value={rec.roleId} required disabled={!recResource}>
					{#each recResource?.roles ?? [] as role (role.id)}<option value={role.id}>{role.name}</option>{/each}
				</select>
			</div>
		</div>
		<div>
			<span class="label">People</span>
			<PeoplePicker people={data.people} bind:selected={rec.userIds} placeholder="Who has it?" />
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="exp">Ends <span class="font-normal">(optional)</span></label>
				<input id="exp" class="input" type="date" bind:value={rec.expiresAt} />
			</div>
			<div>
				<label class="label" for="note">Where it came from</label>
				<input id="note" class="input" placeholder="e.g. Granted before ac·modern (IT sheet)" bind:value={rec.note} required minlength="3" />
			</div>
		</div>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (recording = false)}>Cancel</button>
		<button class="btn btn-primary" form="record-form" disabled={recBusy || !rec.userIds.length || !rec.roleId}>{#if recBusy}<LoaderCircle class="animate-spin" />{/if}Record {rec.userIds.length || ''} {rec.userIds.length === 1 ? 'grant' : 'grants'}</button>
	{/snippet}
</Dialog>
