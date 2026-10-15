<script lang="ts">
	import { Download, UserMinus } from '@lucide/svelte';
	import { date, dateTime } from '#lib/format.ts';
	import type { Leaver } from '#lib/types.ts';

	let { rows, slaHours, csvHref }: { rows: Leaver[]; slaHours: number; csvHref: string } = $props();
	const late = $derived(rows.filter((r) => r.onTime === false).length);
</script>

<section class="card overflow-hidden">
	<header class="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
		<div>
			<h2 class="flex items-center gap-2 text-[0.8125rem] font-semibold"><UserMinus class="size-4 text-primary" />Leavers <span class="font-normal text-muted-foreground">· {rows.length}</span>{#if late}<span class="badge badge-danger">{late} late</span>{/if}</h2>
			<p class="text-[0.6875rem] text-muted-foreground">People offboarded or deactivated in this period, and how long their access took to remove (target: {slaHours} hours from the end of their last day).</p>
		</div>
		<a class="btn btn-ghost btn-sm" href={csvHref} data-sveltekit-reload><Download />CSV</a>
	</header>
	{#if rows.length}
		<div class="overflow-x-auto">
			<table class="w-full text-left text-xs">
				<thead class="text-[0.6875rem] text-muted-foreground">
					<tr class="border-b border-border"><th class="px-4 py-2 font-medium">Person</th><th class="px-2 py-2 font-medium">Last day</th><th class="px-2 py-2 font-medium">Offboarded</th><th class="px-2 py-2 font-medium">Removed</th><th class="px-2 py-2 font-medium">Time to remove</th><th class="px-4 py-2 font-medium"></th></tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each rows as r (r.userId + r.at)}
						<tr>
							<td class="px-4 py-2"><a class="font-medium hover:underline" href="/people/{r.userId}">{r.name || r.email}</a><p class="text-[0.6875rem] text-muted-foreground">{r.how === 'deactivated' ? 'Deactivated' : 'Offboarded'} by {r.by}</p></td>
							<td class="px-2 py-2 whitespace-nowrap">{r.leftAt ? date(r.leftAt) : '—'}</td>
							<td class="px-2 py-2 whitespace-nowrap" title={r.at}>{dateTime(r.at)}</td>
							<td class="px-2 py-2 font-mono tabular-nums">{r.removed}/{r.removals}{#if r.pending}<span class="text-warning"> · {r.pending} pending</span>{/if}</td>
							<td class="px-2 py-2 font-mono tabular-nums">{r.hours} h</td>
							<td class="px-4 py-2 text-right whitespace-nowrap">
								{#if r.stillActive && !r.pending}<span class="badge badge-danger">{r.stillActive} still active</span>
								{:else if r.onTime === true}<span class="badge badge-success">On time</span>
								{:else if r.onTime === false}<span class="badge badge-danger">Late</span>
								{:else}<span class="badge badge-warning">In progress</span>{/if}
								{#if r.grantedAfter}<span class="badge badge-danger ml-1">Granted after leaving</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="px-4 py-6 text-center text-xs text-muted-foreground">Nobody left in this period.</p>
	{/if}
</section>
