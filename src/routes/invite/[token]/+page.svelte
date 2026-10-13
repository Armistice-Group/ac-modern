<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { LoaderCircle } from '@lucide/svelte';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import OrgSignupForm from '#lib/components/OrgSignupForm.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	async function accept(body: Record<string, string>) {
		try {
			await api.post('/api/auth/invite', { token: page.params.token, ...body });
			await invalidateAll();
			goto('/?welcome=1');
		} catch (err) {
			return errorMessage(err);
		}
	}

	async function signInAndAccept(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = (await accept({ password })) ?? '';
		busy = false;
	}
</script>

<svelte:head><title>Join · ac·modern</title></svelte:head>

{#if !data.invite}
	<AuthShell title="This invite link has expired" subtitle="Invites last 14 days and work once. Ask whoever invited you for a new one.">
		<a href="/login" class="btn btn-secondary w-full">Go to sign in</a>
	</AuthShell>
{:else}
	<AuthShell title="Join {data.invite.orgName}" subtitle="{data.invite.inviter ?? 'An admin'} invited {data.invite.email}." width="max-w-md">
		{#if data.signedInAs === data.invite.email}
			<button class="btn btn-primary w-full" onclick={async () => (error = (await accept({})) ?? '')}>Join {data.invite.orgName}</button>
			{#if error}<p class="mt-3 text-center text-xs text-danger">{error}</p>{/if}
		{:else if data.hasAccount}
			<form onsubmit={signInAndAccept} class="space-y-3">
				<div>
					<label class="label" for="email">Email</label>
					<input id="email" class="input" value={data.invite.email} disabled />
				</div>
				<div>
					<label class="label" for="pw">Your ac·modern password</label>
					<!-- svelte-ignore a11y_autofocus -->
					<input id="pw" class="input" type="password" autocomplete="current-password" bind:value={password} required autofocus />
				</div>
				<button class="btn btn-primary mt-2 w-full" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Sign in and join</button>
				{#if error}<p class="text-center text-xs text-danger">{error}</p>{/if}
			</form>
		{:else}
			<OrgSignupForm cta="Create account and join" askOrg={false} email={data.invite.email} onsubmit={(v) => accept({ name: v.name, password: v.password })} />
		{/if}
	</AuthShell>
{/if}
