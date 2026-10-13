<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';

	let name = $state('');
	let current = $state('');
	let next = $state('');
	$effect(() => {
		name = page.data.viewer?.name ?? '';
	});

	async function saveName(e: SubmitEvent) {
		e.preventDefault();
		try {
			await api.patch('/api/account', { name });
			toast('success', 'Saved');
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t save', errorMessage(err));
		}
	}

	async function savePassword(e: SubmitEvent) {
		e.preventDefault();
		try {
			await api.patch('/api/account', { currentPassword: current, newPassword: next });
			toast('success', 'Password changed', 'Other devices have been signed out.');
			current = next = '';
		} catch (err) {
			toast('error', 'Couldn’t change it', errorMessage(err));
		}
	}
</script>

<svelte:head><title>Account · ac·modern</title></svelte:head>

<PageHeader title="Your account" description={page.data.viewer?.email} />

<div class="max-w-xl space-y-6 px-8 pb-10">
	<form class="card p-5" onsubmit={saveName}>
		<label class="label" for="name">Name</label>
		<div class="flex gap-2">
			<input id="name" class="input" bind:value={name} maxlength="120" />
			<button class="btn btn-secondary">Save</button>
		</div>
	</form>
	<form class="card space-y-3 p-5" onsubmit={savePassword}>
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">Change password</h2>
		<div>
			<label class="label" for="cur">Current password</label>
			<input id="cur" class="input" type="password" autocomplete="current-password" bind:value={current} required />
		</div>
		<div>
			<label class="label" for="new">New password</label>
			<input id="new" class="input" type="password" autocomplete="new-password" minlength="8" bind:value={next} required />
		</div>
		<button class="btn btn-primary">Change password</button>
	</form>
</div>
