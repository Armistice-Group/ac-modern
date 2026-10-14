<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { Plug, ShieldAlert, GripVertical, Plus, Trash2, LoaderCircle, Webhook, Hand, Copy, ArrowUp, ArrowDown } from '@lucide/svelte';
	import PeoplePicker from './PeoplePicker.svelte';
	import ResourceIcon from './ResourceIcon.svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { INTEGRATIONS, TARGET_KINDS } from '#lib/integrations.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { APPROVAL_LABEL, DURATIONS, HUES } from '#lib/format.ts';
	import { generateSecret } from '#lib/secret.ts';
	import type { ApprovalPolicy, IntegrationKind, Resource } from '#lib/types.ts';

	type P = { id: string; name: string; email: string };
	let {
		resource = null,
		people,
		defaultApproval = 'approvers',
		origin,
		integrations = []
	}: { resource?: Resource | null; people: P[]; defaultApproval?: ApprovalPolicy; origin: string; integrations?: string[] } = $props();
	type Map = { type: string; team?: string; group?: string; role?: string; id?: string; name?: string };

	const TEMPLATES: Record<string, { category: string; color: string; roles: { name: string; description: string; privileged?: boolean }[] }> = {
		GitHub: { category: 'engineering', color: 'slate', roles: [{ name: 'Member', description: 'Read and write to team repositories' }, { name: 'Owner', description: 'Full admin of the organisation', privileged: true }] },
		AWS: { category: 'infrastructure', color: 'orange', roles: [{ name: 'ReadOnly', description: 'View resources in the console' }, { name: 'Developer', description: 'Deploy to staging' }, { name: 'Admin', description: 'Production break-glass', privileged: true }] },
		'Google Workspace': { category: 'productivity', color: 'blue', roles: [{ name: 'User', description: 'Email, Drive, Calendar' }, { name: 'Admin', description: 'Workspace admin console', privileged: true }] },
		Figma: { category: 'design', color: 'pink', roles: [{ name: 'Viewer', description: 'View and comment' }, { name: 'Editor', description: 'Paid editor seat' }] },
		'Production database': { category: 'data', color: 'green', roles: [{ name: 'Read-only', description: 'SELECT on replicas' }, { name: 'Read-write', description: 'Primary, time-boxed', privileged: true }] }
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
		integration: resource?.integration ?? '',
		roles: (resource?.roles.map((r) => ({ ...r, map: (resource.integrationMap[r.id] as Map | undefined) ?? { type: '' } })) ?? [
			{ id: undefined, name: 'Member', description: '', privileged: false, map: { type: '' } as Map }
		]) as { id?: string; name: string; description: string; privileged: boolean; map: Map }[]
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
		f.roles = t.roles.map((r) => ({ id: undefined, ...r, privileged: !!r.privileged, map: { type: '' } }));
	}

	let teams = $state<{ slug: string; name: string }[] | null>(null);
	$effect(() => {
		if (f.fulfillment === 'integration' && f.integration === 'github' && teams === null) {
			teams = [];
			api.get<{ slug: string; name: string }[]>('/api/integrations/github/teams').then((t) => (teams = t)).catch(() => (teams = []));
		}
	});
	function useIntegration(kind: string) {
		f.fulfillment = 'integration';
		f.integration = kind as IntegrationKind;
		// Sensible starting points: privileged GitHub levels as org owner, Google levels as groups.
		for (const role of f.roles)
			if (!role.map.type?.startsWith(kind))
				role.map =
					kind === 'github' ? { type: 'github_org', role: role.privileged ? 'admin' : 'member' } : kind === 'google' ? { type: 'google_group', group: '', role: 'MEMBER' } : { type: `${kind}_group`, id: '', name: '' };
	}

	// Groups (and Okta apps) offered by the connected IdP.
	let targets = $state<Record<string, { groups: { id: string; name: string }[]; apps?: { id: string; name: string }[]; error?: string }>>({});
	$effect(() => {
		const k = f.integration;
		if (f.fulfillment !== 'integration' || !k || !TARGET_KINDS.includes(k) || targets[k]) return;
		targets[k] = { groups: [] };
		api.get<{ groups: { id: string; name: string }[]; apps?: { id: string; name: string }[] }>(`/api/integrations/${k}/targets`)
			.then((t) => (targets[k] = t))
			.catch((err) => (targets[k] = { groups: [], error: errorMessage(err) }));
	});
	function pick(role: { map: Map }, type: string, id: string) {
		const t = targets[f.integration];
		const list = type === 'okta_app' ? t?.apps : t?.groups;
		role.map = { type, id, name: list?.find((x) => x.id === id)?.name ?? '' };
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
			const integrationMap = Object.fromEntries(f.roles.map((r, i) => [r.id ?? `#${i}`, r.map]).filter(([, m]) => (m as Map).type));
			const body = {
				...f,
				integrationMap,
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
					<p class="text-xs text-muted-foreground">What people can ask for, lowest first. Mark admin-level or sensitive ones as privileged: they always need a system owner or approver.</p>
				</div>
				<button type="button" class="btn btn-secondary btn-sm" onclick={() => f.roles.push({ id: undefined, name: '', description: '', privileged: false, map: { type: '' } })}><Plus />Add level</button>
			</div>
			<div class="mt-4 space-y-2">
				{#each f.roles as role, i (i)}
					<div class="flex items-center gap-2">
						<GripVertical class="size-4 shrink-0 text-muted-foreground/50" />
						<input class="input w-40 shrink-0" placeholder="Name" bind:value={role.name} required maxlength="60" />
						<input class="input" placeholder="What it lets you do" bind:value={role.description} maxlength="300" />
						<label class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs {role.privileged ? 'text-warning' : 'text-muted-foreground'}" title="Admin-level or sensitive: always needs a system owner or approver">
							<input type="checkbox" class="accent-[var(--warning)]" bind:checked={role.privileged} /><ShieldAlert class="size-3.5" />Privileged
						</label>
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
			{#if integrations.length}
				<div class="mt-2 grid gap-2 sm:grid-cols-2">
					{#each integrations as k (k)}
						<label class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[0.8125rem] {f.fulfillment === 'integration' && f.integration === k ? 'border-primary/60 bg-primary-soft' : 'border-border hover:bg-accent/50'}">
							<input type="radio" class="mt-0.5 accent-[var(--primary)]" name="integration" checked={f.fulfillment === 'integration' && f.integration === k} onchange={() => useIntegration(k)} />
							<span><span class="flex items-center gap-1.5 font-medium"><Plug class="size-3.5" />{INTEGRATIONS[k as IntegrationKind].name}</span><span class="block text-xs text-muted-foreground">{INTEGRATIONS[k as IntegrationKind].summary}</span></span>
						</label>
					{/each}
				</div>
			{/if}
			{#if f.fulfillment === 'integration'}
				<div class="mt-4 space-y-2">
					<p class="label">What each level means in {f.integration ? INTEGRATIONS[f.integration].name : ''}</p>
					{#if f.integration && targets[f.integration]?.error}<p class="text-xs text-danger">Couldn’t list groups: {targets[f.integration].error}</p>{/if}
					{#each f.roles as role, i (i)}
						<div class="flex flex-wrap items-center gap-2">
							<span class="w-36 shrink-0 truncate text-[0.8125rem] font-medium">{role.name || `Level ${i + 1}`}</span>
							{#if f.integration === 'github'}
								<select class="input w-44" bind:value={() => (role.map.type === 'github_team' ? 'team' : role.map.role === 'admin' ? 'owner' : 'member'), (v) => (role.map = v === 'team' ? { type: 'github_team', team: role.map.team ?? '', role: 'member' } : { type: 'github_org', role: v === 'owner' ? 'admin' : 'member' })}>
									<option value="member">Org member</option>
									<option value="owner">Org owner</option>
									<option value="team">Team…</option>
								</select>
								{#if role.map.type === 'github_team'}
									{#if teams?.length}
										<select class="input w-48" bind:value={role.map.team}><option value="">Choose a team</option>{#each teams as t (t.slug)}<option value={t.slug}>{t.name}</option>{/each}</select>
									{:else}
										<input class="input w-48 font-mono text-xs" placeholder="team-slug" bind:value={role.map.team} />
									{/if}
									<select class="input w-36" bind:value={role.map.role}><option value="member">as member</option><option value="maintainer">as maintainer</option></select>
								{/if}
							{:else if f.integration && TARGET_KINDS.includes(f.integration)}
								{@const t = targets[f.integration]}
								{#if f.integration === 'okta'}
									<select class="input w-32" bind:value={() => role.map.type, (v) => (role.map = { type: v, id: '', name: '' })}>
										<option value="okta_group">Group</option>
										<option value="okta_app">App</option>
									</select>
								{/if}
								{@const list = role.map.type === 'okta_app' ? (t?.apps ?? []) : (t?.groups ?? [])}
								{#if list.length}
									<select class="input w-64" value={role.map.id ?? ''} onchange={(e) => pick(role, role.map.type, e.currentTarget.value)}>
										<option value="">Choose {role.map.type === 'okta_app' ? 'an app' : 'a group'}…</option>
										{#each list as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
									</select>
								{:else}
									<input class="input w-64 font-mono text-xs" placeholder="{role.map.type === 'okta_app' ? 'App' : 'Group'} ID" bind:value={role.map.id} />
								{/if}
							{:else}
								<select class="input w-40" bind:value={() => role.map.type, (v) => (role.map = v === 'google_account' ? { type: 'google_account' } : { type: 'google_group', group: role.map.group ?? '', role: 'MEMBER' })}>
									<option value="google_group">Group</option>
									<option value="google_account">The account itself</option>
								</select>
								{#if role.map.type === 'google_group'}
									<input class="input w-56 font-mono text-xs" placeholder="engineering@acme.com" bind:value={role.map.group} />
									<select class="input w-32" bind:value={role.map.role}><option value="MEMBER">member</option><option value="MANAGER">manager</option><option value="OWNER">owner</option></select>
								{:else}
									<span class="text-xs text-muted-foreground">Unsuspend on grant, suspend on removal</span>
								{/if}
							{/if}
						</div>
					{/each}
				</div>
			{/if}
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
