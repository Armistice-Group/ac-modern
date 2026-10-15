<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Copy, LoaderCircle, Trash2, CircleCheck, CircleDashed, Plug, KeyRound } from '@lucide/svelte';
	import BrandLogo from '#lib/components/BrandLogo.svelte';
	import { brandForIssuer } from '#lib/brands.ts';
	import Switch from '#lib/components/Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let f = $state({ issuer: '', clientId: '', clientSecret: '', name: '', scopes: '', autoCreate: true, required: false });
	const brand = $derived(brandForIssuer(f.issuer, f.name));
	let domain = $state('');
	let busy = $state<string | null>(null);
	$effect(() => {
		f = {
			issuer: data.sso?.issuer ?? '',
			clientId: data.sso?.clientId ?? '',
			clientSecret: '',
			name: data.sso?.name ?? 'Okta',
			scopes: data.sso?.scopes ?? 'openid email profile',
			autoCreate: data.sso?.autoCreate ?? true,
			required: data.sso?.required ?? false
		};
	});
	const env = $derived(data.sso?.source === 'env');
	const verified = $derived(data.domains.filter((d) => d.verified));

	async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
		busy = key;
		try {
			await fn();
			if (ok) toast('success', ok);
			await invalidateAll();
		} catch (err) {
			toast('error', 'That didn’t work', errorMessage(err));
		} finally {
			busy = null;
		}
	}
	const copy = (v: string) => (navigator.clipboard.writeText(v), toast('success', 'Copied'));
	const save = (e: SubmitEvent) => (e.preventDefault(), run('save', () => api.put('/api/settings/sso', { ...f, clientSecret: f.clientSecret || undefined }), 'Saved'));
	async function remove() {
		if (await confirmAction({ title: 'Turn off single sign-on?', body: 'People sign in with passwords again. SSO-only accounts will need to reset theirs.', danger: true, confirmLabel: 'Turn off' }))
			run('delete', () => api.del('/api/settings/sso'), 'Single sign-on turned off');
	}
</script>

<svelte:head><title>Single sign-on · ac·modern</title></svelte:head>

<div class="max-w-3xl space-y-6 px-8 pb-10">
	<section class="card p-5">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">1. Register ac·modern with your identity provider</h2>
		<p class="mt-1 text-xs text-muted-foreground">Create an OIDC web app in Okta, Entra ID, Google Workspace, JumpCloud, Authentik or Keycloak, with this redirect URI:</p>
		<div class="mt-3 flex gap-2">
			<input class="input font-mono text-xs" readonly value={data.redirectUri} />
			<button class="btn btn-secondary" onclick={() => copy(data.redirectUri)}><Copy />Copy</button>
		</div>
	</section>

	<section class="card p-5">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-[0.9375rem] font-semibold tracking-tight">2. Connect it</h2>
				{#if env}<p class="mt-1 text-xs text-warning">Set by ACM_OIDC_* environment variables; change it there.</p>{/if}
			</div>
			{#if data.sso}<span class="badge badge-success"><CircleCheck />Connected</span>{/if}
		</div>
		<form class="mt-4 grid gap-4 sm:grid-cols-2" onsubmit={save}>
			<div class="sm:col-span-2">
				<label class="label" for="issuer">Issuer URL</label>
				<input id="issuer" class="input font-mono text-xs" placeholder="https://acme.okta.com" bind:value={f.issuer} required disabled={env} />
			</div>
			<div>
				<label class="label" for="cid">Client ID</label>
				<input id="cid" class="input font-mono text-xs" bind:value={f.clientId} required disabled={env} />
			</div>
			<div>
				<label class="label" for="cs">Client secret</label>
				<input id="cs" class="input font-mono text-xs" type="password" placeholder={data.sso?.hasSecret ? '•••••••• saved' : ''} bind:value={f.clientSecret} disabled={env} />
			</div>
			<div>
				<label class="label" for="name">Button label</label>
				<div class="relative">
					<span class="pointer-events-none absolute inset-y-0 left-3 flex items-center">{#if brand}<BrandLogo {brand} class="size-4" />{:else}<KeyRound class="size-4 text-muted-foreground" />{/if}</span>
					<input id="name" class="input pl-9" bind:value={f.name} disabled={env} />
				</div>
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">On the sign-in button{brand ? ', with this logo' : ''}.</p>
			</div>
			<div>
				<label class="label" for="scopes">Scopes</label>
				<input id="scopes" class="input font-mono text-xs" bind:value={f.scopes} disabled={env} />
			</div>
			<div class="flex items-start justify-between gap-4 sm:col-span-2">
				<div>
					<p class="text-[0.8125rem] font-medium">Create accounts on first sign-in</p>
					<p class="text-xs text-muted-foreground">Anyone on a verified domain below who can sign in to your IdP becomes a member. Off: they need an invite (or directory sync) first.</p>
				</div>
				<Switch bind:checked={f.autoCreate} label="Create accounts on first sign-in" disabled={env} />
			</div>
			<div class="flex items-start justify-between gap-4 sm:col-span-2">
				<div>
					<p class="text-[0.8125rem] font-medium">Require single sign-on</p>
					<p class="text-xs text-muted-foreground">Members must sign in through your IdP, so offboarding there locks them out here too. Owners keep their password as a break-glass.</p>
				</div>
				<Switch bind:checked={f.required} label="Require SSO" disabled={env || !verified.length} />
			</div>
			{#if !env}
				<div class="flex gap-2 sm:col-span-2">
					<button class="btn btn-primary" disabled={!!busy}>{#if busy === 'save'}<LoaderCircle class="animate-spin" />{/if}Save</button>
					{#if data.sso}
						<button type="button" class="btn btn-secondary" disabled={!!busy} onclick={() => run('test', () => api.post('/api/settings/sso/test', {}), 'Your identity provider answered')}><Plug />Test connection</button>
						<button type="button" class="btn btn-ghost ml-auto" onclick={remove}>Turn off</button>
					{/if}
				</div>
			{/if}
		</form>
	</section>

	<section class="card p-5">
		<h2 class="text-[0.9375rem] font-semibold tracking-tight">3. Your email domains</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			Sign-ins are trusted for these domains{data.cloud ? ' once you’ve proved you own them with a DNS TXT record' : ''}. People signing in from other domains need an invite.
		</p>
		<ul class="mt-4 divide-y divide-border rounded-xl border border-border">
			{#each data.domains as d (d.domain)}
				<li class="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[0.8125rem]">
					{#if d.verified}<CircleCheck class="size-4 text-success" />{:else}<CircleDashed class="size-4 text-warning" />{/if}
					<span class="font-mono">{d.domain}</span>
					{#if !d.verified}
						<span class="flex-1 text-xs text-muted-foreground">Add TXT <code class="font-mono text-foreground">{d.record}</code></span>
						<button class="btn btn-ghost btn-icon btn-sm" title="Copy record" onclick={() => copy(d.record)}><Copy /></button>
						<button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => run(`v-${d.domain}`, () => api.post('/api/settings/domains/verify', { domain: d.domain }), `${d.domain} verified`)}>Verify</button>
					{:else}<span class="flex-1"></span>{/if}
					{#if d.record || !env}<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove" onclick={() => run(`r-${d.domain}`, () => api.del(`/api/settings/domains?domain=${encodeURIComponent(d.domain)}`))}><Trash2 /></button>{/if}
				</li>
			{:else}
				<li class="px-3 py-4 text-center text-xs text-muted-foreground">No domains yet.</li>
			{/each}
		</ul>
		<form class="mt-3 flex gap-2" onsubmit={(e) => (e.preventDefault(), run('add', () => api.post('/api/settings/domains', { domain }).then(() => (domain = ''))))}>
			<input class="input font-mono text-xs" placeholder="acme.com" bind:value={domain} />
			<button class="btn btn-secondary" disabled={!domain || !!busy}>Add domain</button>
		</form>
		{#if data.sso}<p class="mt-4 text-[0.6875rem] text-muted-foreground">Direct sign-in link for your IdP’s app dashboard: <span class="font-mono text-foreground">{data.loginUrl}</span></p>{/if}
	</section>
</div>
