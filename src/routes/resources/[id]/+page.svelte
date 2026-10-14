<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Archive, ArchiveRestore, ExternalLink, Plus } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ResourceForm from '#lib/components/ResourceForm.svelte';
	import RequestRow from '#lib/components/RequestRow.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { date, displayName } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let tab = $state<'holders' | 'settings'>('holders');
	const r = $derived(data.resource);

	async function archive(archived: boolean) {
		if (archived) {
			const ok = await confirmAction({
				title: `Archive ${r.name}?`,
				body: `It disappears from the catalog and can’t be requested. The ${data.grants.length} existing ${data.grants.length === 1 ? 'grant stays' : 'grants stay'} recorded until you revoke them.`,
				confirmLabel: 'Archive',
				danger: true
			});
			if (!ok) return;
		}
		try {
			await api.post(`/api/resources/${r.id}/archive`, { archived });
			toast('success', archived ? 'Archived' : 'Restored');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t change that', errorMessage(err));
		}
	}
</script>

<svelte:head><title>{r.name} · ac·modern</title></svelte:head>

<PageHeader title={r.name} description={r.description || `${r.roles.length} access ${r.roles.length === 1 ? 'level' : 'levels'} · ${data.grants.length} ${data.grants.length === 1 ? 'person has' : 'people have'} access`}>
	{#snippet actions()}
		{#if r.url}<a href={r.url} target="_blank" rel="noreferrer" class="btn btn-ghost"><ExternalLink />Open</a>{/if}
		{#if data.admin}
			{#if r.archived}<button class="btn btn-secondary" onclick={() => archive(false)}><ArchiveRestore />Restore</button>
			{:else}<button class="btn btn-ghost" onclick={() => archive(true)}><Archive />Archive</button>{/if}
			<a href="/access?record=1" class="btn btn-secondary"><Plus />Record access</a>
		{/if}
	{/snippet}
</PageHeader>

<div class="px-8 pb-10">
	{#if data.admin}
		<div class="mb-5 flex w-fit rounded-xl border border-border bg-surface p-0.5">
			{#each [['holders', 'Who has access'], ['settings', 'Settings']] as [id, label] (id)}
				<button class="h-7 rounded-lg px-3 text-xs font-medium transition-colors {tab === id ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (tab = id as typeof tab)}>{label}</button>
			{/each}
		</div>
	{/if}

	{#if tab === 'settings' && data.admin}
		{#key r.id}<ResourceForm resource={r} people={data.people} origin={data.origin} integrations={data.integrations} />{/key}
	{:else}
		<div class="grid gap-6 xl:grid-cols-2">
			<section class="card overflow-hidden">
				<header class="border-b border-border px-4 py-3"><h2 class="text-[0.8125rem] font-semibold">Who has access</h2></header>
				{#each r.roles as role (role.id)}
					{@const holders = data.grants.filter((g) => g.role.id === role.id)}
					<div class="border-b border-border px-4 py-3 last:border-0">
						<p class="text-xs font-medium">{role.name} <span class="font-normal text-muted-foreground">· {holders.length}</span></p>
						{#if holders.length}
							<ul class="mt-2 space-y-1.5">
								{#each holders as g (g.id)}
									<li class="flex items-center gap-2 text-[0.8125rem]">
										<Avatar user={g.user} size="size-5" />
										<span class="flex-1 truncate">{displayName(g.user)}</span>
										{#if g.status === 'pending_revoke'}<span class="badge badge-danger">Being removed</span>{/if}
										<span class="text-xs text-muted-foreground">{g.expiresAt ? `until ${date(g.expiresAt)}` : 'permanent'}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="mt-1 text-xs text-muted-foreground">Nobody.</p>
						{/if}
					</div>
				{/each}
			</section>
			<section class="card overflow-hidden">
				<header class="border-b border-border px-4 py-3"><h2 class="text-[0.8125rem] font-semibold">Recent requests</h2></header>
				<div class="divide-y divide-border">
					{#each data.requests as q (q.id)}<RequestRow r={q} />{:else}<p class="px-4 py-8 text-center text-xs text-muted-foreground">No requests yet.</p>{/each}
				</div>
			</section>
		</div>
	{/if}
</div>
