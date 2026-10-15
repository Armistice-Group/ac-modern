<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { LoaderCircle, KeyRound, Bot, ChevronRight } from '@lucide/svelte';
	import BrandLogo from '#lib/components/BrandLogo.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import GoogleSetup from '#lib/components/GoogleSetup.svelte';
	import { GOOGLE_DIRECTORY_SCOPES, GOOGLE_LINKS, GOOGLE_PROVISIONING_SCOPES } from '#lib/google.ts';
	import SlackSettings from './SlackSettings.svelte';
	import type { PageProps } from './$types';

	type Kind = 'github' | 'google' | 'okta' | 'authentik' | 'entra' | 'slack';

	let { data }: PageProps = $props();
	let gh = $state({ org: '', token: '' });
	let g = $state({ serviceAccountJson: '', adminEmail: '' });
	let okta = $state({ domain: '', apiToken: '' });
	let ak = $state({ url: '', token: '' });
	let entra = $state({ tenantId: '', clientId: '', clientSecret: '' });
	let busy = $state<string | null>(null);
	let open = $state<Kind | null>(null);
	$effect(() => {
		gh = { org: data.github?.org ?? '', token: '' };
		g = { serviceAccountJson: '', adminEmail: data.google?.adminEmail ?? '' };
		okta = { domain: data.okta?.domain ?? '', apiToken: '' };
		ak = { url: data.authentik?.url ?? '', token: '' };
		entra = { tenantId: data.entra?.tenantId ?? '', clientId: data.entra?.clientId ?? '', clientSecret: '' };
	});
	// Coming back from Slack's OAuth screen.
	$effect(() => {
		const msg = page.url.searchParams.get('slack');
		if (msg) toast(msg === 'connected' ? 'success' : 'error', msg === 'connected' ? 'Slack connected' : 'Slack didn’t connect', msg === 'connected' ? undefined : msg);
	});

	const apps = $derived([
		{ kind: 'github', name: 'GitHub', as: data.github?.org ?? null, what: 'Org and team membership.' },
		{ kind: 'google', name: 'Google Workspace', as: data.google?.adminEmail ?? null, what: 'Groups and account suspension.' }
	] as const);
	const idps = $derived([
		{ kind: 'authentik', name: 'Authentik', as: data.authentik ? data.authentik.url.replace(/^https?:\/\//, '') : null, what: 'Group membership.' },
		{ kind: 'okta', name: 'Okta', as: data.okta?.domain ?? null, what: 'Groups or app assignments.' },
		{ kind: 'entra', name: 'Microsoft Entra ID', as: data.entra ? 'Connected' : null, what: 'Security group membership.' }
	] as const);
	const slack = $derived({ kind: 'slack', name: 'Slack', as: data.slack ? data.slack.team || 'Connected' : null, what: 'Approvals by DM, and /access.' } as const);
	const all = $derived([...apps, ...idps, slack]);
	const current = $derived(all.find((i) => i.kind === open) ?? null);
	const connectedCount = $derived(all.filter((i) => i.as !== null).length);
	const uses = (kind: string) => data.usage[kind] ?? 0;
	const reuse = (kind: string) => data.directory === kind;

	async function connect(kind: Kind, body: Record<string, string>) {
		busy = kind;
		try {
			const r = await api.put<{ as?: string; org?: string }>(`/api/settings/integrations/${kind}`, body);
			toast('success', `Connected${r.org ? ` to ${r.org}` : ''}`, r.as ? `Acting as ${r.as}` : undefined);
			open = null;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t connect', errorMessage(err));
		} finally {
			busy = null;
		}
	}
	async function disconnect(kind: Kind, name: string) {
		if (!(await confirmAction({ title: `Disconnect ${name}?`, body: 'Resources set up through it must be switched to another method first.', danger: true, confirmLabel: 'Disconnect' }))) return;
		try {
			await api.del(`/api/settings/integrations/${kind}`);
			open = null;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t disconnect', errorMessage(err));
		}
	}
	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (open === 'github') connect('github', gh);
		else if (open === 'google') connect('google', g);
		else if (open === 'okta') connect('okta', okta);
		else if (open === 'authentik') connect('authentik', ak);
		else if (open === 'entra') connect('entra', entra);
	}
</script>

<svelte:head><title>Integrations · ac·modern</title></svelte:head>

{#snippet tile(i: (typeof all)[number])}
	{@const on = i.as !== null}
	<button type="button" class="card group flex min-w-0 items-center gap-3 p-3.5 text-left transition-colors hover:bg-accent/60" onclick={() => (open = i.kind)}>
		<span class="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background"><BrandLogo brand={i.kind} class="size-[1.125rem]" /></span>
		<span class="min-w-0 flex-1">
			<span class="flex items-center gap-2 text-[0.8125rem] font-medium">
				{i.name}
				{#if on}<span class="size-1.5 rounded-full bg-success"></span>{/if}
			</span>
			<span class="block truncate text-xs text-muted-foreground">
				{#if on}<span class="font-mono">{i.as}</span>{:else}{i.what}{/if}
			</span>
		</span>
		<span class="shrink-0 text-xs font-medium {on ? 'text-muted-foreground' : 'text-primary'}">{on ? 'Manage' : 'Connect'}</span>
	</button>
{/snippet}

{#snippet group(title: string, hint: string, items: readonly (typeof all)[number][])}
	<section>
		<div class="mb-2.5">
			<h2 class="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
			<p class="text-xs text-muted-foreground">{hint}</p>
		</div>
		<div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
			{#each items as i (i.kind)}{@render tile(i)}{/each}
		</div>
	</section>
{/snippet}

<div class="max-w-5xl space-y-7 px-8 pb-10">
	<p class="text-xs text-muted-foreground">
		{connectedCount} of {all.length} connected. Connect a system once, then pick it as the setup method on a resource: approved requests are set up and removed automatically, and if that fails the fulfillers get the task with the error.
	</p>

	{@render group('Apps', 'Grant access directly in the app.', apps)}
	{@render group('Identity providers', 'Grant access through an IdP group, which covers every app behind it.', idps)}
	{@render group('Notifications', 'Where approvers and requesters hear about requests.', [slack])}

	<section>
		<div class="mb-2.5">
			<h2 class="text-[0.9375rem] font-semibold tracking-tight">API and AI assistants</h2>
			<p class="text-xs text-muted-foreground">Tokens for scripts, GRC tools and MCP clients.</p>
		</div>
		<div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
			<a href="/settings/api" class="card flex min-w-0 items-center gap-3 p-3.5 transition-colors hover:bg-accent/60">
				<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><KeyRound class="size-4" /></span>
				<span class="min-w-0 flex-1">
					<span class="block text-[0.8125rem] font-medium">API tokens</span>
					<span class="block truncate text-xs text-muted-foreground">{data.apiTokens} active · read-only REST API</span>
				</span>
				<ChevronRight class="size-4 text-muted-foreground" />
			</a>
			<a href="/settings/api" class="card flex min-w-0 items-center gap-3 p-3.5 transition-colors hover:bg-accent/60">
				<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Bot class="size-4" /></span>
				<span class="min-w-0 flex-1">
					<span class="block text-[0.8125rem] font-medium">MCP</span>
					<span class="block truncate text-xs text-muted-foreground">{data.personalTokens} personal {data.personalTokens === 1 ? 'token' : 'tokens'} · <span class="font-mono">/mcp</span></span>
				</span>
				<ChevronRight class="size-4 text-muted-foreground" />
			</a>
		</div>
	</section>
</div>

<Dialog bind:open={() => open !== null, (v) => { if (!v) open = null; }} title={current ? (current.as !== null ? current.name : `Connect ${current.name}`) : ''} description={current?.as ?? undefined} width={open === 'google' || open === 'slack' ? 'max-w-2xl' : 'max-w-lg'}>
	{#if open === 'slack'}
		<p class="text-xs text-muted-foreground">Approvers get a direct message with Approve and Deny buttons, or reply <strong>y</strong> or <strong>n</strong> in its thread. Anyone can type <span class="font-mono">/access</span> to request access, and requesters hear back in Slack.</p>
		<SlackSettings connected={!!data.slack} slackBase={data.slackBase} shared={data.slackShared} />
	{:else if current}
		<form id="int-form" class="space-y-3" onsubmit={submit}>
			{#if open === 'github'}
				<p class="text-xs text-muted-foreground">Org membership (member/owner) and team membership (member/maintainer). People are added by GitHub username, or invited by email.</p>
				<div><label class="label" for="gho">Organisation</label><input id="gho" class="input font-mono text-xs" placeholder="acme" bind:value={gh.org} required /></div>
				<div>
					<label class="label" for="ght">Token</label>
					<input id="ght" class="input font-mono text-xs" type="password" placeholder={data.github ? '•••••••• saved' : 'github_pat_…'} bind:value={gh.token} />
					<p class="mt-1.5 text-[0.6875rem] text-muted-foreground">Fine-grained token from an org owner with <span class="font-mono">Members: Read and write</span>, or a classic token with <span class="font-mono">admin:org</span>.</p>
				</div>
			{:else if open === 'google'}
				<p class="text-xs text-muted-foreground">
					Group membership (also covers shared drives and apps granted to groups) and account suspension, through a service account with domain-wide delegation.
					<a class="text-primary hover:underline" href={GOOGLE_LINKS.docs} target="_blank" rel="noreferrer">Full guide</a>
				</p>
				<GoogleSetup
					id="int-google"
					scopes={GOOGLE_PROVISIONING_SCOPES}
					other={{ name: 'directory sync', scopes: GOOGLE_DIRECTORY_SCOPES, key: data.directoryGoogleKey }}
					saved={data.google?.serviceAccount ?? null}
					reusesOther
					bind:json={g.serviceAccountJson}
					bind:adminEmail={g.adminEmail}
				/>
			{:else if open === 'okta'}
				<p class="text-xs text-muted-foreground">Group membership (best with group-based app assignments and Group Push) or direct app assignment.</p>
				<div><label class="label" for="okd">Okta domain</label><input id="okd" class="input font-mono text-xs" placeholder="acme.okta.com" bind:value={okta.domain} required /></div>
				<div>
					<label class="label" for="okt">API token</label>
					<input id="okt" class="input font-mono text-xs" type="password" placeholder={data.okta ? '•••••••• saved' : ''} bind:value={okta.apiToken} />
					<p class="mt-1.5 text-[0.6875rem] text-muted-foreground">From an admin with Group Membership Admin and App Admin, or Super Admin.</p>
				</div>
			{:else if open === 'authentik'}
				<p class="text-xs text-muted-foreground">Group membership. Applications are gated by group policy bindings, so the group grants the app.</p>
				<div><label class="label" for="aku">Authentik URL</label><input id="aku" class="input font-mono text-xs" placeholder="https://auth.example.com" bind:value={ak.url} required /></div>
				<div>
					<label class="label" for="akt">API token</label>
					<input id="akt" class="input font-mono text-xs" type="password" placeholder={data.authentik ? '•••••••• saved' : ''} bind:value={ak.token} />
					<p class="mt-1.5 text-[0.6875rem] text-muted-foreground">Directory → Tokens, for a service account allowed to change groups.</p>
				</div>
			{:else if open === 'entra'}
				<p class="text-xs text-muted-foreground">Security group membership through Microsoft Graph. Assign enterprise apps to groups and access follows.</p>
				<div class="grid gap-3 sm:grid-cols-2">
					<div><label class="label" for="ent">Tenant ID</label><input id="ent" class="input font-mono text-xs" bind:value={entra.tenantId} required /></div>
					<div><label class="label" for="enc">Client ID</label><input id="enc" class="input font-mono text-xs" bind:value={entra.clientId} required /></div>
				</div>
				<div>
					<label class="label" for="ens">Client secret</label>
					<input id="ens" class="input font-mono text-xs" type="password" placeholder={data.entra ? '•••••••• saved' : ''} bind:value={entra.clientSecret} />
					<p class="mt-1.5 text-[0.6875rem] text-muted-foreground">App registration with <span class="font-mono">GroupMember.ReadWrite.All</span> (application, admin consent). Dynamic and mail-enabled groups can’t be changed.</p>
				</div>
			{/if}
			{#if reuse(current.kind)}<p class="text-[0.6875rem] text-muted-foreground">Directory sync already uses this IdP: leave the secret blank to reuse its credentials (give them write permission).</p>{/if}
		</form>
	{/if}
	{#snippet footer()}
		{#if open === 'slack'}
			<button class="btn btn-ghost" onclick={() => (open = null)}>Close</button>
		{:else if current}
			{#if current.as !== null}
				<button type="button" class="btn btn-ghost mr-auto text-danger" onclick={() => disconnect(current.kind, current.name)}>Disconnect</button>
				<span class="self-center text-xs text-muted-foreground">{uses(current.kind)} {uses(current.kind) === 1 ? 'resource uses' : 'resources use'} it</span>
			{/if}
			<button class="btn btn-ghost" onclick={() => (open = null)}>Cancel</button>
			<button class="btn btn-primary" form="int-form" disabled={!!busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}{current.as !== null ? 'Save' : 'Connect'}</button>
		{/if}
	{/snippet}
</Dialog>
