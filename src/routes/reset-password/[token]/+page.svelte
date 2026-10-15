<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { LoaderCircle } from '@lucide/svelte';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let password = $state('');
	let repeat = $state('');
	let busy = $state(false);
	let error = $state('');

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (password !== repeat) return void (error = 'Passwords don’t match');
		if (password.length < 8) return void (error = 'Use at least 8 characters');
		busy = true;
		try {
			const r = await api.post<{ signIn?: boolean }>('/api/auth/reset', { token: page.params.token, password });
			toast('success', 'Password changed', r.signIn ? 'Sign in with it and a code from your authenticator app.' : 'You’ve been signed out everywhere else.');
			await invalidateAll();
			goto(r.signIn ? '/login' : '/');
		} catch (err) {
			error = errorMessage(err);
			busy = false;
		}
	}
</script>

<svelte:head><title>Set a new password · ac·modern</title></svelte:head>

{#if !data.email}
	<AuthShell title="This link has expired" subtitle="Reset links work once and expire. Ask for a new one.">
		<a href="/forgot-password" class="btn btn-primary w-full">Send a new link</a>
	</AuthShell>
{:else}
	<AuthShell title="Set a new password" subtitle="For {data.email}">
		<form onsubmit={submit} class="space-y-3">
			<div>
				<label class="label" for="pw">New password</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input id="pw" class="input" type="password" autocomplete="new-password" bind:value={password} required autofocus />
			</div>
			<div>
				<label class="label" for="pw2">Repeat it</label>
				<input id="pw2" class="input" type="password" autocomplete="new-password" bind:value={repeat} required />
			</div>
			<button class="btn btn-primary mt-2 w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Set password and sign in</button>
			{#if error}<p class="text-center text-xs text-danger">{error}</p>{/if}
		</form>
	</AuthShell>
{/if}
