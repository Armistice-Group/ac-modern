<script lang="ts">
	import BrandLogo, { type Brand } from './BrandLogo.svelte';
	import { KeyRound, LoaderCircle } from '@lucide/svelte';
	import Logo from './Logo.svelte';

	let {
		title,
		subtitle,
		cta,
		confirm = false,
		showForm = true,
		sso,
		error: initialError = '',
		hint,
		onsubmit
	}: {
		title: string;
		subtitle: string;
		cta: string;
		confirm?: boolean;
		/** False hides the email/password form (SSO-only). */
		showForm?: boolean;
		/** SSO button: label and start URL. */
		sso?: { name: string; href: string; brand?: Brand | null } | null;
		error?: string;
		/** Small note under the form. */
		hint?: string;
		onsubmit: (email: string, password: string) => Promise<string | void>;
	} = $props();

	let email = $state('');
	let password = $state('');
	let repeat = $state('');
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		error = initialError;
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (confirm && password !== repeat) {
			error = 'Passwords do not match';
			return;
		}
		busy = true;
		error = (await onsubmit(email, password)) ?? '';
		busy = false;
	}
</script>

<div class="relative grid min-h-dvh place-items-center overflow-hidden px-4">
	<div class="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70"></div>
	<div class="glow-top pointer-events-none absolute inset-x-0 top-0 h-[480px]"></div>

	<div class="card relative w-full max-w-sm p-7 shadow-surface-lg">
		<div class="mb-6 flex flex-col items-center text-center">
			<Logo size={44} />
			<h1 class="mt-4 text-lg font-semibold tracking-tight">{title}</h1>
			<p class="mt-1 text-[0.8125rem] text-muted-foreground">{subtitle}</p>
		</div>

		{#if sso}
			<a class="btn btn-primary h-9 w-full" href={sso.href} data-sveltekit-reload>{#if sso.brand}<span class="grid size-5 place-items-center rounded-md bg-white text-black"><BrandLogo brand={sso.brand} class="size-3.5" /></span>{:else}<KeyRound />{/if}Continue with {sso.name}</a>
			{#if showForm}
				<div class="my-5 flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
					<span class="h-px flex-1 bg-border"></span>or<span class="h-px flex-1 bg-border"></span>
				</div>
			{/if}
		{/if}

		{#if showForm}
			<form onsubmit={submit}>
				<label class="label" for="email">Email</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input id="email" class="input" type="email" autocomplete="username" autofocus={!sso} bind:value={email} required />
				<label class="label mt-3" for="pw">Password</label>
				<input id="pw" class="input" type="password" autocomplete={confirm ? 'new-password' : 'current-password'} bind:value={password} required />
				{#if confirm}
					<label class="label mt-3" for="pw2">Repeat password</label>
					<input id="pw2" class="input" type="password" autocomplete="new-password" bind:value={repeat} required />
				{/if}
				<button class="btn mt-5 h-9 w-full {sso ? 'btn-secondary' : 'btn-primary'}" disabled={busy}>
					{#if busy}<LoaderCircle class="animate-spin" />{/if}{cta}
				</button>
			</form>
		{/if}
		{#if error}<p class="mt-3 text-center text-xs text-danger">{error}</p>{/if}
		{#if hint && showForm}
			<p class="mt-4 rounded-lg bg-surface px-3 py-2 text-center text-[0.6875rem] text-muted-foreground">{@html hint}</p>
		{/if}
	</div>
</div>
