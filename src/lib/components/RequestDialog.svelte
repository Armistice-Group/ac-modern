<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { LoaderCircle, ShieldCheck, ShieldAlert, Zap, UserCheck } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import ResourceIcon from './ResourceIcon.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { APPROVAL_LABEL, displayName, DURATIONS, duration } from '#lib/format.ts';
	import type { AccessRequest, Resource } from '#lib/types.ts';

	let {
		resource = $bindable(null),
		roleId: initialRole = '',
		people,
		me,
		canRequestFor
	}: {
		resource: Resource | null;
		roleId?: string;
		people: { id: string; name: string; email: string }[];
		me: string;
		/** Ids this person may request for (besides themselves). */
		canRequestFor: string[] | 'all';
	} = $props();

	let open = $state(false);
	let roleId = $state('');
	let userId = $state('');
	let days = $state<string>('');
	let justification = $state('');
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		open = !!resource;
		if (resource) {
			roleId = initialRole || resource.roles[0]?.id || '';
			userId = me;
			days = resource.defaultDays !== null ? String(resource.defaultDays) : resource.maxDays !== null ? String(resource.maxDays) : 'null';
			justification = '';
			error = '';
		}
	});
	$effect(() => {
		if (!open) resource = null;
	});

	const options = $derived(
		resource
			? (() => {
					const list = DURATIONS.filter((d) => (resource!.maxDays === null ? true : d.days !== null && d.days <= resource!.maxDays));
					for (const extra of [resource!.defaultDays, resource!.maxDays])
						if (extra !== null && !list.some((d) => d.days === extra)) list.push({ days: extra, label: duration(extra) });
					return list.sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
				})()
			: []
	);
	const selectedRole = $derived(resource?.roles.find((r) => r.id === roleId));
	const others = $derived(canRequestFor === 'all' ? people.filter((p) => p.id !== me) : people.filter((p) => canRequestFor.includes(p.id)));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!resource) return;
		busy = true;
		error = '';
		try {
			const r = await api.post<AccessRequest>('/api/requests', {
				resourceId: resource.id,
				roleId,
				userId,
				justification,
				durationDays: days === 'null' ? null : Number(days)
			});
			open = false;
			toast('success', r.status === 'completed' ? `Access granted (#${r.number})` : `Request #${r.number} sent`, r.status === 'pending_approval' ? 'Approvers have been notified.' : undefined);
			await invalidateAll();
			goto(`/requests/${r.number}`);
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Request access" width="max-w-lg">
	{#if resource}
		<form id="request-form" onsubmit={submit} class="space-y-4">
			<div class="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
				<ResourceIcon name={resource.name} color={resource.color} size="size-10" text="text-[0.9375rem]" />
				<div class="min-w-0 flex-1">
					<p class="text-[0.9375rem] font-semibold tracking-tight">{resource.name}</p>
					<p class="flex items-center gap-1 text-xs text-muted-foreground">
						{#if resource.approval === 'none'}<Zap class="size-3" />Granted without approval{:else}<UserCheck class="size-3" />Approved by {APPROVAL_LABEL[resource.approval].toLowerCase()}{/if}
						{#if resource.fulfillment === 'webhook'}· <ShieldCheck class="size-3" />set up automatically{/if}
					</p>
				</div>
			</div>

			{#if others.length}
				<div>
					<label class="label" for="for">For</label>
					<select id="for" class="input" bind:value={userId}>
						<option value={me}>Me</option>
						{#each others as p (p.id)}<option value={p.id}>{displayName(p)}</option>{/each}
					</select>
				</div>
			{/if}

			<fieldset>
				<legend class="label">Access level</legend>
				<div class="space-y-1.5">
					{#each resource.roles as role (role.id)}
						<label class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors {roleId === role.id ? 'border-primary/60 bg-primary-soft' : 'border-border hover:bg-accent/50'}">
							<input type="radio" class="mt-0.5 accent-[var(--primary)]" name="role" value={role.id} bind:group={roleId} />
							<span class="min-w-0">
								<span class="flex items-center gap-1.5 text-[0.8125rem] font-medium">{role.name}{#if role.privileged}<span class="badge badge-warning"><ShieldAlert />Privileged</span>{/if}</span>
								{#if role.description}<span class="block text-xs text-muted-foreground">{role.description}</span>{/if}
								{#if role.privileged && roleId === role.id}<span class="mt-1 block text-[0.6875rem] text-warning">Needs approval from the system owner or an approver{resource.approval === 'manager' || resource.approval === 'manager_then_approvers' ? ', after your manager' : ''}.</span>{/if}
							</span>
						</label>
					{/each}
				</div>
			</fieldset>

			<div>
				<label class="label" for="days">For how long</label>
				<select id="days" class="input" bind:value={days}>
					{#each options as o (o.days)}<option value={String(o.days)}>{o.label}</option>{/each}
				</select>
				{#if resource.maxDays !== null}<p class="mt-1 text-[0.6875rem] text-muted-foreground">{resource.name} access lasts at most {duration(resource.maxDays).toLowerCase()}. You can ask to extend it later.</p>{/if}
			</div>

			<div>
				<label class="label" for="why">Why do you need it?{#if resource.approval === 'none' && !selectedRole?.privileged} <span class="font-normal">(optional)</span>{/if}</label>
				<textarea id="why" class="input h-20 resize-none py-2" placeholder="e.g. Fixing the billing bug in ENG-142" bind:value={justification} required={resource.approval !== 'none' || !!selectedRole?.privileged}></textarea>
			</div>
			{#if error}<p class="text-xs text-danger">{error}</p>{/if}
		</form>
	{/if}
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button class="btn btn-primary" form="request-form" disabled={busy || !roleId}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Send request</button>
	{/snippet}
</Dialog>
