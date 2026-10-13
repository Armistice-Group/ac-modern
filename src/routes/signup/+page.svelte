<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import OrgSignupForm from '#lib/components/OrgSignupForm.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	async function submit(v: { orgName: string; name: string; email: string; password: string }) {
		try {
			await api.post('/api/auth/signup', v);
			await invalidateAll();
			goto('/?welcome=1');
		} catch (err) {
			return errorMessage(err);
		}
	}
</script>

<svelte:head><title>Create an organisation · ac·modern</title></svelte:head>

<AuthShell
	title={data.signedIn ? 'New organisation' : 'Start with ac·modern'}
	subtitle={data.signedIn ? `You’ll be its owner (${data.email}).` : 'Access requests and approvals for your team, without the helpdesk.'}
	width="max-w-md"
>
	<OrgSignupForm cta="Create organisation" askAccount={!data.signedIn} onsubmit={submit} />
	{#if !data.signedIn}
		<p class="mt-4 text-center text-xs text-muted-foreground">Already have an account? <a class="text-primary hover:underline" href="/login">Sign in</a></p>
	{/if}
</AuthShell>
