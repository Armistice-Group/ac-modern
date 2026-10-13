<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import OrgSignupForm from '#lib/components/OrgSignupForm.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';

	async function submit(v: { orgName: string; name: string; email: string; password: string }) {
		try {
			await api.post('/api/auth/setup', v);
			await invalidateAll();
			goto('/?welcome=1');
		} catch (err) {
			return errorMessage(err);
		}
	}
</script>

<svelte:head><title>Set up · ac·modern</title></svelte:head>

<AuthShell title="Welcome to ac·modern" subtitle="Name your team and create the owner account. You can invite everyone else next." width="max-w-md">
	<OrgSignupForm cta="Create organisation" onsubmit={submit} />
</AuthShell>
