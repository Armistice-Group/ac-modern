<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { UserMinus, UserCheck, LoaderCircle, UserPlus, ArrowLeftRight, KeyRound, Copy } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import AccessChangeDialog from '#lib/components/AccessChangeDialog.svelte';
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
	let githubLogin = $state('');
	let managerIds = $state<string[]>([]);
	let busy = $state(false);
	let changing = $state<'onboarding' | 'transfer' | null>(null);
	let changeOpen = $state(false);
	const openChange = (k: 'onboarding' | 'transfer') => ((changing = k), (changeOpen = true));
	$effect(() => {
		role = p.role;
		title = p.title;
		githubLogin = data.githubLogin;
		managerIds = p.managerId ? [p.managerId] : [];
	});
	const dirty = $derived(role !== p.role || title !== p.title || githubLogin !== data.githubLogin || (managerIds[0] ?? null) !== p.managerId);

	async function save() {
		busy = true;
		try {
			await api.patch(`/api/people/${p.id}`, { role, title, managerId: managerIds[0] ?? '', githubLogin });
			toast('success', 'Saved');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	let offboarding = $state(false);
	let lastDay = $state('');
	let offboardNote = $state('');
	function openOffboard() {
		lastDay = new Date().toISOString().slice(0, 10);
		offboardNote = '';
		offboarding = true;
	}
	async function offboard(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api.post<{ removals: number }>(`/api/people/${p.id}/offboard`, { leftAt: lastDay, note: offboardNote });
			toast('success', `${displayName(p)} offboarded`, `${r.removals} ${r.removals === 1 ? 'removal' : 'removals'} opened.`);
			offboarding = false;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t offboard', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	let resetLink = $state('');
	let resetOpen = $state(false);
	async function sendReset() {
		const ok = await confirmAction({
			title: `Send ${displayName(p)} a password reset link?`,
			body: 'They get a link to set a new password. It works once and expires in a day. Their current password keeps working until they use it.',
			confirmLabel: 'Send link'
		});
		if (!ok) return;
		try {
			const r = await api.post<{ emailed: boolean; link?: string }>(`/api/people/${p.id}/reset-password`, {});
			if (r.link) {
				resetLink = r.link;
				resetOpen = true;
			} else toast('success', 'Reset link sent', `Emailed to ${p.email}.`);
		} catch (err) {
			toast('error', 'Couldn’t send it', errorMessage(err));
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
			{#if !self}
				<button class="btn btn-secondary" onclick={() => openChange('onboarding')}><UserPlus />Onboard</button>
				<button class="btn btn-secondary" onclick={() => openChange('transfer')}><ArrowLeftRight />Transfer</button>
				{#if data.admin && (p.role !== 'owner' || data.myRole === 'owner')}<button class="btn btn-ghost" onclick={sendReset}><KeyRound />Reset password</button>{/if}
				{#if data.admin}<button class="btn btn-danger-outline" onclick={openOffboard}><UserMinus />Offboard</button>{/if}
			{/if}
		{:else}
			<span class="badge">Offboarded</span>
			{#if data.admin}<button class="btn btn-secondary" onclick={reactivate}><UserCheck />Reactivate</button>{/if}
		{/if}
	{/snippet}
</PageHeader>

<div class="grid gap-6 px-8 pb-10 lg:grid-cols-[22rem_minmax(0,1fr)]">
	<div class="space-y-4">
		{#if data.admin}
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
					<label class="label" for="gh">GitHub username</label>
					<input id="gh" class="input font-mono text-xs" placeholder="octocat" bind:value={githubLogin} />
				</div>
				<div>
					<span class="label">Manager</span>
					<PeoplePicker people={data.people} bind:selected={managerIds} single placeholder="Who do they report to?" />
					<p class="mt-1 text-[0.6875rem] text-muted-foreground">Approves their requests on resources that need manager approval.</p>
				</div>
				<button class="btn btn-primary w-full" disabled={!dirty || busy} onclick={save}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Save</button>
			</div>
		</section>
		{:else}
			<section class="card p-5 text-xs text-muted-foreground">
				<div class="mb-2 flex items-center gap-3"><Avatar user={p} size="size-10" /><span>{p.title || 'Reports to you'}</span></div>
				As their manager you can onboard them and request changes when they move roles. Admins manage their profile.
			</section>
		{/if}
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


{#if changing}
	<AccessChangeDialog
		bind:open={changeOpen}
		kind={changing}
		person={{ id: p.id, name: p.name, email: p.email, title: p.title, managerId: p.managerId }}
		grants={data.grants}
		resources={data.resources}
		people={data.people}
		othersAccess={data.othersAccess}
		admin={data.admin}
	/>
{/if}

<Dialog bind:open={resetOpen} title="Reset link for {displayName(p)}" description="Email isn’t configured, so send this to them yourself. It works once and expires in a day.">
	<div class="flex gap-2">
		<input class="input font-mono text-[0.6875rem]" readonly value={resetLink} onfocus={(e) => e.currentTarget.select()} />
		<button class="btn btn-secondary" onclick={() => (navigator.clipboard.writeText(resetLink), toast('success', 'Copied'))}><Copy />Copy</button>
	</div>
	<p class="mt-2 text-[0.6875rem] text-warning">Anyone with this link can set their password. Send it privately.</p>
	{#snippet footer()}<button class="btn btn-primary" onclick={() => (resetOpen = false)}>Done</button>{/snippet}
</Dialog>

<Dialog bind:open={offboarding} title="Offboard {displayName(p)}?" description="They’re signed out and can’t sign in. Their open requests are cancelled, and a removal opens for each of their {data.grants.length} {data.grants.length === 1 ? 'grant' : 'grants'}.">
	<form id="offboard-form" class="space-y-3" onsubmit={offboard}>
		{#if data.grants.length}
			<ul class="max-h-40 overflow-y-auto rounded-lg bg-surface px-3 py-2 text-xs text-muted-foreground">
				{#each data.grants as g (g.id)}<li>{g.resource.name} · {g.role.name}</li>{/each}
			</ul>
		{/if}
		<div class="grid gap-3 sm:grid-cols-[10rem_1fr]">
			<div>
				<label class="label" for="ld">Last day</label>
				<input id="ld" class="input" type="date" bind:value={lastDay} required />
			</div>
			<div>
				<label class="label" for="on">Note</label>
				<input id="on" class="input" placeholder="Leaving date from HR, ticket…" bind:value={offboardNote} maxlength="1000" />
			</div>
		</div>
		<p class="text-xs text-muted-foreground">The audit evidence measures how long their access took to remove, from the end of their last day.</p>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (offboarding = false)}>Cancel</button>
		<button class="btn btn-danger" form="offboard-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Offboard</button>
	{/snippet}
</Dialog>
