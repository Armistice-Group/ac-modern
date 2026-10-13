<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { UserMinus, UserCheck, LoaderCircle } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import ResourceIcon from '#lib/components/ResourceIcon.svelte';
	import RequestRow from '#lib/components/RequestRow.svelte';
	import PeoplePicker from '#lib/components/PeoplePicker.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { date, displayName, ROLE_LABEL } from '#lib/format.ts';
	import type { Role } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const p = $derived(data.person);
	const self = $derived(p.id === page.data.viewer?.id);

	let role = $state<Role>('member');
	let title = $state('');
	let managerIds = $state<string[]>([]);
	let busy = $state(false);
	$effect(() => {
		role = p.role;
		title = p.title;
		managerIds = p.managerId ? [p.managerId] : [];
	});
	const dirty = $derived(role !== p.role || title !== p.title || (managerIds[0] ?? null) !== p.managerId);

	async function save() {
		busy = true;
		try {
			await api.patch(`/api/people/${p.id}`, { role, title, managerId: managerIds[0] ?? '' });
			toast('success', 'Saved');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function offboard() {
		const ok = await confirmAction({
			title: `Offboard ${displayName(p)}?`,
			body: `They’re signed out and can’t sign in to ${page.data.org?.name}. Their open requests are cancelled, and a removal request opens for each of their ${data.grants.length} ${data.grants.length === 1 ? 'grant' : 'grants'} so whoever manages each tool can take it away.`,
			detail: data.grants.map((g) => `${g.resource.name} · ${g.role.name}`).join('\n') || undefined,
			confirmLabel: 'Offboard',
			danger: true
		});
		if (!ok) return;
		try {
			const r = await api.post<{ removals: number }>(`/api/people/${p.id}/offboard`, {});
			toast('success', `${displayName(p)} offboarded`, `${r.removals} ${r.removals === 1 ? 'removal' : 'removals'} opened.`);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t offboard', errorMessage(err));
		}
	}

	async function reactivate() {
		try {
			await api.post(`/api/people/${p.id}/reactivate`, {});
			toast('success', `${displayName(p)} reactivated`);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t reactivate', errorMessage(err));
		}
	}
</script>

<svelte:head><title>{displayName(p)} · ac·modern</title></svelte:head>

<PageHeader title={displayName(p)} description="{p.title ? `${p.title} · ` : ''}{p.email}">
	{#snippet actions()}
		{#if p.status === 'active'}
			{#if !self}<button class="btn btn-danger-outline" onclick={offboard}><UserMinus />Offboard</button>{/if}
		{:else}
			<span class="badge">Offboarded</span>
			<button class="btn btn-secondary" onclick={reactivate}><UserCheck />Reactivate</button>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid gap-6 px-8 pb-10 lg:grid-cols-[22rem_minmax(0,1fr)]">
	<div class="space-y-4">
		<section class="card p-5">
			<div class="mb-4 flex items-center gap-3">
				<Avatar user={p} size="size-10" />
				<div class="min-w-0 text-xs text-muted-foreground">
					<p>Joined {date(p.joinedAt)}</p>
					<p>{p.lastLoginAt ? `Last signed in ${date(p.lastLoginAt)}` : 'Never signed in'}</p>
				</div>
			</div>
			<div class="space-y-3">
				<div>
					<label class="label" for="role">Role</label>
					<select id="role" class="input" bind:value={role} disabled={p.status !== 'active' || (self && p.role === 'owner')}>
						{#each ['member', 'admin', 'owner'] as r (r)}<option value={r} disabled={r === 'owner' && data.myRole !== 'owner'}>{ROLE_LABEL[r as Role]}</option>{/each}
					</select>
				</div>
				<div>
					<label class="label" for="title">Title</label>
					<input id="title" class="input" placeholder="e.g. Backend engineer" bind:value={title} />
				</div>
				<div>
					<span class="label">Manager</span>
					<PeoplePicker people={data.people} bind:selected={managerIds} single placeholder="Who do they report to?" />
					<p class="mt-1 text-[0.6875rem] text-muted-foreground">Approves their requests on resources that need manager approval.</p>
				</div>
				<button class="btn btn-primary w-full" disabled={!dirty || busy} onclick={save}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Save</button>
			</div>
		</section>
		{#if data.reports.length}
			<section class="card p-5">
				<h2 class="mb-2 text-xs font-medium text-muted-foreground">Reports to them</h2>
				<ul class="space-y-1.5">
					{#each data.reports as r (r.id)}<li><a href="/people/{r.id}" class="flex items-center gap-2 text-[0.8125rem] hover:text-primary"><Avatar user={r} size="size-5" />{displayName(r)}</a></li>{/each}
				</ul>
			</section>
		{/if}
	</div>

	<div class="space-y-6">
		<section class="card overflow-hidden">
			<header class="flex items-center justify-between border-b border-border px-4 py-3">
				<h2 class="text-[0.8125rem] font-semibold">Access <span class="font-normal text-muted-foreground">· {data.grants.length}</span></h2>
			</header>
			<ul class="divide-y divide-border">
				{#each data.grants as g (g.id)}
					<li class="flex items-center gap-3 px-4 py-2.5">
						<ResourceIcon name={g.resource.name} color={g.resource.color} size="size-7" text="text-xs" />
						<span class="flex-1 text-[0.8125rem]"><span class="font-medium">{g.resource.name}</span> <span class="text-muted-foreground">· {g.role.name}</span></span>
						{#if g.status === 'pending_revoke'}<span class="badge badge-danger">Being removed</span>{/if}
						<span class="text-xs text-muted-foreground">{g.expiresAt ? `until ${date(g.expiresAt)}` : 'permanent'}</span>
					</li>
				{:else}
					<li class="px-4 py-8 text-center text-xs text-muted-foreground">No access recorded.</li>
				{/each}
			</ul>
		</section>
		<section class="card overflow-hidden">
			<header class="border-b border-border px-4 py-3"><h2 class="text-[0.8125rem] font-semibold">Requests</h2></header>
			<div class="divide-y divide-border">
				{#each data.requests as r (r.id)}<RequestRow {r} showUser={false} />{:else}<p class="px-4 py-8 text-center text-xs text-muted-foreground">No requests.</p>{/each}
			</div>
		</section>
	</div>
</div>

