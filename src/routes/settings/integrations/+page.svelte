<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { CircleCheck, LoaderCircle, GitBranch, Mail, MessageSquare } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import SlackSettings from './SlackSettings.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let gh = $state({ org: '', token: '' });
	let g = $state({ serviceAccountJson: '', adminEmail: '' });
	let busy = $state<string | null>(null);
	$effect(() => {
		gh = { org: data.github?.org ?? '', token: '' };
		g = { serviceAccountJson: '', adminEmail: data.google?.adminEmail ?? '' };
	});

	async function connect(kind: 'github' | 'google', body: Record<string, string>) {
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
	async function disconnect(kind: 'github' | 'google', name: string) {
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
	<p class="text-xs text-muted-foreground">Connect a system once, then choose it as the setup method on a resource and say what each access level means there. Approved requests are set up and removed automatically; if that fails, the fulfillers get the task with the error.</p>

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
