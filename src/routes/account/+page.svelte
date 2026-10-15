<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import McpTokens from './McpTokens.svelte';
	import TwoStep from './TwoStep.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let name = $state('');
	let github = $state('');
	let current = $state('');
	let next = $state('');
	$effect(() => {
		name = page.data.viewer?.name ?? '';
		github = data.githubLogin;
	});

	async function saveName(e: SubmitEvent) {
		e.preventDefault();
		try {
			await api.patch('/api/account', { name, githubLogin: github });
			toast('success', 'Saved');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		}
	}

	async function savePassword(e: SubmitEvent) {
		e.preventDefault();
		try {
			await api.patch('/api/account', { currentPassword: current, newPassword: next });
			toast('success', 'Password changed', 'Other devices have been signed out.');
			current = next = '';
		} catch (err) {
			toast('error', 'Couldn’t change it', errorMessage(err));
		}
	}
</script>

<svelte:head><title>Account · ac·modern</title></svelte:head>

<PageHeader title="Your account" description={page.data.viewer?.email} />

<div class="max-w-xl space-y-6 px-8 pb-10">
	{#if data.mfaSetupRequired && data.mfa}<TwoStep mfa={data.mfa} requiredBy={data.mfaRequiredBy} setupRequired hasPassword={data.hasPassword} />{/if}
	<form class="card p-5" onsubmit={saveName}>
		<div class="grid gap-3 sm:grid-cols-2">
			<div><label class="label" for="name">Name</label><input id="name" class="input" bind:value={name} maxlength="120" /></div>
			<div><label class="label" for="gh">GitHub username</label><input id="gh" class="input font-mono text-xs" placeholder="octocat" bind:value={github} maxlength="40" /></div>
		</div>
		<p class="mt-2 text-[0.6875rem] text-muted-foreground">Your GitHub username lets approved GitHub access be added and removed automatically.</p>
		<button class="btn btn-secondary mt-3">Save</button>
	</form>
	<form class="card space-y-3 p-5" onsubmit={savePassword}>
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Change password</h2>
		<div>
			<label class="label" for="cur">Current password</label>
			<input id="cur" class="input" type="password" autocomplete="current-password" bind:value={current} required />
		</div>
		<div>
			<label class="label" for="new">New password</label>
			<input id="new" class="input" type="password" autocomplete="new-password" minlength="8" bind:value={next} required />
		</div>
		<button class="btn btn-primary">Change password</button>
	</form>
	{#if !data.mfaSetupRequired && data.mfa}<TwoStep mfa={data.mfa} requiredBy={data.mfaRequiredBy} setupRequired={false} hasPassword={data.hasPassword} />{/if}
	{#if page.data.org && !data.mfaSetupRequired}<McpTokens tokens={data.tokens} mcpUrl={data.mcpUrl} />{/if}
</div>
