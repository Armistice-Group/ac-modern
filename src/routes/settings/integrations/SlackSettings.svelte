<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Copy, LoaderCircle, ExternalLink } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';

	let { connected, slackBase, shared }: { connected: boolean; slackBase: string; shared: boolean } = $props();
	let botToken = $state('');
	let signingSecret = $state('');
	let busy = $state(false);
	let manifestUrl = $state('');
	let manifestJson = $state('');

	$effect(() => {
		const msg = page.url.searchParams.get('slack');
		if (msg) toast(msg === 'connected' ? 'success' : 'error', msg === 'connected' ? 'Slack connected' : 'Slack didn’t connect', msg === 'connected' ? undefined : msg);
	});
	$effect(() => {
		if (shared) return;
		api.get<object>('/api/settings/slack').then((m) => {
			manifestJson = JSON.stringify(m, null, 2);
			manifestUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(m))}`;
		});
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api.put<{ team: string }>('/api/settings/slack', { botToken, signingSecret });
			toast('success', `Connected to ${r.team}`);
			botToken = signingSecret = '';
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t connect', errorMessage(err));
		} finally {
			busy = false;
		}
	}
	async function disconnect() {
		if (!(await confirmAction({ title: 'Disconnect Slack?', body: 'Approvals and updates go by email only.', confirmLabel: 'Disconnect' }))) return;
		await api.del('/api/settings/slack');
		await invalidateAll();
	}
</script>

{#if shared}
	<div class="mt-4 flex gap-2">
		<a class="btn btn-primary" href="/api/slack/install" data-sveltekit-reload>{connected ? 'Reinstall in Slack' : 'Add to Slack'}</a>
		{#if connected}<button class="btn btn-ghost ml-auto" onclick={disconnect}>Disconnect</button>{/if}
	</div>
{:else}
	<ol class="mt-4 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
		<li><a class="text-primary hover:underline" href={manifestUrl} target="_blank" rel="noreferrer">Create the Slack app from our manifest <ExternalLink class="inline size-3" /></a>. Slack must be able to reach <span class="font-mono">{slackBase}</span> without signing in.</li>
		<li>Install it to your workspace, then paste the Bot User OAuth Token and the Signing Secret (Basic Information).</li>
		<li>In the app’s <strong>Event Subscriptions</strong>, click <strong>Retry</strong> next to the request URL if it isn’t verified yet.</li>
	</ol>
	{#if connected}
		<p class="mt-2 text-xs text-muted-foreground">
			Made the app before <span class="font-mono">/access</span> and thread replies existed? In the app’s <strong>App Manifest</strong> page, replace the manifest with
			<button type="button" class="inline-flex items-center gap-1 text-primary hover:underline" onclick={() => (navigator.clipboard.writeText(manifestJson), toast('success', 'Manifest copied'))}><Copy class="size-3" />ours</button>, save, and reinstall the app when Slack asks.
		</p>
	{/if}
	<form class="mt-3 grid gap-3 sm:grid-cols-2" onsubmit={save}>
		<input class="input font-mono text-xs" type="password" placeholder={connected ? '•••••••• bot token saved' : 'xoxb-…'} bind:value={botToken} required />
		<input class="input font-mono text-xs" type="password" placeholder="Signing secret" bind:value={signingSecret} required />
		<div class="flex gap-2 sm:col-span-2">
			<button class="btn btn-primary" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}{connected ? 'Update' : 'Connect'}</button>
			{#if connected}<button type="button" class="btn btn-ghost ml-auto" onclick={disconnect}>Disconnect</button>{/if}
		</div>
	</form>
{/if}
