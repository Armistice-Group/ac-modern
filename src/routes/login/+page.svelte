<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { KeyRound, LoaderCircle, ShieldCheck } from '@lucide/svelte';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import { api, ApiError, errorMessage } from '#lib/client/api.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	// Plain http to something other than this machine: say so, and point at the real address.
	let insecure = $state(false);
	$effect(() => {
		insecure = location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
	});
	let ssoMode = $state(false);
	let email = $state('');
	let busy = $state(false);
	let error = $state('');

	const next = $derived.by(() => {
		const n = page.url.searchParams.get('next');
		return n?.startsWith('/') && !n.startsWith('//') ? n : '/';
	});
	const withNext = (href: string) => `${href}${href.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}`;

	// Second step: a code from the authenticator app (or a recovery code).
	let ticket = $state('');
	let code = $state('');
	let useRecovery = $state(false);

	async function login(email: string, password: string) {
		try {
			const r = await api.post<{ mfa?: boolean; ticket?: string }>('/api/auth/login', { email, password });
			if (r.mfa && r.ticket) {
				ticket = r.ticket;
				code = '';
				error = '';
				return;
			}
			await invalidateAll();
			goto(next);
		} catch (err) {
			const sso = err instanceof ApiError ? (err.detail as { sso?: string } | undefined)?.sso : undefined;
			if (sso) location.href = withNext(sso);
			return errorMessage(err);
		}
	}

	async function verify(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			const r = await api.post<{ recovery?: boolean }>('/api/auth/mfa', { ticket, code });
			if (r.recovery) sessionStorage.setItem('acm-recovery-used', '1');
			await invalidateAll();
			goto(next);
		} catch (err) {
			const expired = err instanceof ApiError && err.status === 401 && /again/.test(errorMessage(err));
			error = errorMessage(err);
			if (expired) ticket = '';
			busy = false;
		}
	}

	async function lookup(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			const r = await api.post<{ url: string }>('/api/auth/sso-lookup', { email });
			location.href = withNext(r.url);
		} catch (err) {
			error = errorMessage(err);
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · ac·modern</title></svelte:head>

{#if ticket}
	<AuthShell title="Two-step verification" subtitle={useRecovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}>
		<form onsubmit={verify} class="space-y-3">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="input text-center font-mono text-base tracking-[0.3em]"
				inputmode={useRecovery ? 'text' : 'numeric'}
				autocomplete="one-time-code"
				placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
				maxlength={useRecovery ? 11 : 6}
				bind:value={code}
				required
				autofocus
			/>
			<button class="btn btn-primary w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<ShieldCheck />{/if}Verify</button>
			{#if error}<p class="text-center text-xs text-danger">{error}</p>{/if}
		</form>
		<div class="mt-4 flex justify-between text-xs">
			<button class="text-primary hover:underline" onclick={() => ((useRecovery = !useRecovery), (code = ''), (error = ''))}>{useRecovery ? 'Use a code from the app' : 'Use a recovery code'}</button>
			<button class="text-muted-foreground hover:text-foreground" onclick={() => ((ticket = ''), (error = ''))}>Start over</button>
		</div>
	</AuthShell>
{:else if ssoMode}
	<AuthShell title="Sign in with SSO" subtitle="Enter your work email and we’ll send you to your company’s sign-in.">
		<form onsubmit={lookup} class="space-y-3">
			<!-- svelte-ignore a11y_autofocus -->
			<input class="input" type="email" placeholder="you@company.com" autocomplete="email" bind:value={email} required autofocus />
			<button class="btn btn-primary w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<KeyRound />{/if}Continue</button>
			{#if error}<p class="text-center text-xs text-danger">{error}</p>{/if}
		</form>
		<p class="mt-4 text-center text-xs text-muted-foreground"><button class="text-primary hover:underline" onclick={() => (ssoMode = false)}>Sign in with a password</button></p>
	</AuthShell>
{:else}
	<AuthCard
		title="Sign in to ac·modern"
		subtitle={data.ssoRequired ? 'Your organisation requires single sign-on.' : 'Request access, approve it, and see who has what.'}
		cta="Sign in"
		sso={data.sso ? { name: data.sso.name, href: withNext(data.sso.href) } : null}
		error={data.error}
		hint={data.cloud ? 'New here? <a class="text-primary hover:underline" href="/signup">Create an organisation</a>' : undefined}
		onsubmit={login}
	/>
	{#if insecure}
		<div class="fixed inset-x-0 top-6 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-center text-xs text-warning">
			This connection isn’t encrypted, so your password would travel in the clear.
			{#if data.publicUrl?.startsWith('https://')}Sign in at <a class="font-medium underline" href="{data.publicUrl}/login">{data.publicUrl.replace('https://', '')}</a> instead.{:else}Put ac·modern behind HTTPS before using it for real.{/if}
		</div>
	{/if}
	<div class="fixed inset-x-0 bottom-8 flex items-center justify-center gap-3 text-xs">
		<a class="btn btn-ghost btn-sm" href="/forgot-password">Forgot password?</a>
		{#if data.cloud}<button class="btn btn-secondary btn-sm" onclick={() => (ssoMode = true)}><KeyRound />Sign in with SSO</button>{/if}
	</div>
{/if}
