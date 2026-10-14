<script lang="ts">
	import { CircleAlert, CircleCheck, Copy, ExternalLink } from '@lucide/svelte';
	import { toast } from '#lib/client/state.svelte.ts';
	import { GOOGLE_LINKS, parseServiceAccountKey } from '#lib/google.ts';

	type Key = { clientId: string; email: string };
	interface Props {
		/** Scopes this feature needs. */
		scopes: string[];
		/** What the other Google feature is, and its scopes, in case it uses the same key. */
		other?: { name: string; scopes: string[]; key: Key | null };
		/** The key already saved for this feature, if any. */
		saved: Key | null;
		/** Saving with no key pasted reuses the other feature's key. */
		reusesOther?: boolean;
		json: string;
		adminEmail: string;
		id: string;
	}
	let { scopes, other, saved, reusesOther = false, json = $bindable(), adminEmail = $bindable(), id }: Props = $props();

	const pasted = $derived(json.trim() ? parseServiceAccountKey(json) : null);
	const key = $derived<Key | null>(pasted && !('error' in pasted) ? { clientId: pasted.clientId, email: pasted.clientEmail } : (saved ?? (reusesOther ? (other?.key ?? null) : null)));
	// Domain-wide delegation has one entry per client ID: adding it again replaces the scopes,
	// so a key shared by both features needs both sets in the one entry.
	const shared = $derived(!!key && !!other?.key && other.key.clientId === key.clientId);
	const allScopes = $derived(shared && other ? [...new Set([...scopes, ...other.scopes])] : scopes);
	const copy = (v: string, what: string) => (navigator.clipboard.writeText(v), toast('success', `${what} copied`));
</script>

<ol class="space-y-4 text-xs">
	<li class="flex gap-3">
		<span class="step">1</span>
		<div class="min-w-0 flex-1 space-y-1">
			<p class="text-[0.8125rem] font-medium">Turn on the Admin SDK API</p>
			<p class="text-muted-foreground">In the Google Cloud console, pick a project (or create one, e.g. <em>ac-modern</em>) and click <strong>Enable</strong>.</p>
			<a class="link" href={GOOGLE_LINKS.adminSdk} target="_blank" rel="noreferrer">Open the Admin SDK API<ExternalLink class="size-3" /></a>
		</div>
	</li>
	<li class="flex gap-3">
		<span class="step">2</span>
		<div class="min-w-0 flex-1 space-y-1">
			<p class="text-[0.8125rem] font-medium">Create a service account</p>
			<p class="text-muted-foreground">In the same project: <strong>IAM &amp; Admin → Service accounts → Create service account</strong>. Any name works. Skip the optional steps: it needs no project roles.</p>
			<a class="link" href={GOOGLE_LINKS.serviceAccounts} target="_blank" rel="noreferrer">Open service accounts<ExternalLink class="size-3" /></a>
		</div>
	</li>
	<li class="flex gap-3">
		<span class="step">3</span>
		<div class="min-w-0 flex-1 space-y-2">
			<p class="text-[0.8125rem] font-medium">Create a JSON key and paste it here</p>
			<p class="text-muted-foreground">Open the service account → <strong>Keys → Add key → Create new key → JSON</strong>. A file downloads; paste all of it.</p>
			<textarea
				id="{id}-key"
				class="input h-24 resize-none py-2 font-mono text-[0.6875rem]"
				placeholder={saved ? `Key for ${saved.email} saved. Paste a new one to replace it` : reusesOther && other?.key ? `Leave blank to use ${other.name}’s key (${other.key.email})` : '{ "type": "service_account", … }'}
				bind:value={json}
			></textarea>
			{#if pasted && 'error' in pasted}
				<p class="flex items-start gap-1.5 text-danger"><CircleAlert class="mt-px size-3.5 shrink-0" />{pasted.error}</p>
			{:else if pasted}
				<p class="flex items-center gap-1.5 text-success"><CircleCheck class="size-3.5" />Key for <span class="font-mono">{pasted.clientEmail}</span></p>
			{/if}
			<p class="text-muted-foreground/80">Key creation disabled? Your Google Cloud organisation enforces <span class="font-mono">iam.disableServiceAccountKeyCreation</span>; an organisation policy admin can turn it off for this project.</p>
		</div>
	</li>
	<li class="flex gap-3">
		<span class="step">4</span>
		<div class="min-w-0 flex-1 space-y-2">
			<p class="text-[0.8125rem] font-medium">Authorise it in the Google Admin console</p>
			<p class="text-muted-foreground">As a super admin: <strong>Security → Access and data control → API controls → Manage domain-wide delegation → Add new</strong>, and enter:</p>
			<div class="space-y-2 rounded-xl border bg-muted/40 p-3">
				<div>
					<span class="label">Client ID</span>
					{#if key?.clientId}
						<div class="flex gap-2"><input class="input font-mono text-xs" readonly value={key.clientId} /><button type="button" class="btn btn-secondary" onclick={() => copy(key.clientId, 'Client ID')}><Copy />Copy</button></div>
					{:else}
						<p class="text-muted-foreground">Appears here when you paste the key (it’s the <span class="font-mono">client_id</span> in the file).</p>
					{/if}
				</div>
				<div>
					<span class="label">OAuth scopes</span>
					<div class="flex gap-2">
						<textarea class="input h-auto resize-none py-2 font-mono text-[0.6875rem]" rows={allScopes.length} readonly value={allScopes.join(',\n')}></textarea>
						<button type="button" class="btn btn-secondary self-start" onclick={() => copy(allScopes.join(','), 'Scopes')}><Copy />Copy</button>
					</div>
				</div>
			</div>
			{#if shared && other}
				<p class="text-muted-foreground">This key is also used for {other.name}, so the list includes its scopes too. If the client ID is already listed, <strong>edit</strong> that entry and replace its scopes with these: a client ID has one entry, and saving replaces its scopes.</p>
			{/if}
			<a class="link" href={GOOGLE_LINKS.delegation} target="_blank" rel="noreferrer">Open domain-wide delegation<ExternalLink class="size-3" /></a>
		</div>
	</li>
	<li class="flex gap-3">
		<span class="step">5</span>
		<div class="min-w-0 flex-1 space-y-2">
			<label class="text-[0.8125rem] font-medium" for="{id}-admin">Choose the admin it acts as</label>
			<p class="text-muted-foreground">Google only lets a service account use the Admin SDK on behalf of an admin. Enter a super admin’s own address: not a group, an alias or the service account. It’s limited to the scopes above.</p>
			<input id="{id}-admin" class="input" type="email" placeholder="admin@acme.com" bind:value={adminEmail} required />
		</div>
	</li>
</ol>

<style>
	.step {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 999px;
		background: var(--primary-soft);
		color: var(--primary);
		font-family: var(--font-mono, monospace);
		font-size: 0.6875rem;
		font-weight: 600;
	}
	.link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--primary);
		font-weight: 500;
	}
	.link:hover {
		text-decoration: underline;
	}
</style>
