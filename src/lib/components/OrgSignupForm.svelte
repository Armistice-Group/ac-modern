<script lang="ts">
	import { LoaderCircle } from '@lucide/svelte';
	let {
		cta,
		askOrg = true,
		askAccount = true,
		email: fixedEmail = '',
		onsubmit
	}: {
		cta: string;
		askOrg?: boolean;
		askAccount?: boolean;
		/** Pre-filled and locked (invites). */
		email?: string;
		onsubmit: (v: { orgName: string; name: string; email: string; password: string }) => Promise<string | void>;
	} = $props();

	let orgName = $state('');
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let repeat = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (askAccount && password !== repeat) return void (error = 'Passwords don’t match');
		if (askAccount && password.length < 8) return void (error = 'Use at least 8 characters for the password');
		busy = true;
		error = (await onsubmit({ orgName, name, email: fixedEmail || email, password })) ?? '';
		busy = false;
	}
</script>

<form onsubmit={submit} class="space-y-3">
	{#if askOrg}
		<div>
			<label class="label" for="org">Team or company name</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="org" class="input" placeholder="Acme Inc." bind:value={orgName} required autofocus />
		</div>
	{/if}
	{#if askAccount}
		<div>
			<label class="label" for="name">Your name</label>
			<input id="name" class="input" autocomplete="name" bind:value={name} required />
		</div>
		<div>
			<label class="label" for="email">Work email</label>
			{#if fixedEmail}
				<input id="email" class="input" value={fixedEmail} disabled />
			{:else}
				<input id="email" class="input" type="email" autocomplete="email" bind:value={email} required />
			{/if}
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="pw">Password</label>
				<input id="pw" class="input" type="password" autocomplete="new-password" bind:value={password} required />
			</div>
			<div>
				<label class="label" for="pw2">Repeat</label>
				<input id="pw2" class="input" type="password" autocomplete="new-password" bind:value={repeat} required />
			</div>
		</div>
	{/if}
	<button class="btn btn-primary mt-2 h-9 w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}{cta}</button>
	{#if error}<p class="text-center text-xs text-danger">{error}</p>{/if}
</form>
