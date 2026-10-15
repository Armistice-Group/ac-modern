<script lang="ts">
	import BrandLogo from '#lib/components/BrandLogo.svelte';
	import { goto } from '$app/navigation';
	import { ArrowLeft, CloudDownload, FileUp, GitCompareArrows, LoaderCircle } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { dateTime } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let csv = $state('');
	let filename = $state('');
	let busy = $state<'csv' | 'idp' | null>(null);

	async function pick(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		filename = file.name;
		csv = await file.text();
	}

	async function run(source: 'csv' | 'idp') {
		busy = source;
		try {
			const r = await api.post<{ id: string }>(`/api/resources/${data.resource.id}/reconcile`, source === 'csv' ? { source, csv, filename } : { source });
			goto(`/resources/${data.resource.id}/reconcile/${r.id}`);
		} catch (err) {
			toast('error', 'Couldn’t reconcile', errorMessage(err));
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Reconcile {data.resource.name} · ac·modern</title></svelte:head>

<PageHeader title="Reconcile {data.resource.name}" description="Compare who actually has an account in {data.resource.name} with the access ac·modern records, so every account is approved and every record is real.">
	{#snippet actions()}
		<a href="/resources/{data.resource.id}" class="btn btn-ghost"><ArrowLeft />{data.resource.name}</a>
	{/snippet}
</PageHeader>

<div class="max-w-4xl space-y-6 px-8 pb-10">
	<div class="grid gap-4 {data.pullFrom ? 'md:grid-cols-2' : ''}">
		<section class="card p-5">
			<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight"><FileUp class="size-4 text-primary" />Upload the user list</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				Export the users from {data.resource.name}’s admin console as CSV. ac·modern finds the email or username column, and a role or level column if there is one, so levels are compared too.
			</p>
			<label class="btn btn-secondary mt-3 cursor-pointer">
				<FileUp />{filename || 'Choose a CSV file'}
				<input type="file" accept=".csv,.tsv,.txt,text/csv" class="hidden" onchange={pick} />
			</label>
			<textarea class="input mt-3 h-28 resize-y py-2 font-mono text-[0.6875rem]" placeholder={'Or paste it:\nemail,role\nana@acme.com,Admin'} bind:value={csv} oninput={() => (filename ||= 'pasted list')}></textarea>
			<button class="btn btn-primary mt-3" disabled={!csv.trim() || !!busy} onclick={() => run('csv')}>{#if busy === 'csv'}<LoaderCircle class="animate-spin" />{:else}<GitCompareArrows />{/if}Compare</button>
		</section>
		{#if data.pullFrom}
			<section class="card p-5">
				<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">{#if data.pullKind}<BrandLogo brand={data.pullKind} class="size-4" />{:else}<CloudDownload class="size-4 text-primary" />{/if}Pull from {data.pullFrom}</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					{data.resource.name}’s access levels are set up through {data.pullFrom}. ac·modern reads who’s in each level’s group right now and compares. Nothing is changed in {data.pullFrom}.
				</p>
				<button class="btn btn-primary mt-3" disabled={!!busy} onclick={() => run('idp')}>{#if busy === 'idp'}<LoaderCircle class="animate-spin" />{:else}<CloudDownload />{/if}Pull and compare</button>
			</section>
		{/if}
	</div>

	<section class="card overflow-hidden">
		<header class="border-b border-border px-4 py-3"><h2 class="text-[0.8125rem] font-semibold">Past reconciliations <span class="font-normal text-muted-foreground">· {data.runs.length}</span></h2></header>
		<ul class="divide-y divide-border">
			{#each data.runs as r (r.id)}
				<li>
					<a href="/resources/{data.resource.id}/reconcile/{r.id}" class="flex flex-wrap items-center gap-3 px-4 py-3 text-[0.8125rem] hover:bg-accent/40">
						<span class="w-40 text-xs text-muted-foreground">{dateTime(r.createdAt)}</span>
						<span class="flex-1 truncate">{r.source === 'csv' ? r.filename || 'Uploaded list' : `Pulled from ${data.pullFrom ?? 'the IdP'}`} <span class="text-xs text-muted-foreground">· {r.runBy?.name || r.runBy?.email || '—'}</span></span>
						<span class="font-mono text-xs text-muted-foreground tabular-nums">{r.counts.accounts} accounts · {r.counts.matched} matched</span>
						{#if r.unresolved}<span class="badge badge-warning">{r.unresolved} to resolve</span>{:else if r.counts.unknown + r.counts.missing + r.counts.level_mismatch}<span class="badge badge-success">Resolved</span>{:else}<span class="badge badge-success">All matched</span>{/if}
					</a>
				</li>
			{:else}
				<li class="px-4 py-8 text-center text-xs text-muted-foreground">Not reconciled yet. Auditors usually expect it at least as often as access reviews.</li>
			{/each}
		</ul>
	</section>
</div>
