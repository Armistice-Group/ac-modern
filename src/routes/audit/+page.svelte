<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { Search, Download, ShieldCheck, ShieldAlert, LoaderCircle, FileJson, Radio } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { ago, date } from '#lib/format.ts';
	import type { Verification } from '#lib/types.ts';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { dateTime, displayName } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let q = $state('');
	$effect(() => {
		q = data.q;
	});

	let verifying = $state(false);
	let result = $state<Verification | null>(null);
	async function verify() {
		verifying = true;
		try {
			result = await api.post<Verification>('/api/audit/verify', {});
			toast(result.ok ? 'success' : 'error', result.ok ? 'Audit log verified' : 'Audit log doesn’t match its seals', result.ok ? `${result.days} sealed days intact.` : undefined);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t verify', errorMessage(err));
		} finally {
			verifying = false;
		}
	}

	const TONE: Record<string, string> = { approved: 'bg-success', created: 'bg-success', denied: 'bg-danger', revoked: 'bg-danger', offboarded: 'bg-danger', webhook_failed: 'bg-danger', revoke: 'bg-warning' };
	const tone = (action: string) => TONE[action.split('.')[1]] ?? 'bg-primary/60';

	function exportCsv() {
		const rows = [['time', 'actor', 'action', 'request', 'summary']];
		for (const e of data.events) rows.push([e.at, e.actor?.email ?? 'system', e.action, e.requestNumber ? `#${e.requestNumber}` : '', e.summary]);
		const csv = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n');
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
	}
</script>

<svelte:head><title>Audit log · ac·modern</title></svelte:head>

<PageHeader title="Audit log" description="Every request, decision, grant and change, newest first.">
	{#snippet actions()}<button class="btn btn-ghost" onclick={exportCsv}><Download />Export CSV</button>{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	<section class="card mb-5 p-4">
		<div class="flex flex-wrap items-center gap-3">
			{#if result && !result.ok}<ShieldAlert class="size-5 text-danger" />{:else}<ShieldCheck class="size-5 text-primary" />{/if}
			<div class="min-w-0 flex-1">
				<h2 class="text-[0.8125rem] font-semibold">Integrity</h2>
				<p class="text-xs text-muted-foreground">
					{#if data.integrity.days}
						Each day’s events are sealed with a chained SHA-256 digest: {data.integrity.days} {data.integrity.days === 1 ? 'day' : 'days'} sealed, {date(data.integrity.firstDay)} to {date(data.integrity.lastSealed)}.
						{#if data.integrity.lastCheck}Last verified {ago(data.integrity.lastCheck.at)}{data.integrity.lastCheck.ok ? ', intact' : ', with mismatches'}.{/if}
					{:else}
						Each day’s events are sealed with a chained SHA-256 digest once the day ends (UTC). The first seal happens tomorrow.
					{/if}
					{#if data.stream}
						<span class="inline-flex items-center gap-1"><Radio class="size-3 {data.stream.lastError ? 'text-danger' : 'text-success'}" />Streaming to {new URL(data.stream.url).host}{data.stream.lastError ? ` (failing: ${data.stream.lastError})` : data.stream.behind ? ` (${data.stream.behind} to send)` : ''}.</span>
					{:else}
						<a class="text-primary hover:underline" href="/settings#audit">Stream it to your own log store</a> to keep a copy outside ac·modern.
					{/if}
				</p>
			</div>
			<a class="btn btn-ghost btn-sm" href="/api/audit/anchors?download" data-sveltekit-reload><FileJson />Download seals</a>
			<button class="btn btn-secondary btn-sm" disabled={verifying} onclick={verify}>{#if verifying}<LoaderCircle class="animate-spin" />{:else}<ShieldCheck />{/if}Verify now</button>
		</div>
		{#if result}
			{#if result.ok}
				<p class="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-success">All {result.days} sealed days match their seals{result.unsealed ? `; ${result.unsealed} newer events are sealed after their day ends` : ''}.</p>
			{:else}
				<ul class="mt-3 space-y-1 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs">
					{#each result.broken as b (b.day + b.reason)}<li><span class="font-mono text-danger">{b.day}</span> {b.reason}</li>{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<form class="relative mb-4 max-w-sm" onsubmit={(e) => (e.preventDefault(), goto(q ? `?q=${encodeURIComponent(q)}` : '?', { reset: false }))}>
		<Search class="pointer-events-none absolute top-2 left-3 size-4 text-muted-foreground" />
		<input class="input h-8 pl-9 text-xs" placeholder="Search events…" bind:value={q} />
	</form>
	<div class="card overflow-x-auto">
		<table class="w-full text-[0.8125rem]">
			<thead>
				<tr class="border-b border-border text-left text-xs text-muted-foreground">
					<th class="px-4 py-2.5 font-medium">When</th>
					<th class="px-4 py-2.5 font-medium">Who</th>
					<th class="px-4 py-2.5 font-medium">What</th>
					<th class="px-4 py-2.5 font-medium">Action</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border">
				{#each data.events as e (e.id)}
					<tr class="align-top">
						<td class="px-4 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground" title={e.at}>{dateTime(e.at)}</td>
						<td class="px-4 py-2.5 text-xs whitespace-nowrap">{displayName(e.actor)}</td>
						<td class="px-4 py-2.5">
							<span class="flex items-start gap-2">
								<span class="mt-1.5 size-1.5 shrink-0 rounded-full {tone(e.action)}"></span>
								<span>{e.summary}{#if e.requestNumber} <a class="font-mono text-xs text-primary hover:underline" href="/requests/{e.requestNumber}">#{e.requestNumber}</a>{/if}</span>
							</span>
						</td>
						<td class="px-4 py-2.5 font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground">{e.action}</td>
					</tr>
				{:else}
					<tr><td colspan="4" class="px-4 py-10 text-center text-xs text-muted-foreground">No events{data.q ? ` matching “${data.q}”` : ''}.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if data.more}
		<div class="mt-4 text-center"><a class="btn btn-secondary btn-sm" href="?{new URLSearchParams({ ...(data.q ? { q: data.q } : {}), before: data.more })}">Older events</a></div>
	{/if}
</div>
