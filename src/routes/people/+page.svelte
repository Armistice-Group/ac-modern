<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { UserPlus, Search, Copy, X, LoaderCircle, Mail } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { ago, date, displayName, ROLE_LABEL } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let q = $state('');
	let showInactive = $state(false);
	const shown = $derived(data.people.filter((p) => (showInactive || p.status === 'active') && `${p.name} ${p.email} ${p.title}`.toLowerCase().includes(q.toLowerCase())));
	const inactive = $derived(data.people.filter((p) => p.status !== 'active').length);
	const manager = (id: string | null) => data.people.find((p) => p.id === id);

	let inviting = $state(false);
	let emails = $state('');
	let role = $state<'member' | 'admin'>('member');
	let busy = $state(false);
	let links = $state<{ email: string; url: string }[]>([]);
	$effect(() => {
		if (page.url.searchParams.get('invite') === '1') inviting = true;
	});
	$effect(() => {
		if (!inviting) links = [];
	});

	async function invite(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api.post<{ links: { email: string; url: string }[]; emailed: boolean }>('/api/people/invite', { emails, role });
			links = r.links;
			emails = '';
			toast('success', `${r.links.length} ${r.links.length === 1 ? 'invite' : 'invites'} created`, r.emailed ? 'Emails are on their way.' : 'Email isn’t set up, so share the links yourself.');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t invite', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function revokeInvite(id: string) {
		try {
			await api.del(`/api/invites/${id}`);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t revoke the invite', errorMessage(err));
		}
	}
</script>

<svelte:head><title>People · ac·modern</title></svelte:head>

<PageHeader title={data.admin ? 'People' : 'Your team'} description={data.admin ? `Everyone in ${page.data.org?.name}. Onboard new hires, handle transfers, and offboard people in one step.` : 'The people who report to you. Onboard new starters and request changes when they move roles.'}>
	{#snippet actions()}
		{#if data.admin}<button class="btn btn-primary" onclick={() => (inviting = true)}><UserPlus />Invite people</button>{/if}
	{/snippet}
</PageHeader>

<div class="space-y-6 px-8 pb-10">
	{#if data.invites.length}
		<section class="card overflow-hidden">
			<header class="border-b border-border px-4 py-3"><h2 class="text-[0.8125rem] font-semibold">Pending invites <span class="font-normal text-muted-foreground">· {data.invites.length}</span></h2></header>
			<ul class="divide-y divide-border">
				{#each data.invites as i (i.id)}
					<li class="flex items-center gap-3 px-4 py-2.5 text-[0.8125rem]">
						<span class="grid size-7 place-items-center rounded-full border border-dashed border-border text-muted-foreground"><Mail class="size-3.5" /></span>
						<span class="flex-1 truncate">{i.email}</span>
						<span class="badge">{ROLE_LABEL[i.role]}</span>
						<span class="hidden text-xs text-muted-foreground sm:block">sent {ago(i.createdAt)}, expires {date(i.expiresAt)}</span>
						<button class="btn btn-ghost btn-icon btn-sm" title="Revoke invite" onclick={() => revokeInvite(i.id)}><X /></button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<div>
		<div class="mb-4 flex items-center gap-3">
			<div class="relative w-full max-w-xs">
				<Search class="pointer-events-none absolute top-2 left-3 size-4 text-muted-foreground" />
				<input class="input h-8 pl-9 text-xs" placeholder="Filter…" bind:value={q} />
			</div>
			{#if inactive}<label class="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" class="accent-[var(--primary)]" bind:checked={showInactive} />Show offboarded ({inactive})</label>{/if}
		</div>
		<div class="card overflow-x-auto">
			<table class="w-full text-[0.8125rem]">
				<thead>
					<tr class="border-b border-border text-left text-xs text-muted-foreground">
						<th class="px-4 py-2.5 font-medium">Name</th>
						<th class="px-4 py-2.5 font-medium">Role</th>
						<th class="px-4 py-2.5 font-medium">Manager</th>
						<th class="px-4 py-2.5 text-right font-medium">Grants</th>
						<th class="px-4 py-2.5 font-medium">Last sign-in</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each shown.filter((p) => data.admin || p.id !== page.data.viewer?.id) as p (p.id)}
						{@const m = manager(p.managerId)}
						<tr class="relative transition-colors hover:bg-accent/30 {p.status !== 'active' ? 'opacity-55' : ''}">
							<td class="px-4 py-2.5">
								<a href="/people/{p.id}" class="flex items-center gap-2.5 after:absolute after:inset-0">
									<Avatar user={p} />
									<span class="min-w-0">
										<span class="block truncate font-medium">{displayName(p)}{#if p.status !== 'active'} <span class="badge ml-1">Offboarded</span>{/if}</span>
										<span class="block truncate text-xs text-muted-foreground">{p.title ? `${p.title} · ` : ''}{p.email}</span>
									</span>
								</a>
							</td>
							<td class="px-4 py-2.5"><span class="badge {p.role !== 'member' ? 'badge-primary' : ''}">{ROLE_LABEL[p.role]}</span></td>
							<td class="px-4 py-2.5 text-xs text-muted-foreground">{m ? displayName(m) : '—'}</td>
							<td class="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{data.grants[p.id] ?? 0}</td>
							<td class="px-4 py-2.5 text-xs text-muted-foreground">{p.lastLoginAt ? ago(p.lastLoginAt) : 'Never'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>

<Dialog bind:open={inviting} title="Invite people" description="They’ll get a link to create an account and join. Links work once and last 14 days.">
	{#if links.length}
		<div class="space-y-2">
			{#each links as l (l.url)}
				<div class="flex items-center gap-2">
					<span class="w-40 shrink-0 truncate text-xs">{l.email}</span>
					<input class="input h-8 font-mono text-[0.6875rem]" readonly value={l.url} onfocus={(e) => e.currentTarget.select()} />
					<button class="btn btn-secondary btn-icon btn-sm" title="Copy" onclick={() => (navigator.clipboard.writeText(l.url), toast('success', 'Copied'))}><Copy /></button>
				</div>
			{/each}
			<p class="pt-1 text-[0.6875rem] text-muted-foreground">{data.smtp ? 'These were emailed too.' : 'Email isn’t configured (ACM_SMTP_URL), so send these links yourself.'}</p>
		</div>
	{:else}
		<form id="invite-form" class="space-y-4" onsubmit={invite}>
			<div>
				<label class="label" for="emails">Email addresses</label>
				<!-- svelte-ignore a11y_autofocus -->
				<textarea id="emails" class="input h-24 resize-none py-2" placeholder="ana@acme.com, ben@acme.com" bind:value={emails} required autofocus></textarea>
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">Separate with commas, spaces or new lines.</p>
			</div>
			<div>
				<label class="label" for="role">Role</label>
				<select id="role" class="input" bind:value={role}>
					<option value="member">Member: requests access, approves when asked</option>
					<option value="admin">Admin: manages resources, people and settings</option>
				</select>
			</div>
		</form>
	{/if}
	{#snippet footer()}
		{#if links.length}
			<button class="btn btn-ghost" onclick={() => (links = [])}>Invite more</button>
			<button class="btn btn-primary" onclick={() => (inviting = false)}>Done</button>
		{:else}
			<button class="btn btn-ghost" onclick={() => (inviting = false)}>Cancel</button>
			<button class="btn btn-primary" form="invite-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Send invites</button>
		{/if}
	{/snippet}
</Dialog>

