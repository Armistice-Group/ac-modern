<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Copy, KeyRound, LoaderCircle, Trash2, FileJson } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { ago, date } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let creating = $state(false);
	let name = $state('');
	let expires = $state('365');
	let token = $state('');
	let busy = $state(false);
	const copy = (v: string) => (navigator.clipboard.writeText(v), toast('success', 'Copied'));

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			token = (await api.post<{ token: string }>('/api/settings/tokens', { name, expiresDays: expires ? Number(expires) : null })).token;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t create the token', errorMessage(err));
		} finally {
			busy = false;
		}
	}
	async function revoke(t: { id: string; name: string }) {
		if (!(await confirmAction({ title: `Revoke “${t.name}”?`, body: 'Anything using it stops working immediately.', danger: true, confirmLabel: 'Revoke' }))) return;
		await api.del(`/api/settings/tokens/${t.id}`);
		await invalidateAll();
	}
	const example = $derived(`curl -H "Authorization: Bearer acm_…" \\\n  "${data.base}/requests?from=2026-01-01&to=2026-12-31&type=new_hire,transfer"`);
</script>

<svelte:head><title>API · ac·modern</title></svelte:head>

<div class="max-w-3xl space-y-6 px-8 pb-10">
	<section class="card p-5">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-[0.9375rem] font-semibold tracking-tight">API tokens</h2>
				<p class="mt-1 text-xs text-muted-foreground">Read-only access to people, systems, access, requests with approvals, reviews and the audit log, for your GRC tool (Vanta, Drata, Secureframe) or scripts.</p>
			</div>
			<button class="btn btn-primary" onclick={() => ((creating = true), (name = ''), (token = ''))}><KeyRound />New token</button>
		</div>
		<ul class="mt-4 divide-y divide-border rounded-xl border border-border">
			{#each data.tokens as t (t.id)}
				<li class="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[0.8125rem]">
					<span class="font-medium">{t.name}</span>
					<span class="font-mono text-xs text-muted-foreground">{t.prefix}…</span>
					<span class="flex-1 text-xs text-muted-foreground">by {t.createdBy ?? '—'} · {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'}{t.expiresAt ? ` · expires ${date(t.expiresAt)}` : ''}</span>
					<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Revoke" onclick={() => revoke(t)}><Trash2 /></button>
				</li>
			{:else}
				<li class="px-3 py-5 text-center text-xs text-muted-foreground">No tokens yet.</li>
			{/each}
		</ul>
	</section>

	<section class="card p-5">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Endpoints</h2>
		<div class="mt-3 flex gap-2">
			<input class="input font-mono text-xs" readonly value={data.base} />
			<a class="btn btn-secondary" href="{data.base}/openapi.json" target="_blank"><FileJson />OpenAPI</a>
		</div>
		<table class="mt-4 w-full text-left text-xs">
			<tbody class="divide-y divide-border">
				{#each [['GET /users', 'People, roles, managers, status'], ['GET /resources', 'Systems, owners, approval rules, access levels (privileged)'], ['GET /access', 'Who has what right now'], ['GET /requests', 'The audit population for a period: type, approvals with capacity, setup'], ['GET /requests/{number}', 'One ticket: timeline and SHA-256 fingerprint'], ['GET /reviews', 'Access reviews and every decision'], ['GET /events', 'The audit log']] as [p, d] (p)}
					<tr><td class="py-1.5 pr-4 font-mono whitespace-nowrap">{p}</td><td class="py-1.5 text-muted-foreground">{d}</td></tr>
				{/each}
			</tbody>
		</table>
		<pre class="mt-4 overflow-x-auto rounded-lg bg-surface p-3 font-mono text-[0.6875rem]">{example}</pre>
	</section>
</div>

<Dialog bind:open={creating} title="New API token" description="Read-only, for this organisation.">
	{#if token}
		<div class="space-y-2">
			<div class="flex gap-2"><input class="input font-mono text-xs" readonly value={token} /><button class="btn btn-secondary" onclick={() => copy(token)}><Copy />Copy</button></div>
			<p class="text-[0.6875rem] text-warning">Copy it now; it won’t be shown again.</p>
		</div>
	{:else}
		<form id="token-form" class="grid grid-cols-[1fr_10rem] gap-3" onsubmit={create}>
			<div><label class="label" for="tn">Name</label><input id="tn" class="input" placeholder="Vanta" bind:value={name} required /></div>
			<div>
				<label class="label" for="te">Expires</label>
				<select id="te" class="input" bind:value={expires}>
					<option value="90">In 90 days</option><option value="365">In a year</option><option value="">Never</option>
				</select>
			</div>
		</form>
	{/if}
	{#snippet footer()}
		{#if token}<button class="btn btn-primary" onclick={() => (creating = false)}>Done</button>
		{:else}
			<button class="btn btn-ghost" onclick={() => (creating = false)}>Cancel</button>
			<button class="btn btn-primary" form="token-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Create</button>
		{/if}
	{/snippet}
</Dialog>
