<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const next = $derived.by(() => {
		const n = page.url.searchParams.get('next');
		return n?.startsWith('/') && !n.startsWith('//') ? n : '/';
	});

	async function login(email: string, password: string) {
		try {
			await api.post('/api/auth/login', { email, password });
			await invalidateAll();
			goto(next);
		} catch (err) {
			return errorMessage(err);
		}
	}
</script>

<svelte:head><title>Sign in · ac·modern</title></svelte:head>

<AuthCard
	title="Sign in to ac·modern"
	subtitle="Request access, approve it, and see who has what."
	cta="Sign in"
	error={data.error}
	hint={data.cloud ? 'New here? <a class="text-primary hover:underline" href="/signup">Create an organisation</a>' : undefined}
	onsubmit={login}
/>
