<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Bot, Copy, LoaderCircle, Plus, Trash2 } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { ago, date } from '#lib/format.ts';
	import type { PersonalToken } from '#lib/types.ts';

	let { tokens, mcpUrl }: { tokens: PersonalToken[]; mcpUrl: string } = $props();

	let creating = $state(false);
	let name = $state('');
	let canApprove = $state(false);
	let expires = $state('90');
	let token = $state('');
	let busy = $state(false);
	let client = $state<'code' | 'desktop' | 'other'>('code');
	const copy = (v: string, what = 'Copied') => (navigator.clipboard.writeText(v), toast('success', what));

	const shown = $derived(token || 'acm_pat_…');
	const snippet = $derived(
		client === 'code'
			? `claude mcp add --transport http ac-modern ${mcpUrl} \\\n  --header "Authorization: Bearer ${shown}"`
			: client === 'desktop'
				? JSON.stringify({ mcpServers: { 'ac-modern': { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${shown}`] } } }, null, 2)
				: `URL:    ${mcpUrl}\nHeader: Authorization: Bearer ${shown}\nTransport: Streamable HTTP`
	);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			token = (await api.post<{ token: string }>('/api/account/tokens', { name, canApprove, expiresDays: expires ? Number(expires) : null })).token;
			await invalidateAll();
		} catch (err) {
			toast('error', 'Couldn’t create the token', errorMessage(err));
		} finally {
			busy = false;
		}
	}
	async function revoke(t: PersonalToken) {
		if (!(await confirmAction({ title: `Revoke “${t.name}”?`, body: 'The assistant using it loses access immediately.', danger: true, confirmLabel: 'Revoke' }))) return;
		await api.del(`/api/account/tokens/${t.id}`);
		await invalidateAll();
	}
</script>

<section class="card p-5">
	<div class="flex items-start justify-between gap-4">
		<div>
			<h2 class="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight"><Bot class="size-4 text-primary" />AI assistants (MCP)</h2>
			<p class="mt-1 text-xs text-muted-foreground">Let Claude, Cursor or another MCP client request access, check on requests and, if you allow it, approve, as you. The audit log records it all as done by you via MCP.</p>
		</div>
		<button class="btn btn-secondary shrink-0" onclick={() => ((creating = true), (name = ''), (token = ''), (canApprove = false))}><Plus />New token</button>
	</div>
	{#if tokens.length}
		<ul class="mt-4 divide-y divide-border rounded-xl border border-border">
			{#each tokens as t (t.id)}
				<li class="flex flex-wrap items-center gap-2 px-3 py-2.5 text-[0.8125rem]">
					<span class="font-medium">{t.name}</span>
					{#if t.canApprove}<span class="badge badge-warning">Can approve</span>{/if}
					<span class="flex-1 text-xs text-muted-foreground">{t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'}{t.expiresAt ? ` · expires ${date(t.expiresAt)}` : ''}</span>
					<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Revoke" onclick={() => revoke(t)}><Trash2 /></button>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<Dialog bind:open={creating} title="Connect an AI assistant" description="A personal token that acts as you, through MCP." width="max-w-xl">
	{#if !token}
		<form id="pat-form" class="space-y-3" onsubmit={create}>
			<div class="grid grid-cols-[1fr_9rem] gap-3">
				<div><label class="label" for="pn">Name</label><input id="pn" class="input" placeholder="Claude Code" bind:value={name} required maxlength="80" /></div>
				<div>
					<label class="label" for="pe">Expires</label>
					<select id="pe" class="input" bind:value={expires}><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option></select>
				</div>
			</div>
			<label class="flex items-start gap-2 text-xs">
				<input type="checkbox" class="mt-0.5" bind:checked={canApprove} />
				<span><span class="font-medium">Can approve and deny</span><br /><span class="text-muted-foreground">Off: it can request access and read requests, but approvals stay on the web, email and Slack.</span></span>
			</label>
		</form>
	{:else}
		<div class="space-y-3">
			<div class="flex gap-2"><input class="input font-mono text-xs" readonly value={token} /><button class="btn btn-secondary" onclick={() => copy(token)}><Copy />Copy</button></div>
			<p class="text-[0.6875rem] text-warning">Copy it now; it won’t be shown again.</p>
			<div class="flex gap-1">
				{#each [['code', 'Claude Code'], ['desktop', 'Claude Desktop'], ['other', 'Other clients']] as [k, l] (k)}
					<button class="btn btn-sm {client === k ? 'btn-secondary' : 'btn-ghost'}" onclick={() => (client = k as typeof client)}>{l}</button>
				{/each}
			</div>
			<div class="relative">
				<pre class="overflow-x-auto rounded-lg bg-surface p-3 pr-12 font-mono text-[0.6875rem]">{snippet}</pre>
				<button class="btn btn-ghost btn-icon btn-sm absolute top-1.5 right-1.5" title="Copy" onclick={() => copy(snippet)}><Copy /></button>
			</div>
			{#if client === 'desktop'}<p class="text-[0.6875rem] text-muted-foreground">Add it to <span class="font-mono">claude_desktop_config.json</span> (Settings → Developer → Edit config), then restart Claude.</p>{/if}
		</div>
	{/if}
	{#snippet footer()}
		{#if token}<button class="btn btn-primary" onclick={() => (creating = false)}>Done</button>
		{:else}
			<button class="btn btn-ghost" onclick={() => (creating = false)}>Cancel</button>
			<button class="btn btn-primary" form="pat-form" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{/if}Create token</button>
		{/if}
	{/snippet}
</Dialog>
