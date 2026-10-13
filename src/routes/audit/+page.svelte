<script lang="ts">
	import { goto } from '$app/navigation';
	import { Search, Download } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { dateTime, displayName } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let q = $state('');
	$effect(() => {
		q = data.q;
	});

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
