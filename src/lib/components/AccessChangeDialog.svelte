<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { LoaderCircle, Plus, Trash2, ShieldAlert } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import PeoplePicker from './PeoplePicker.svelte';
	import ResourceIcon from './ResourceIcon.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { displayName, DURATIONS } from '#lib/format.ts';
	import type { Grant, Resource } from '#lib/types.ts';

	type P = { id: string; name: string; email: string };
	let {
		open = $bindable(false),
		kind,
		person,
		grants,
		resources,
		people,
		othersAccess,
		admin
	}: {
		open: boolean;
		kind: 'onboarding' | 'transfer';
		person: P & { title: string; managerId: string | null };
		grants: Grant[];
		resources: Pick<Resource, 'id' | 'name' | 'color' | 'roles' | 'maxDays' | 'defaultDays'>[];
		people: P[];
		/** Grants of other people, to copy a teammate's access. */
		othersAccess: { userId: string; resourceId: string; roleId: string }[];
		admin: boolean;
	} = $props();

	let reason = $state('');
	let add = $state<{ resourceId: string; roleId: string; days: string }[]>([]);
	let remove = $state<string[]>([]);
	let title = $state('');
	let manager = $state<string[]>([]);
	let copyFrom = $state<string[]>([]);
	let busy = $state(false);
	let result = $state<{ created: number[]; skipped: string[] } | null>(null);

	$effect(() => {
		if (open) {
			reason = '';
			add = [];
			remove = [];
			title = person.title;
			manager = person.managerId ? [person.managerId] : [];
			copyFrom = [];
			result = null;
		}
	});
	$effect(() => {
		const from = copyFrom[0];
		if (!from) return;
		const theirs = othersAccess.filter((g) => g.userId === from && !grants.some((x) => x.role.id === g.roleId));
		const existing = new Set(add.map((a) => a.roleId));
		const res = (id: string) => resources.find((r) => r.id === id);
		add = [...add, ...theirs.filter((g) => !existing.has(g.roleId) && res(g.resourceId)).map((g) => ({ resourceId: g.resourceId, roleId: g.roleId, days: def(res(g.resourceId)!) }))];
		copyFrom = [];
	});

	const def = (r: { maxDays: number | null; defaultDays: number | null }) => String(r.defaultDays ?? r.maxDays ?? '');
	const resource = (id: string) => resources.find((r) => r.id === id);
	function addRow() {
		const r = resources[0];
		if (r) add.push({ resourceId: r.id, roleId: r.roles[0]?.id ?? '', days: def(r) });
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const body: Record<string, unknown> = {
				kind,
				reason,
				add: add.map((a) => ({ resourceId: a.resourceId, roleId: a.roleId, durationDays: a.days === '' ? null : Number(a.days) })),
				remove
			};
			if (kind === 'transfer') {
				body.title = title;
				if (admin) body.managerId = manager[0] ?? '';
			}
			result = await api.post<{ created: number[]; skipped: string[] }>(`/api/people/${person.id}/access-change`, body);
			toast('success', `${result.created.length} ${result.created.length === 1 ? 'request' : 'requests'} opened`, 'Each one goes to its approvers.');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t submit', errorMessage(err));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog
	bind:open
	title={kind === 'onboarding' ? `Onboard ${displayName(person)}` : `Transfer ${displayName(person)}`}
	description={kind === 'onboarding'
		? 'Request their starting access in one go. Each item is approved by its system owner or their manager, as usual.'
		: 'Change their role: request the new access and remove what they no longer need, with one reason on every request.'}
	width="max-w-2xl"
>
	{#if result}
		<div class="space-y-3 text-[0.8125rem]">
			<p>Opened {result.created.length} {result.created.length === 1 ? 'request' : 'requests'}:</p>
			<div class="flex flex-wrap gap-1.5">{#each result.created as n (n)}<a class="badge badge-primary" href="/requests/{n}">#{n}</a>{/each}</div>
			{#if result.skipped.length}<p class="text-xs text-warning">Skipped: {result.skipped.join('; ')}</p>{/if}
		</div>
	{:else}
		<form id="change-form" class="space-y-5" onsubmit={submit}>
			<div>
				<label class="label" for="reason">{kind === 'onboarding' ? 'Joining as' : 'What’s changing'}</label>
				<input id="reason" class="input" placeholder={kind === 'onboarding' ? 'New backend engineer, starts Monday' : 'Moving from support to the platform team'} bind:value={reason} required />
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">Used as the justification on every request below.</p>
			</div>

			{#if kind === 'transfer'}
				<div class="grid gap-3 sm:grid-cols-2">
					<div>
						<label class="label" for="title">New title</label>
						<input id="title" class="input" bind:value={title} />
					</div>
					{#if admin}
						<div>
							<span class="label">New manager</span>
							<PeoplePicker {people} bind:selected={manager} single placeholder="Who will they report to?" />
							<p class="mt-1 text-[0.6875rem] text-muted-foreground">Set first, so the new manager approves the new access.</p>
						</div>
					{/if}
				</div>
				{#if grants.length}
					<fieldset>
						<legend class="label">Remove</legend>
						<div class="grid gap-1 sm:grid-cols-2">
							{#each grants.filter((g) => g.status === 'active') as g (g.id)}
								<label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] hover:bg-accent/50 {remove.includes(g.id) ? 'text-danger line-through' : ''}">
									<input type="checkbox" class="accent-[var(--danger)]" value={g.id} bind:group={remove} />
									<ResourceIcon name={g.resource.name} color={g.resource.color} size="size-5" text="text-[0.625rem]" />{g.resource.name} · {g.role.name}
								</label>
							{/each}
						</div>
					</fieldset>
				{/if}
			{/if}

			<div>
				<div class="mb-1.5 flex items-center justify-between">
					<span class="label mb-0">Add</span>
					<div class="flex items-center gap-2">
						<div class="w-56"><PeoplePicker {people} bind:selected={copyFrom} single placeholder="Copy a teammate’s access…" /></div>
						<button type="button" class="btn btn-secondary btn-sm" onclick={addRow}><Plus />Add</button>
					</div>
				</div>
				<div class="space-y-2">
					{#each add as a, i (i)}
						{@const r = resource(a.resourceId)}
						{@const role = r?.roles.find((x) => x.id === a.roleId)}
						<div class="flex items-center gap-2">
							<select class="input" bind:value={a.resourceId} onchange={() => ((a.roleId = resource(a.resourceId)?.roles[0]?.id ?? ''), (a.days = def(resource(a.resourceId)!)))}>
								{#each resources as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
							</select>
							<select class="input" bind:value={a.roleId}>
								{#each r?.roles ?? [] as x (x.id)}<option value={x.id}>{x.name}{x.privileged ? ' (privileged)' : ''}</option>{/each}
							</select>
							<select class="input w-36 shrink-0" bind:value={a.days}>
								{#each DURATIONS.filter((d) => !r?.maxDays || (d.days !== null && d.days <= r.maxDays)) as d (d.days)}<option value={d.days === null ? '' : String(d.days)}>{d.label}</option>{/each}
							</select>
							<span class="w-4 shrink-0">{#if role?.privileged}<ShieldAlert class="size-4 text-warning" />{/if}</span>
							<button type="button" class="btn btn-ghost btn-icon btn-sm hover:text-danger" aria-label="Remove row" onclick={() => add.splice(i, 1)}><Trash2 /></button>
						</div>
					{:else}
						<p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
							Nothing yet. Add access one by one, or copy what a teammate in the same role has.
						</p>
					{/each}
				</div>
			</div>
		</form>
	{/if}
	{#snippet footer()}
		{#if result}
			<button class="btn btn-primary" onclick={() => (open = false)}>Done</button>
		{:else}
			<button class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
			<button class="btn btn-primary" form="change-form" disabled={busy || (!add.length && !remove.length)}>
				{#if busy}<LoaderCircle class="animate-spin" />{/if}Submit {add.length + remove.length || ''} {add.length + remove.length === 1 ? 'request' : 'requests'}
			</button>
		{/if}
	{/snippet}
</Dialog>

