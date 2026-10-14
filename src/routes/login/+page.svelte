<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { KeyRound, LoaderCircle } from '@lucide/svelte';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import { api, ApiError, errorMessage } from '#lib/client/api.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let ssoMode = $state(false);
	let email = $state('');
	let busy = $state(false);
	let error = $state('');

	const next = $derived.by(() => {
		const n = page.url.searchParams.get('next');
		return n?.startsWith('/') && !n.startsWith('//') ? n : '/';
	});
	const withNext = (href: string) => `${href}${href.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}`;

	async function login(email: string, password: string) {
		try {
			await api.post('/api/auth/login', { email, password });
			await invalidateAll();
			goto(next);
		} catch (err) {
			const sso = err instanceof ApiError ? (err.detail as { sso?: string } | undefined)?.sso : undefined;
			if (sso) location.href = withNext(sso);
			return errorMessage(err);
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

{#if ssoMode}
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
	<div class="fixed inset-x-0 bottom-8 flex items-center justify-center gap-3 text-xs">
		<a class="btn btn-ghost btn-sm" href="/forgot-password">Forgot password?</a>
		{#if data.cloud}<button class="btn btn-secondary btn-sm" onclick={() => (ssoMode = true)}><KeyRound />Sign in with SSO</button>{/if}
	</div>
{/if}
