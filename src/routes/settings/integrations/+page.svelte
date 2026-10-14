<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { CircleCheck, LoaderCircle, GitBranch, Mail, MessageSquare, ShieldCheck, Fingerprint, Building2 } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import SlackSettings from './SlackSettings.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let gh = $state({ org: '', token: '' });
	let g = $state({ serviceAccountJson: '', adminEmail: '' });
	let okta = $state({ domain: '', apiToken: '' });
	let ak = $state({ url: '', token: '' });
	let entra = $state({ tenantId: '', clientId: '', clientSecret: '' });
	let busy = $state<string | null>(null);
	$effect(() => {
		gh = { org: data.github?.org ?? '', token: '' };
		g = { serviceAccountJson: '', adminEmail: data.google?.adminEmail ?? '' };
		okta = { domain: data.okta?.domain ?? '', apiToken: '' };
		ak = { url: data.authentik?.url ?? '', token: '' };
		entra = { tenantId: data.entra?.tenantId ?? '', clientId: data.entra?.clientId ?? '', clientSecret: '' };
	});
	const reuse = (kind: string) => data.directory === kind;

	async function connect(kind: string, body: Record<string, string>) {
		busy = kind;
		try {
			const r = await api.put<{ as?: string; org?: string }>(`/api/settings/integrations/${kind}`, body);
			toast('success', `Connected${r.org ? ` to ${r.org}` : ''}`, r.as ? `Acting as ${r.as}` : undefined);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t connect', errorMessage(err));
		} finally {
			busy = null;
		}
	}
	async function disconnect(kind: string, name: string) {
		if (!(await confirmAction({ title: `Disconnect ${name}?`, body: 'Resources set up through it must be switched to another method first.', danger: true, confirmLabel: 'Disconnect' }))) return;
		try {
			await api.del(`/api/settings/integrations/${kind}`);
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t disconnect', errorMessage(err));
		}
	}
</script>

<svelte:head><title>Integrations · ac·modern</title></svelte:head>

<div class="max-w-3xl space-y-6 px-8 pb-10">
	<h2 class="text-[0.9375rem] font-semibold tracking-tight">Apps</h2>
	<p class="-mt-4 text-xs text-muted-foreground">Connect a system once, then choose it as the setup method on a resource and say what each access level means there. Approved requests are set up and removed automatically; if that fails, the fulfillers get the task with the error.</p>

	<section class="card p-5">
		<div class="flex items-start gap-3">
			<span class="grid size-9 place-items-center rounded-lg bg-muted"><GitBranch class="size-4" /></span>
			<div class="flex-1">
				<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">GitHub {#if data.github}<span class="badge badge-success"><CircleCheck />{data.github.org}</span>{/if}</h2>
				<p class="text-xs text-muted-foreground">Org membership (member/owner) and team membership (member/maintainer). People are added by GitHub username, or invited by email if it’s not on their profile yet.</p>
			</div>
		</div>
		<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={(e) => (e.preventDefault(), connect('github', gh))}>
			<div><label class="label" for="gho">Organisation</label><input id="gho" class="input font-mono text-xs" placeholder="acme" bind:value={gh.org} required /></div>
			<div>
				<label class="label" for="ght">Token</label>
				<input id="ght" class="input font-mono text-xs" type="password" placeholder={data.github ? '•••••••• saved' : 'github_pat_… (Members: read & write)'} bind:value={gh.token} />
			</div>
			<p class="text-[0.6875rem] text-muted-foreground sm:col-span-2">Use a fine-grained token owned by an org owner, with organisation permission <span class="font-mono">Members: Read and write</span> (or a classic token with <span class="font-mono">admin:org</span>).</p>
			<div class="flex gap-2 sm:col-span-2">
				<button class="btn btn-primary" disabled={!!busy}>{#if busy === 'github'}<LoaderCircle class="animate-spin" />{/if}{data.github ? 'Save' : 'Connect'}</button>
				{#if data.github}
					<span class="self-center text-xs text-muted-foreground">{data.usage.github ?? 0} {data.usage.github === 1 ? 'resource uses' : 'resources use'} it</span>
					<button type="button" class="btn btn-ghost ml-auto" onclick={() => disconnect('github', 'GitHub')}>Disconnect</button>
				{/if}
			</div>
		</form>
	</section>

	<section class="card p-5">
		<div class="flex items-start gap-3">
			<span class="grid size-9 place-items-center rounded-lg bg-muted"><Mail class="size-4" /></span>
			<div class="flex-1">
				<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">Google Workspace {#if data.google}<span class="badge badge-success"><CircleCheck />{data.google.adminEmail}</span>{/if}</h2>
				<p class="text-xs text-muted-foreground">Group membership (member/manager/owner), which also covers shared drives and apps granted to groups, and account suspension.</p>
			</div>
		</div>
		<form class="mt-4 space-y-3" onsubmit={(e) => (e.preventDefault(), connect('google', g))}>
			<p class="text-[0.6875rem] text-muted-foreground">
				A service account with domain-wide delegation for <span class="font-mono">admin.directory.group.member</span> and <span class="font-mono">admin.directory.user</span>{data.google?.serviceAccount ? ` (using ${data.google.serviceAccount})` : ''}. It can be the same one as directory sync, with these scopes added.
			</p>
			<textarea class="input h-20 resize-none py-2 font-mono text-[0.6875rem]" placeholder={data.google ? '•••••••• key saved. Paste a new one to replace it' : 'Service account JSON key'} bind:value={g.serviceAccountJson}></textarea>
			<input class="input" type="email" placeholder="Admin to act as (admin@acme.com)" bind:value={g.adminEmail} required />
			<div class="flex gap-2">
				<button class="btn btn-primary" disabled={!!busy}>{#if busy === 'google'}<LoaderCircle class="animate-spin" />{/if}{data.google ? 'Save' : 'Connect'}</button>
				{#if data.google}
					<span class="self-center text-xs text-muted-foreground">{data.usage.google ?? 0} {data.usage.google === 1 ? 'resource uses' : 'resources use'} it</span>
					<button type="button" class="btn btn-ghost ml-auto" onclick={() => disconnect('google', 'Google Workspace')}>Disconnect</button>
				{/if}
			</div>
		</form>
	</section>

	<h2 class="pt-2 text-[0.9375rem] font-semibold tracking-tight">Identity providers</h2>
	<p class="-mt-4 text-xs text-muted-foreground">Grant access by adding people to an IdP group (or app). Your IdP then signs them in to the app, and provisions them there if it supports SCIM, so one integration covers every app behind it.</p>

	{#snippet idpCard(kind: string, name: string, Icon: typeof Mail, connectedAs: string | null, what: string, help: string, form: import('svelte').Snippet)}
		<section class="card p-5">
			<div class="flex items-start gap-3">
				<span class="grid size-9 place-items-center rounded-lg bg-muted"><Icon class="size-4" /></span>
				<div class="flex-1">
					<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">{name} {#if connectedAs !== null}<span class="badge badge-success"><CircleCheck />{connectedAs}</span>{/if}</h2>
					<p class="text-xs text-muted-foreground">{what}</p>
				</div>
			</div>
			<p class="mt-3 text-[0.6875rem] text-muted-foreground">{help}{reuse(kind) ? ' Directory sync already uses this IdP: leave the secret blank to reuse its credentials (give them write permission).' : ''}</p>
			<form class="mt-3 grid gap-3 sm:grid-cols-2" onsubmit={(e) => e.preventDefault()}>
				{@render form()}
				<div class="flex gap-2 sm:col-span-2">
					<button class="btn btn-primary" disabled={!!busy} onclick={() => connect(kind, kind === 'okta' ? okta : kind === 'authentik' ? ak : entra)}>{#if busy === kind}<LoaderCircle class="animate-spin" />{/if}{connectedAs !== null ? 'Save' : 'Connect'}</button>
					{#if connectedAs !== null}
						<span class="self-center text-xs text-muted-foreground">{data.usage[kind] ?? 0} {data.usage[kind] === 1 ? 'resource uses' : 'resources use'} it</span>
						<button type="button" class="btn btn-ghost ml-auto" onclick={() => disconnect(kind, name)}>Disconnect</button>
					{/if}
				</div>
			</form>
		</section>
	{/snippet}

	{#snippet oktaForm()}
		<div><label class="label" for="okd">Okta domain</label><input id="okd" class="input font-mono text-xs" placeholder="acme.okta.com" bind:value={okta.domain} /></div>
		<div><label class="label" for="okt">API token</label><input id="okt" class="input font-mono text-xs" type="password" placeholder={data.okta ? '•••••••• saved' : ''} bind:value={okta.apiToken} /></div>
	{/snippet}
	{#snippet akForm()}
		<div><label class="label" for="aku">Authentik URL</label><input id="aku" class="input font-mono text-xs" placeholder="https://auth.example.com" bind:value={ak.url} /></div>
		<div><label class="label" for="akt">API token</label><input id="akt" class="input font-mono text-xs" type="password" placeholder={data.authentik ? '•••••••• saved' : ''} bind:value={ak.token} /></div>
	{/snippet}
	{#snippet entraForm()}
		<div><label class="label" for="ent">Tenant ID</label><input id="ent" class="input font-mono text-xs" bind:value={entra.tenantId} /></div>
		<div><label class="label" for="enc">Client ID</label><input id="enc" class="input font-mono text-xs" bind:value={entra.clientId} /></div>
		<div class="sm:col-span-2"><label class="label" for="ens">Client secret</label><input id="ens" class="input font-mono text-xs" type="password" placeholder={data.entra ? '•••••••• saved' : ''} bind:value={entra.clientSecret} /></div>
	{/snippet}

	{@render idpCard('okta', 'Okta', ShieldCheck, data.okta ? data.okta.domain : null, 'Group membership (recommended: group-based app assignments and Group Push carry it into each app) or direct app assignment.', 'An API token created by an admin with Group Membership Admin (for groups) and App Admin (for app assignments), or Super Admin.', oktaForm)}
	{@render idpCard('authentik', 'Authentik', Fingerprint, data.authentik ? data.authentik.url.replace(/^https?:\/\//, '') : null, 'Group membership. Authentik applications are gated by group policy bindings, so the group grants the app.', 'An API token (Directory → Tokens) for a service account allowed to change groups.', akForm)}
	{@render idpCard('entra', 'Microsoft Entra ID', Building2, data.entra ? 'Connected' : null, 'Security group membership through Microsoft Graph. Assign enterprise apps to groups and access follows.', 'An app registration with the application permission GroupMember.ReadWrite.All (admin consent) and a client secret. Dynamic and mail-enabled groups can’t be changed this way.', entraForm)}

	<h2 class="pt-2 text-[0.9375rem] font-semibold tracking-tight">Notifications</h2>
	<section class="card p-5">
		<div class="flex items-start gap-3">
			<span class="grid size-9 place-items-center rounded-lg bg-muted"><MessageSquare class="size-4" /></span>
			<div class="flex-1">
				<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">Slack app {#if data.slack}<span class="badge badge-success"><CircleCheck />{data.slack.team || 'Connected'}</span>{/if}</h2>
				<p class="text-xs text-muted-foreground">Approvers get a direct message with Approve and Deny buttons; requesters hear back in Slack.</p>
			</div>
		</div>
		<SlackSettings connected={!!data.slack} interactionsUrl={data.slackEventsUrl} shared={data.slackShared} />
	</section>
</div>
