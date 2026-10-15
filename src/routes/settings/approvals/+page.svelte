<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { LoaderCircle, Pencil, Plus, ShieldCheck, Trash2, Zap } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { api, errorMessage, wentForApproval } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { ago, APPROVAL_LABEL } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Draft = { id: string | null; name: string; enabled: boolean; resourceIds: string[]; roleIds: string[]; groupIds: string[]; userIds: string[]; maxDays: string };
	const blank = (): Draft => ({ id: null, name: '', enabled: true, resourceIds: [], roleIds: [], groupIds: [], userIds: [], maxDays: '' });
	let editing = $state(false);
	let draft = $state<Draft>(blank());
	let busy = $state(false);
	let personQuery = $state('');

	const chosen = $derived(data.resources.filter((r) => draft.resourceIds.includes(r.id)));
	const shownPeople = $derived(
		data.people.filter((p) => draft.userIds.includes(p.id) || (personQuery && `${p.name} ${p.email}`.toLowerCase().includes(personQuery.toLowerCase()))).slice(0, 30)
	);

	const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
	function toggleResource(id: string) {
		draft.resourceIds = toggle(draft.resourceIds, id);
		// Levels of a system the rule no longer covers drop out with it.
		const keep = new Set(data.resources.filter((r) => draft.resourceIds.includes(r.id)).flatMap((r) => r.roles.map((x) => x.id)));
		draft.roleIds = draft.roleIds.filter((x) => keep.has(x));
	}

	const preview = $derived.by(() => {
		const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ');
		const roles = chosen.flatMap((r) => r.roles.filter((x) => draft.roleIds.includes(x.id)).map((x) => ({ name: `${r.name} (${x.name})` })));
		const what = roles.length ? names(roles) : chosen.length ? `${names(chosen)} (any non-privileged level)` : 'every system (non-privileged levels)';
		const groups = data.groups.filter((g) => draft.groupIds.includes(g.id));
		const people = data.people.filter((p) => draft.userIds.includes(p.id)).map((p) => ({ name: p.name || p.email }));
		const who = [groups.length ? `people in ${names(groups)}` : '', people.length ? names(people) : ''].filter(Boolean).join(' or ') || 'everyone';
		return `${what} for ${who}${draft.maxDays ? `, for up to ${draft.maxDays} days` : ''}`;
	});
	const broad = $derived(!draft.resourceIds.length && !draft.groupIds.length && !draft.userIds.length);

	function edit(r?: (typeof data.rules)[number]) {
		draft = r ? { id: r.id, name: r.name, enabled: r.enabled, resourceIds: [...r.resourceIds], roleIds: [...r.roleIds], groupIds: [...r.groupIds], userIds: [...r.userIds], maxDays: r.maxDays ? String(r.maxDays) : '' } : blank();
		personQuery = '';
		editing = true;
	}

	const payload = (d: Draft) => ({ name: d.name, enabled: d.enabled, resourceIds: d.resourceIds, roleIds: d.roleIds, groupIds: d.groupIds, userIds: d.userIds, maxDays: d.maxDays ? Number(d.maxDays) : null });

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (broad && !(await confirmAction({ title: 'Auto-approve everything?', body: 'This rule covers every non-privileged level of every system, for everyone. Requests will skip approval entirely.', confirmLabel: 'Save anyway', danger: true }))) return;
		busy = true;
		try {
			const r = draft.id ? await api.put(`/api/settings/rules/${draft.id}`, payload(draft)) : await api.post('/api/settings/rules', payload(draft));
			if (wentForApproval(r)) toast('success', 'Sent to another admin', 'The rule applies once a second admin approves it (Settings → Changes).');
			else toast('success', draft.id ? 'Rule saved' : 'Rule added');
			editing = false;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save the rule', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function setEnabled(r: (typeof data.rules)[number], enabled: boolean) {
		try {
			const res = await api.put(`/api/settings/rules/${r.id}`, { ...payload({ ...r, id: r.id, maxDays: r.maxDays ? String(r.maxDays) : '' }), enabled });
			if (wentForApproval(res)) toast('success', 'Sent to another admin', 'It changes once a second admin approves it.');
			else toast('success', enabled ? `“${r.name}” is on` : `“${r.name}” is off`);
		} catch (err) {
			toast('error', 'Couldn’t change the rule', errorMessage(err));
		}
		await invalidateAll();
	}

	async function remove(r: (typeof data.rules)[number]) {
		if (!(await confirmAction({ title: `Delete “${r.name}”?`, body: 'Matching requests go back to each system’s own approval rule. Requests it already approved keep their record.', danger: true, confirmLabel: 'Delete' }))) return;
		await api.del(`/api/settings/rules/${r.id}`);
		await invalidateAll();
	}
</script>

<svelte:head><title>Approval rules · ac·modern</title></svelte:head>

<div class="max-w-3xl space-y-6 px-8 pb-10">
	<section class="card p-5">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-[0.9375rem] font-semibold tracking-tight">Auto-approval rules</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					Requests that match a rule skip approval and go straight to setup. Each one records which rule approved it and why, and every change to a rule is in the audit log. Everything else follows the system’s own approval rule.
				</p>
			</div>
			<button class="btn btn-primary shrink-0" onclick={() => edit()}><Plus />New rule</button>
		</div>
		<p class="mt-3 flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
			<ShieldCheck class="mt-px size-3.5 shrink-0 text-primary" />Privileged access levels are never auto-approved: they always go to a person.
		</p>

		<ul class="mt-4 divide-y divide-border rounded-xl border border-border">
			{#each data.rules as r (r.id)}
				<li class="flex items-start gap-3 px-3 py-3">
					<Zap class="mt-0.5 size-4 shrink-0 {r.enabled ? 'text-primary' : 'text-muted-foreground'}" />
					<div class="min-w-0 flex-1">
						<p class="text-[0.8125rem] font-medium {r.enabled ? '' : 'text-muted-foreground'}">{r.name}{#if !r.enabled}<span class="badge ml-2">Off</span>{/if}</p>
						<p class="mt-0.5 text-xs text-muted-foreground">Auto-approves {r.description}.</p>
						<p class="mt-0.5 text-[0.6875rem] text-muted-foreground/70">Changed {ago(r.updatedAt)}</p>
					</div>
					<Switch checked={r.enabled} label="Rule on" onchange={(v) => setEnabled(r, v)} />
					<button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick={() => edit(r)}><Pencil /></button>
					<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete" onclick={() => remove(r)}><Trash2 /></button>
				</li>
			{:else}
				<li class="px-3 py-6 text-center text-xs text-muted-foreground">No rules yet. Every request follows its system’s approval rule.</li>
			{/each}
		</ul>
	</section>
</div>

<Dialog bind:open={editing} title={draft.id ? 'Edit rule' : 'New auto-approval rule'} description="A request is auto-approved when it matches everything below." width="max-w-2xl">
	<form id="rule-form" class="space-y-5" onsubmit={save}>
		<div>
			<label class="label" for="rn">Name</label>
			<input id="rn" class="input" placeholder="Engineering tools" bind:value={draft.name} required maxlength="80" />
		</div>

		<fieldset>
			<legend class="label">Systems</legend>
			<p class="mb-2 text-xs text-muted-foreground">None ticked: every system.</p>
			<div class="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
				{#each data.resources as r (r.id)}
					<button type="button" class="chip" class:on={draft.resourceIds.includes(r.id)} onclick={() => toggleResource(r.id)} title="Its own rule: {APPROVAL_LABEL[r.approval]}">{r.name}</button>
				{/each}
			</div>
		</fieldset>

		{#if chosen.length}
			<fieldset>
				<legend class="label">Access levels</legend>
				<p class="mb-2 text-xs text-muted-foreground">None ticked: every non-privileged level of the systems above.</p>
				<div class="space-y-2">
					{#each chosen as r (r.id)}
						<div class="flex flex-wrap items-center gap-1.5">
							<span class="w-28 truncate text-xs text-muted-foreground">{r.name}</span>
							{#each r.roles as x (x.id)}
								<button type="button" class="chip" class:on={draft.roleIds.includes(x.id)} disabled={x.privileged} title={x.privileged ? 'Privileged levels always need approval' : ''} onclick={() => (draft.roleIds = toggle(draft.roleIds, x.id))}>
									{x.name}{#if x.privileged}<span class="text-[0.625rem] uppercase"> · privileged</span>{/if}
								</button>
							{/each}
						</div>
					{/each}
				</div>
			</fieldset>
		{/if}

		<fieldset>
			<legend class="label">Who</legend>
			<p class="mb-2 text-xs text-muted-foreground">The person the access is for must be in one of these groups, or named. Nothing ticked: everyone.</p>
			{#if data.groups.length}
				<div class="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
					{#each data.groups as g (g.id)}
						<button type="button" class="chip" class:on={draft.groupIds.includes(g.id)} onclick={() => (draft.groupIds = toggle(draft.groupIds, g.id))}>{g.name} <span class="text-muted-foreground">{g.members}</span></button>
					{/each}
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">Groups come from <a class="text-primary hover:underline" href="/settings/directory">directory sync</a>. Until it’s connected, name people instead.</p>
			{/if}
			<input class="input mt-3" placeholder="Add people by name or email" bind:value={personQuery} />
			{#if shownPeople.length}
				<div class="mt-2 flex flex-wrap gap-1.5">
					{#each shownPeople as p (p.id)}
						<button type="button" class="chip" class:on={draft.userIds.includes(p.id)} onclick={() => (draft.userIds = toggle(draft.userIds, p.id))}>{p.name || p.email}</button>
					{/each}
				</div>
			{/if}
		</fieldset>

		<div class="grid gap-3 sm:grid-cols-[12rem_1fr] sm:items-end">
			<div>
				<label class="label" for="rd">Longest duration</label>
				<div class="flex items-center gap-2"><input id="rd" class="input" type="number" min="1" max="3650" placeholder="Any" bind:value={draft.maxDays} /><span class="text-xs text-muted-foreground">days</span></div>
			</div>
			<p class="text-xs text-muted-foreground">Set it to auto-approve only time-limited access; permanent requests then need approval.</p>
		</div>

		<div class="rounded-xl border border-border bg-muted/40 p-3 text-xs">
			<span class="font-medium">Auto-approves</span> <span class="text-muted-foreground">{preview}.</span>
			{#if broad}<p class="mt-1 text-warning">That’s every request for non-privileged access. Narrow it to systems or people.</p>{/if}
		</div>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (editing = false)}>Cancel</button>
		<button class="btn btn-primary" form="rule-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}{draft.id ? 'Save' : 'Add rule'}</button>
	{/snippet}
</Dialog>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.75rem;
		padding: 0 0.625rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.75rem;
		color: var(--muted-foreground);
		transition: background-color 0.1s;
	}
	.chip:hover:not(:disabled) {
		background: var(--accent);
		color: var(--foreground);
	}
	.chip.on {
		border-color: color-mix(in oklch, var(--primary) 50%, transparent);
		background: var(--primary-soft);
		color: var(--primary);
	}
	.chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
