<script lang="ts">
	import { LoaderCircle, MailCheck } from '@lucide/svelte';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';

	let email = $state('');
	let busy = $state(false);
	let sent = $state(false);
	let error = $state('');

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await api.post('/api/auth/forgot', { email });
			sent = true;
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Reset password · ac·modern</title></svelte:head>

<AuthShell title={sent ? 'Check your email' : 'Reset your password'} subtitle={sent ? `If ${email} has an account, a link to set a new password is on its way. It works once and expires in an hour.` : 'Enter your email and we’ll send you a link to set a new password.'}>
	{#if sent}
		<div class="flex flex-col items-center gap-4">
			<span class="grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><MailCheck class="size-5" /></span>
			<p class="text-center text-xs text-muted-foreground">No email? Check spam, or ask an admin to send you a link. On a self-hosted install without email set up, the link is in the server log.</p>
			<a href="/login" class="btn btn-secondary w-full">Back to sign in</a>
		</div>
	{:else}
		<form onsubmit={submit} class="space-y-3">
			<!-- svelte-ignore a11y_autofocus -->
			<input class="input" type="email" placeholder="you@company.com" autocomplete="email" bind:value={email} required autofocus />
			<button class="btn btn-primary w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Send reset link</button>
			{#if error}<p class="text-center text-xs text-danger">{error}</p>{/if}
		</form>
		<p class="mt-4 text-center text-xs text-muted-foreground"><a class="text-primary hover:underline" href="/login">Back to sign in</a></p>
	{/if}
</AuthShell>
