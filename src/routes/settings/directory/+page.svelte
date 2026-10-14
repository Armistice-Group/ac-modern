<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Copy, LoaderCircle, RefreshCw, CircleCheck, CircleAlert, Trash2, Plus, ShieldCheck, KeyRound, Users } from '@lucide/svelte';
	import GoogleSetup from '#lib/components/GoogleSetup.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { GOOGLE_DIRECTORY_SCOPES, GOOGLE_LINKS, GOOGLE_PROVISIONING_SCOPES } from '#lib/google.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { ago, dateTime } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	type Kind = 'scim' | 'google' | 'okta' | 'entra';
	const KINDS: { kind: Kind; name: string; detail: string }[] = [
		{ kind: 'scim', name: 'SCIM', detail: 'Authentik, Okta, Entra ID, JumpCloud, OneLogin, Rippling push changes as they happen' },
		{ kind: 'google', name: 'Google Workspace', detail: 'Pulled through the Admin SDK every 30 minutes' },
		{ kind: 'okta', name: 'Okta API', detail: 'Pulled with an API token: no Lifecycle Management needed' },
		{ kind: 'entra', name: 'Microsoft Entra ID', detail: 'Pulled through Microsoft Graph with an app registration' }
	];

	const SCIM_IDPS = [
		{ key: 'authentik', name: 'Authentik' },
		{ key: 'okta', name: 'Okta' },
		{ key: 'entra', name: 'Entra ID' },
		{ key: 'other', name: 'Others' }
	] as const;
	let scimIdp = $state<(typeof SCIM_IDPS)[number]['key']>('authentik');
	let kind = $state<Kind>('scim');
	let cfg = $state<Record<string, string>>({});
	let onDeactivate = $state<'offboard' | 'deactivate'>('offboard');
	let createMembers = $state(true);
	let token = $state('');
	let busy = $state<string | null>(null);
	let map = $state<Record<string, { target: string; roleId: string }>>({});
	$effect(() => {
		kind = data.source?.kind ?? 'scim';
		cfg = { ...(data.source?.config ?? {}) };
		onDeactivate = data.source?.onDeactivate ?? 'offboard';
		createMembers = data.source?.createMembers ?? true;
	});
	const connected = $derived(!!data.source && data.source.kind === kind);
	const roleLabel = (roleId: string | null) => {
		for (const r of data.resources) for (const x of r.roles) if (x.id === roleId) return `${r.name} · ${x.name}${x.privileged ? ' (privileged)' : ''}`;
		return 'an archived level';
	};

	async function run<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => string) {
		busy = key;
		try {
			const r = await fn();
			if (ok) toast('success', ok(r));
			await invalidateAll();
			return r;
		} catch (err) {
			toast('error', 'That didn’t work', errorMessage(err));
		} finally {
			busy = null;
		}
	}
	const copy = (v: string) => (navigator.clipboard.writeText(v), toast('success', 'Copied'));
	const summary = (r: { created: number; deactivated: number; grantsDetected: number; grantsEnded: number }) =>
		`Synced: ${r.created} added, ${r.deactivated} deactivated, ${r.grantsDetected} grants detected, ${r.grantsEnded} ended`;

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (data.source && data.source.kind !== kind) {
			const ok = await confirmAction({ title: 'Switch directory?', body: 'Group mappings for the current directory are removed. People and their access stay.', confirmLabel: 'Switch' });
			if (!ok) return;
		}
		await run('save', () => api.put('/api/settings/directory', { kind, config: cfg, onDeactivate, createMembers }), () => 'Saved');
		if (kind !== 'scim') await run('sync', () => api.post<typeof data.source & {}>('/api/settings/directory/sync', {}), (r) => summary(r as never));
	}
	async function disconnect() {
		if (await confirmAction({ title: 'Disconnect directory sync?', body: 'People, roles and detected access stay as they are, but stop updating.', confirmLabel: 'Disconnect', danger: true }))
			run('disconnect', () => api.del('/api/settings/directory'), () => 'Disconnected');
	}
	async function addMap(groupId: string) {
		const m = map[groupId];
		if (!m?.target) return;
		const roleId = m.target === 'access' ? m.roleId : '';
		const resourceId = data.resources.find((r) => r.roles.some((x) => x.id === roleId))?.id ?? '';
		await run(`map-${groupId}`, () => api.post('/api/settings/directory/mappings', { groupId, target: m.target, resourceId, roleId }), () => 'Mapped');
		map[groupId] = { target: '', roleId: '' };
	}
</script>

<svelte:head><title>Directory sync · ac·modern</title></svelte:head>

<div class="max-w-4xl space-y-6 px-8 pb-10">
	{#if data.source}
		<section class="card flex flex-wrap items-center gap-4 p-4">
			{#if data.source.lastError}<CircleAlert class="size-5 text-danger" />{:else}<CircleCheck class="size-5 text-success" />{/if}
			<div class="min-w-0 flex-1">
				<p class="text-[0.8125rem] font-medium">{KINDS.find((k) => k.kind === data.source?.kind)?.name} connected</p>
				<p class="text-xs {data.source.lastError ? 'text-danger' : 'text-muted-foreground'}">
					{#if data.source.lastError}{data.source.lastError}{:else if data.source.lastSyncAt}Last change {ago(data.source.lastSyncAt)}{:else}Waiting for the first {data.source.kind === 'scim' ? 'push' : 'sync'}{/if}
				</p>
			</div>
			<div class="flex gap-5 font-mono text-xs tabular-nums">
				<span><span class="text-base font-semibold">{data.source.stats.active ?? 0}</span> active</span>
				<span><span class="text-base font-semibold">{data.source.stats.groups ?? 0}</span> groups</span>
				{#if data.source.stats.unmatched}<span class="text-warning"><span class="text-base font-semibold">{data.source.stats.unmatched}</span> not added</span>{/if}
			</div>
			<button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => run('sync', () => api.post('/api/settings/directory/sync', {}), (r) => summary(r as never))}>
				{#if busy === 'sync'}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}{data.source.kind === 'scim' ? 'Reapply' : 'Sync now'}
			</button>
		</section>
	{/if}

	<section class="card p-5">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Where your people live</h2>
		<p class="mt-1 text-xs text-muted-foreground">Your identity provider decides who works here. People are added with their title and manager, and leaving the IdP offboards them here.</p>
		<div class="mt-4 grid gap-2 sm:grid-cols-2">
			{#each KINDS as k (k.kind)}
				<label class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[0.8125rem] transition-colors {kind === k.kind ? 'border-primary/60 bg-primary-soft' : 'border-border hover:bg-accent/50'}">
					<input type="radio" class="mt-0.5 accent-[var(--primary)]" value={k.kind} bind:group={kind} />
					<span><span class="block font-medium">{k.name}</span><span class="block text-xs text-muted-foreground">{k.detail}</span></span>
				</label>
			{/each}
		</div>

		<form class="mt-5 space-y-4" onsubmit={save}>
			{#if kind === 'scim'}
				<div class="flex flex-wrap gap-1" role="tablist" aria-label="Identity provider">
					{#each SCIM_IDPS as idp (idp.key)}
						<button type="button" role="tab" aria-selected={scimIdp === idp.key} class="btn btn-sm {scimIdp === idp.key ? 'btn-secondary' : 'btn-ghost'}" onclick={() => (scimIdp = idp.key)}>{idp.name}</button>
					{/each}
				</div>
				<ol class="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
					{#if scimIdp === 'authentik'}
						<li><strong class="text-foreground">Connect</strong> below, then <strong class="text-foreground">Generate token</strong>.</li>
						<li>In Authentik: <strong class="text-foreground">Applications → Providers → Create → SCIM Provider</strong>. URL: the base URL below. Token: the SCIM token. To send only some groups, set a <em>Group filter</em>.</li>
						<li><strong class="text-foreground">Applications →</strong> your ac·modern application <strong class="text-foreground">→ Edit → Backchannel providers</strong>: add the SCIM provider. Authentik pushes everyone straight away, then each change as it happens.</li>
						<li>Titles and managers: Authentik has no fields for them. Keep them in user attributes and add a SCIM property mapping that sends <code class="font-mono">title</code> and the enterprise <code class="font-mono">manager</code>.</li>
					{:else if scimIdp === 'okta'}
						<li><strong class="text-foreground">Connect</strong> below, then <strong class="text-foreground">Generate token</strong>.</li>
						<li>In Okta: create an app integration with <strong class="text-foreground">SCIM 2.0</strong> provisioning, using header authentication (Bearer). Base URL: below. Unique identifier: <code class="font-mono">userName</code>.</li>
						<li>Turn on <em>Create users</em>, <em>Update user attributes</em> and <em>Deactivate users</em>, and use <strong class="text-foreground">Push Groups</strong> for the groups you want here.</li>
					{:else if scimIdp === 'entra'}
						<li><strong class="text-foreground">Connect</strong> below, then <strong class="text-foreground">Generate token</strong>.</li>
						<li>In Entra ID: <strong class="text-foreground">Enterprise applications → New application → Create your own (non-gallery) → Provisioning → Automatic</strong>. Tenant URL: the base URL below. Secret token: the SCIM token.</li>
						<li>Assign the users and groups to provision, and start provisioning.</li>
					{:else}
						<li><strong class="text-foreground">Connect</strong> below, then <strong class="text-foreground">Generate token</strong>.</li>
						<li>Add a custom SCIM 2.0 application (JumpCloud, OneLogin, Rippling and others) with the base URL below and the token as a Bearer token.</li>
						<li>Turn on user and group provisioning, including deactivation.</li>
					{/if}
				</ol>
				<div>
					<span class="label">SCIM base URL</span>
					<div class="flex gap-2"><input class="input font-mono text-xs" readonly value={data.scimUrl} /><button type="button" class="btn btn-secondary" onclick={() => copy(data.scimUrl)}><Copy />Copy</button></div>
				</div>
			{:else if kind === 'google'}
				<p class="text-xs text-muted-foreground">
					ac·modern reads users, groups and managers through a Google Cloud service account, with read-only access you grant in the Admin console. About 10 minutes; you need to be a Workspace super admin.
					<a class="text-primary hover:underline" href={GOOGLE_LINKS.docs} target="_blank" rel="noreferrer">Full guide</a>
				</p>
				<GoogleSetup
					id="dir-google"
					scopes={GOOGLE_DIRECTORY_SCOPES}
					other={{ name: 'Google Workspace provisioning', scopes: GOOGLE_PROVISIONING_SCOPES, key: data.googleProvisioningKey }}
					saved={data.source?.kind === 'google' ? data.source.serviceAccount : null}
					bind:json={() => cfg.serviceAccountJson ?? '', (v) => (cfg.serviceAccountJson = v)}
					bind:adminEmail={() => cfg.adminEmail ?? '', (v) => (cfg.adminEmail = v)}
				/>
			{:else if kind === 'okta'}
				<p class="text-xs text-muted-foreground">Create an API token (Security → API → Tokens) as a Read-only Administrator.</p>
				<div class="grid gap-3 sm:grid-cols-2">
					<div><label class="label" for="od">Okta domain</label><input id="od" class="input font-mono text-xs" placeholder="acme.okta.com" bind:value={cfg.domain} /></div>
					<div><label class="label" for="ot">API token</label><input id="ot" class="input font-mono text-xs" type="password" placeholder={data.source?.hasSecret.apiToken ? '•••••••• saved' : ''} bind:value={cfg.apiToken} /></div>
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">Register an app in Entra ID with the application permissions <code class="font-mono">User.Read.All</code> and <code class="font-mono">GroupMember.Read.All</code> (admin consent), and create a client secret.</p>
				<div class="grid gap-3 sm:grid-cols-3">
					<div><label class="label" for="tid">Tenant ID</label><input id="tid" class="input font-mono text-xs" bind:value={cfg.tenantId} /></div>
					<div><label class="label" for="cid">Client ID</label><input id="cid" class="input font-mono text-xs" bind:value={cfg.clientId} /></div>
					<div><label class="label" for="cs">Client secret</label><input id="cs" class="input font-mono text-xs" type="password" placeholder={data.source?.hasSecret.clientSecret ? '•••••••• saved' : ''} bind:value={cfg.clientSecret} /></div>
				</div>
			{/if}

			<div class="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
				<div>
					<label class="label" for="deact">When someone is deactivated in the IdP</label>
					<select id="deact" class="input" bind:value={onDeactivate}>
						<option value="offboard">Offboard (remove all their access)</option>
						<option value="deactivate">Only deactivate them here</option>
					</select>
				</div>
				<div class="flex items-start justify-between gap-3">
					<div>
						<p class="text-[0.8125rem] font-medium">Add new people automatically</p>
						<p class="text-xs text-muted-foreground">Off: only people already here are kept in sync.</p>
					</div>
					<Switch bind:checked={createMembers} label="Add new people automatically" />
				</div>
			</div>
			<div class="flex gap-2">
				<button class="btn btn-primary" disabled={!!busy}>{#if busy === 'save'}<LoaderCircle class="animate-spin" />{/if}{connected ? 'Save' : 'Connect'}</button>
				{#if data.source}<button type="button" class="btn btn-ghost ml-auto" onclick={disconnect}>Disconnect</button>{/if}
			</div>
		</form>

		{#if connected && kind === 'scim'}
			<div class="mt-5 rounded-xl border border-border bg-surface p-4">
				<p class="flex items-center gap-2 text-[0.8125rem] font-medium"><KeyRound class="size-4" />SCIM token</p>
				{#if token}
					<div class="mt-2 flex gap-2"><input class="input font-mono text-xs" readonly value={token} /><button class="btn btn-secondary" onclick={() => copy(token)}><Copy />Copy</button></div>
					<p class="mt-1 text-[0.6875rem] text-warning">Copy it now; it won’t be shown again.</p>
				{:else}
					<p class="mt-1 text-xs text-muted-foreground">{data.source?.hasScimToken ? 'A token is set. Generating a new one stops the old one working.' : 'Generate a token for your IdP to authenticate with.'}</p>
					<button class="btn btn-secondary btn-sm mt-2" disabled={!!busy} onclick={async () => (token = (await run('token', () => api.post<{ token: string }>('/api/settings/directory/scim-token', {})))?.token ?? '')}>{data.source?.hasScimToken ? 'Generate new token' : 'Generate token'}</button>
				{/if}
			</div>
		{/if}
	</section>

	{#if data.source}
		<section class="card overflow-hidden">
			<header class="border-b border-border px-5 py-3.5">
				<h2 class="text-[0.9375rem] font-semibold tracking-tight">Groups</h2>
				<p class="text-xs text-muted-foreground">Map a group to ac·modern admins, or to an access level so membership counts as having that access. Access granted in the IdP without a request is flagged in the audit evidence.</p>
			</header>
			{#if data.groups.length}
				<ul class="divide-y divide-border">
					{#each data.groups as g (g.id)}
						{@const mine = data.mappings.filter((m) => m.groupId === g.id)}
						<li class="px-5 py-3">
							<div class="flex flex-wrap items-center gap-3">
								<Users class="size-4 text-muted-foreground" />
								<span class="min-w-40 flex-1 text-[0.8125rem] font-medium">{g.name} <span class="font-normal text-muted-foreground">· {g.n}</span></span>
								<select class="input h-8 w-44 text-xs" bind:value={() => map[g.id]?.target ?? '', (v) => (map[g.id] = { target: v, roleId: map[g.id]?.roleId ?? '' })}>
									<option value="">Map to…</option>
									<option value="admin">ac·modern admins</option>
									<option value="access">An access level</option>
								</select>
								{#if map[g.id]?.target === 'access'}
									<select class="input h-8 w-56 text-xs" bind:value={map[g.id].roleId}>
										<option value="">Choose…</option>
										{#each data.resources as r (r.id)}<optgroup label={r.name}>{#each r.roles as x (x.id)}<option value={x.id}>{r.name} · {x.name}</option>{/each}</optgroup>{/each}
									</select>
								{/if}
								{#if map[g.id]?.target && (map[g.id].target === 'admin' || map[g.id].roleId)}
									<button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => addMap(g.id)}><Plus />Map</button>
								{/if}
							</div>
							{#if mine.length}
								<div class="mt-2 flex flex-wrap gap-1.5 pl-7">
									{#each mine as m (m.id)}
										<span class="badge {m.target === 'admin' ? 'badge-primary' : ''}">
											{#if m.target === 'admin'}<ShieldCheck />ac·modern admins{:else}{roleLabel(m.roleId)}{/if}
											<button class="ml-0.5 hover:text-danger" aria-label="Remove mapping" onclick={() => run(`rm-${m.id}`, () => api.del(`/api/settings/directory/mappings/${m.id}`))}><Trash2 class="size-3" /></button>
										</span>
									{/each}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="px-5 py-8 text-center text-xs text-muted-foreground">No groups yet. {data.source.kind === 'scim' ? 'Push groups from your IdP.' : 'Run a sync.'}</p>
			{/if}
		</section>

		{#if data.events.length}
			<section class="card overflow-hidden">
				<header class="border-b border-border px-5 py-3"><h2 class="text-[0.8125rem] font-semibold">Recent directory changes</h2></header>
				<ul class="divide-y divide-border">
					{#each data.events as e (e.id)}<li class="flex gap-3 px-5 py-2 text-xs"><span class="w-32 shrink-0 text-muted-foreground">{dateTime(e.at)}</span><span>{e.summary}</span></li>{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>
