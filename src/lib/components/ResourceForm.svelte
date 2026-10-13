<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { GripVertical, Plus, Trash2, LoaderCircle, Webhook, Hand, Copy, ArrowUp, ArrowDown } from '@lucide/svelte';
	import PeoplePicker from './PeoplePicker.svelte';
	import ResourceIcon from './ResourceIcon.svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { APPROVAL_LABEL, DURATIONS, HUES } from '#lib/format.ts';
	import { generateSecret } from '#lib/secret.ts';
	import type { ApprovalPolicy, Resource } from '#lib/types.ts';

	type P = { id: string; name: string; email: string };
	let { resource = null, people, defaultApproval = 'approvers', origin }: { resource?: Resource | null; people: P[]; defaultApproval?: ApprovalPolicy; origin: string } = $props();

	const TEMPLATES: Record<string, { category: string; color: string; roles: { name: string; description: string }[] }> = {
		GitHub: { category: 'engineering', color: 'slate', roles: [{ name: 'Member', description: 'Read and write to team repositories' }, { name: 'Owner', description: 'Full admin of the organisation' }] },
		AWS: { category: 'infrastructure', color: 'orange', roles: [{ name: 'ReadOnly', description: 'View resources in the console' }, { name: 'Developer', description: 'Deploy to staging' }, { name: 'Admin', description: 'Production break-glass' }] },
		'Google Workspace': { category: 'productivity', color: 'blue', roles: [{ name: 'User', description: 'Email, Drive, Calendar' }, { name: 'Admin', description: 'Workspace admin console' }] },
		Figma: { category: 'design', color: 'pink', roles: [{ name: 'Viewer', description: 'View and comment' }, { name: 'Editor', description: 'Paid editor seat' }] },
		'Production database': { category: 'data', color: 'green', roles: [{ name: 'Read-only', description: 'SELECT on replicas' }, { name: 'Read-write', description: 'Primary, time-boxed' }] }
	};

	const initial = () => ({
		name: resource?.name ?? '',
		description: resource?.description ?? '',
		category: resource?.category ?? 'app',
		url: resource?.url ?? '',
		color: resource?.color ?? 'violet',
		ownerId: resource?.ownerId ?? '',
		approval: resource?.approval ?? defaultApproval,
		fulfillment: resource?.fulfillment ?? 'manual',
		webhookUrl: resource?.webhookUrl ?? '',
		maxDays: resource?.maxDays === null || resource?.maxDays === undefined ? '' : String(resource.maxDays),
		defaultDays: resource?.defaultDays === null || resource?.defaultDays === undefined ? '' : String(resource.defaultDays),
		requestable: resource?.requestable ?? true,
		approverIds: [...(resource?.approverIds ?? [])],
		fulfillerIds: [...(resource?.fulfillerIds ?? [])],
		roles: resource?.roles.map((r) => ({ ...r })) ?? [{ id: undefined as string | undefined, name: 'Member', description: '' }]
	});
	let f = $state(initial());
	let owner = $state<string[]>(f.ownerId ? [f.ownerId] : []);
	let newSecret = $state<string | null>(null);
	let busy = $state(false);

	function useTemplate(name: string) {
		const t = TEMPLATES[name];
		f.name = name;
		f.category = t.category;
		f.color = t.color;
		f.roles = t.roles.map((r) => ({ id: undefined, ...r }));
	}

	function move(i: number, d: number) {
		const j = i + d;
		if (j < 0 || j >= f.roles.length) return;
		[f.roles[i], f.roles[j]] = [f.roles[j], f.roles[i]];
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const body = {
				...f,
				ownerId: owner[0] ?? null,
				maxDays: f.maxDays === '' ? null : Number(f.maxDays),
				defaultDays: f.defaultDays === '' ? null : Number(f.defaultDays),
				...(newSecret !== null ? { webhookSecret: newSecret } : {})
			};
			if (resource) {
				await api.put(`/api/resources/${resource.id}`, body);
				toast('success', 'Saved');
				newSecret = null;
				await invalidateAll();
			} else {
				const r = await api.post<{ id: string }>('/api/resources', body);
				toast('success', `${f.name} added`, 'People can request it from the catalog now.');
				goto(`/resources/${r.id}`);
			}
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		} finally {
			busy = false;
		}
	}
</script>

<form onsubmit={save} class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
	<div class="space-y-6">
		{#if !resource}
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="mr-1 text-xs text-muted-foreground">Start from:</span>
				{#each Object.keys(TEMPLATES) as t (t)}<button type="button" class="btn btn-ghost btn-sm border border-dashed border-border" onclick={() => useTemplate(t)}>{t}</button>{/each}
			</div>
		{/if}

		<section class="card p-5">
			<h2 class="text-[0.9375rem] font-semibold tracking-tight">Basics</h2>
			<div class="mt-4 grid gap-4 sm:grid-cols-2">
				<div class="sm:col-span-2 flex items-end gap-3">
					<ResourceIcon name={f.name || '?'} color={f.color} size="size-9" />
					<div class="flex-1">
						<label class="label" for="name">Name</label>
						<input id="name" class="input" placeholder="GitHub, AWS, Production DB…" bind:value={f.name} required maxlength="80" />
					</div>
				</div>
				<div class="sm:col-span-2">
					<label class="label" for="desc">Description</label>
					<input id="desc" class="input" placeholder="What it is and who usually needs it" bind:value={f.description} maxlength="1000" />
				</div>
				<div>
					<label class="label" for="cat">Category</label>
					<input id="cat" class="input" list="categories" bind:value={f.category} maxlength="40" />
					<datalist id="categories">{#each ['app', 'engineering', 'infrastructure', 'data', 'design', 'finance', 'productivity', 'security'] as c (c)}<option value={c}></option>{/each}</datalist>
				</div>
				<div>
					<label class="label" for="url">Link <span class="font-normal">(optional)</span></label>
					<input id="url" class="input" type="url" placeholder="https://github.com/acme" bind:value={f.url} />
				</div>
				<div class="sm:col-span-2">
					<span class="label">Colour</span>
					<div class="flex gap-1.5">
						{#each Object.keys(HUES) as c (c)}
							<button type="button" aria-label={c} class="size-6 rounded-md ring-offset-2 ring-offset-card transition {f.color === c ? 'ring-2 ring-primary' : ''}" style="background: oklch(60% {c === 'slate' ? 0.03 : 0.15} {HUES[c]})" onclick={() => (f.color = c)}></button>
						{/each}
					</div>
				</div>
			</div>
		</section>

		<section class="card p-5">
			<div class="flex items-center justify-between">
				<div>
					<h2 class="text-[0.9375rem] font-semibold tracking-tight">Access levels</h2>
					<p class="text-xs text-muted-foreground">What people can ask for, lowest first.</p>
				</div>
				<button type="button" class="btn btn-secondary btn-sm" onclick={() => f.roles.push({ id: undefined, name: '', description: '' })}><Plus />Add level</button>
			</div>
			<div class="mt-4 space-y-2">
				{#each f.roles as role, i (i)}
					<div class="flex items-center gap-2">
						<GripVertical class="size-4 shrink-0 text-muted-foreground/50" />
						<input class="input w-40 shrink-0" placeholder="Name" bind:value={role.name} required maxlength="60" />
						<input class="input" placeholder="What it lets you do" bind:value={role.description} maxlength="300" />
						<button type="button" class="btn btn-ghost btn-icon btn-sm" title="Move up" disabled={i === 0} onclick={() => move(i, -1)}><ArrowUp /></button>
						<button type="button" class="btn btn-ghost btn-icon btn-sm" title="Move down" disabled={i === f.roles.length - 1} onclick={() => move(i, 1)}><ArrowDown /></button>
						<button type="button" class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove" disabled={f.roles.length === 1} onclick={() => f.roles.splice(i, 1)}><Trash2 /></button>
					</div>
				{/each}
			</div>
		</section>

		<section class="card p-5">
			<h2 class="text-[0.9375rem] font-semibold tracking-tight">Approval</h2>
			<div class="mt-4 grid gap-2 sm:grid-cols-2">
				{#each Object.entries(APPROVAL_LABEL) as [v, label] (v)}
					<label class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[0.8125rem] transition-colors {f.approval === v ? 'border-primary/60 bg-primary-soft' : 'border-border hover:bg-accent/50'}">
						<input type="radio" class="mt-0.5 accent-[var(--primary)]" value={v} bind:group={f.approval} />
						<span>
							<span class="block font-medium">{label}</span>
							<span class="block text-xs text-muted-foreground">
								{v === 'none' ? 'Goes straight to setup. For low-risk tools.' : v === 'manager' ? 'Whoever the requester reports to.' : v === 'approvers' ? 'Any one of the people below.' : 'Two steps: manager first, then an approver.'}
							</span>
						</span>
					</label>
				{/each}
			</div>
			{#if f.approval === 'approvers' || f.approval === 'manager_then_approvers'}
				<div class="mt-4">
					<span class="label">Approvers</span>
					<PeoplePicker {people} bind:selected={f.approverIds} placeholder="Add approvers…" />
					<p class="mt-1 text-[0.6875rem] text-muted-foreground">With nobody here, the owner approves, then admins. Nobody approves their own access.</p>
				</div>
			{/if}
			<div class="mt-4 grid gap-4 sm:grid-cols-2">
				<div>
					<label class="label" for="max">Longest allowed</label>
					<select id="max" class="input" bind:value={f.maxDays}>
						{#each DURATIONS as d (d.days)}<option value={d.days === null ? '' : String(d.days)}>{d.days === null ? 'No limit' : d.label}</option>{/each}
					</select>
				</div>
				<div>
					<label class="label" for="def">Default</label>
					<select id="def" class="input" bind:value={f.defaultDays}>
						{#each DURATIONS as d (d.days)}<option value={d.days === null ? '' : String(d.days)}>{d.days === null ? (f.maxDays ? 'Same as longest' : 'Permanent') : d.label}</option>{/each}
					</select>
				</div>
			</div>
		</section>

		<section class="card p-5">
			<h2 class="text-[0.9375rem] font-semibold tracking-tight">Setting up access</h2>
			<div class="mt-4 grid gap-2 sm:grid-cols-2">
				<label class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[0.8125rem] {f.fulfillment === 'manual' ? 'border-primary/60 bg-primary-soft' : 'border-border hover:bg-accent/50'}">
					<input type="radio" class="mt-0.5 accent-[var(--primary)]" value="manual" bind:group={f.fulfillment} />
					<span><span class="flex items-center gap-1.5 font-medium"><Hand class="size-3.5" />By hand</span><span class="block text-xs text-muted-foreground">Someone gets a task, does it, and marks it done.</span></span>
				</label>
				<label class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[0.8125rem] {f.fulfillment === 'webhook' ? 'border-primary/60 bg-primary-soft' : 'border-border hover:bg-accent/50'}">
					<input type="radio" class="mt-0.5 accent-[var(--primary)]" value="webhook" bind:group={f.fulfillment} />
					<span><span class="flex items-center gap-1.5 font-medium"><Webhook class="size-3.5" />Webhook</span><span class="block text-xs text-muted-foreground">POST to your script or automation (n8n, Zapier, a Lambda).</span></span>
				</label>
			</div>
			{#if f.fulfillment === 'webhook'}
				<div class="mt-4 space-y-3">
					<div>
						<label class="label" for="hook">Webhook URL</label>
						<input id="hook" class="input font-mono text-xs" type="url" placeholder="https://automation.example.com/hooks/github" bind:value={f.webhookUrl} required />
						<p class="mt-1 text-[0.6875rem] text-muted-foreground">Called with <code class="font-mono">access.grant</code> or <code class="font-mono">access.revoke</code>. A 2xx answer marks it done; anything else falls back to the people below.</p>
					</div>
					<div>
						<span class="label">Signing secret</span>
						{#if newSecret}
							<div class="flex gap-2">
								<input class="input font-mono text-xs" readonly value={newSecret} />
								<button type="button" class="btn btn-secondary" onclick={() => (navigator.clipboard.writeText(newSecret!), toast('success', 'Copied'))}><Copy />Copy</button>
							</div>
							<p class="mt-1 text-[0.6875rem] text-warning">Copy it now. It’s stored encrypted and won’t be shown again. Saved when you save.</p>
						{:else}
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground">{resource?.hasWebhookSecret ? 'Set. Requests carry an X-ACM-Signature header.' : 'Not set: requests aren’t signed.'}</span>
								<button type="button" class="btn btn-secondary btn-sm" onclick={() => (newSecret = generateSecret())}>{resource?.hasWebhookSecret ? 'Rotate' : 'Generate'}</button>
								{#if resource?.hasWebhookSecret}<button type="button" class="btn btn-ghost btn-sm" onclick={() => (newSecret = '')}>Remove</button>{/if}
							</div>
						{/if}
					</div>
				</div>
			{/if}
			<div class="mt-4">
				<span class="label">{f.fulfillment === 'webhook' ? 'If the webhook fails, ask' : 'Who sets it up'}</span>
				<PeoplePicker {people} bind:selected={f.fulfillerIds} placeholder="Add people…" />
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">With nobody here, the owner does it, then admins.</p>
			</div>
		</section>
	</div>

	<aside class="space-y-4 lg:sticky lg:top-6 lg:self-start">
		<section class="card p-5">
			<span class="label">Owner</span>
			<PeoplePicker {people} bind:selected={owner} single placeholder="Who’s responsible?" />
			<p class="mt-1.5 text-[0.6875rem] text-muted-foreground">Reviews this resource’s access and is the fallback approver.</p>
			<div class="mt-5 flex items-start justify-between gap-3">
				<div>
					<p class="text-[0.8125rem] font-medium">In the catalog</p>
					<p class="text-[0.6875rem] text-muted-foreground">Off: only admins can request it, for others.</p>
				</div>
				<Switch bind:checked={f.requestable} label="Show in catalog" />
			</div>
		</section>
		<button class="btn btn-primary w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}{resource ? 'Save changes' : 'Add resource'}</button>
		{#if f.fulfillment === 'webhook'}
			<details class="card p-4 text-xs">
				<summary class="cursor-pointer font-medium">Webhook payload</summary>
				<pre class="mt-3 overflow-x-auto rounded-lg bg-surface p-3 font-mono text-[0.6875rem] text-muted-foreground">{`POST ${f.webhookUrl || '…'}
x-acm-event: access.grant
x-acm-timestamp: 1760000000
x-acm-signature: sha256=hmac(secret,
  timestamp + "." + body)

{
  "event": "access.grant",
  "request": { "number": 42,
    "url": "${origin}/requests/42" },
  "user": { "email": "dev@acme.com" },
  "resource": { "name": "${f.name || 'GitHub'}" },
  "role": { "name": "Member" },
  "durationDays": 30
}`}</pre>
			</details>
		{/if}
	</aside>
</form>
