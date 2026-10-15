<script lang="ts">
	import { goto } from '$app/navigation';
	import { CircleAlert, CircleCheck, ExternalLink, LoaderCircle, Plug, RefreshCw, ScanSearch, Users } from '@lucide/svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { INTEGRATIONS } from '#lib/integrations.ts';
	import BrandLogo from '#lib/components/BrandLogo.svelte';
	import type { DiscoveredApp } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let picked = $state('');
	const kind = $derived(data.kinds.find((k) => k === picked) ?? data.kinds[0] ?? '');
	let apps = $state<DiscoveredApp[] | null>(null);
	let error = $state('');
	let busy = $state<'scan' | 'import' | null>(null);
	let chosen = $state<Record<string, boolean>>({});

	const ourHost = (() => {
		try {
			return new URL(data.origin).host;
		} catch {
			return '';
		}
	})();
	const host = (u: string) => {
		try {
			return new URL(u).host;
		} catch {
			return '';
		}
	};
	// ac·modern's own SSO app is in the list too; there's no point requesting access to it here.
	const isUs = (a: DiscoveredApp) => (!!ourHost && host(a.url) === ourHost) || /ac[·\s-]?modern/i.test(a.name);

	async function scan() {
		if (!kind) return;
		busy = 'scan';
		error = '';
		try {
			apps = (await api.get<{ apps: DiscoveredApp[] }>(`/api/integrations/${kind}/apps`)).apps;
			chosen = Object.fromEntries(apps.map((a) => [a.ref, !a.resourceId && !isUs(a)]));
		} catch (err) {
			apps = null;
			error = errorMessage(err);
		} finally {
			busy = null;
		}
	}
	$effect(() => {
		if (kind) scan();
	});

	const selected = $derived((apps ?? []).filter((a) => chosen[a.ref] && !a.resourceId));
	const people = $derived(selected.reduce((n, a) => n + a.levels.reduce((m, l) => m + l.people - l.notMembers.length, 0), 0));
	const idp = $derived(kind ? INTEGRATIONS[kind].name : '');

	async function importChosen() {
		busy = 'import';
		try {
			const r = await api.post<{ resources: number; grants: number; notMembers: number }>(`/api/integrations/${kind}/apps`, { refs: selected.map((a) => a.ref) });
			toast(
				'success',
				`Imported ${r.resources} ${r.resources === 1 ? 'resource' : 'resources'} and recorded ${r.grants} existing ${r.grants === 1 ? 'grant' : 'grants'}`,
				r.notMembers ? `${r.notMembers === 1 ? '1 person' : `${r.notMembers} people`} found in ${idp} ${r.notMembers === 1 ? 'isn’t' : 'aren’t'} in ac·modern yet, so their access wasn’t recorded.` : undefined
			);
			await goto('/resources');
		} catch (err) {
			toast('error', 'Couldn’t import', errorMessage(err));
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Import apps · ac·modern</title></svelte:head>

<PageHeader title="Import apps" description="Find the apps your identity provider already manages, add them as resources, and record who has them today.">
	{#snippet actions()}
		{#if data.kinds.length}
			<button class="btn btn-secondary" disabled={!!busy} onclick={scan}>{#if busy === 'scan'}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Scan again</button>
		{/if}
	{/snippet}
</PageHeader>

<div class="max-w-4xl space-y-4 px-8 pb-28">
	{#if !data.kinds.length}
		<EmptyState icon={Plug} title="Connect an identity provider first" body="Connect Authentik, Okta or Microsoft Entra ID under Settings → Integrations, and ac·modern can list its apps and who uses them.">
			{#snippet action()}<a class="btn btn-primary" href="/settings/integrations">Open integrations</a>{/snippet}
		</EmptyState>
	{:else}
		{#if data.kinds.length > 1}
			<div class="flex gap-1" role="tablist" aria-label="Identity provider">
				{#each data.kinds as k (k)}
					<button role="tab" aria-selected={kind === k} class="btn btn-sm {kind === k ? 'btn-secondary' : 'btn-ghost'}" onclick={() => (picked = k)}><BrandLogo brand={k} class="size-3.5" />{INTEGRATIONS[k].name}</button>
				{/each}
			</div>
		{/if}

		<section class="card space-y-1.5 p-4 text-xs text-muted-foreground">
			<p>Each app you import becomes a resource with one access level per {idp} group that grants it. Requests for it are then set up by adding people to that group.</p>
			<p>Everyone the app lets in today is recorded as existing access with the source <em>IdP</em>, so it appears in reviews, offboarding and the audit evidence. You’re made the owner, and the default approval rule applies: change either on the resource afterwards.</p>
		</section>

		{#if busy === 'scan'}
			<div class="card flex items-center justify-center gap-2 p-10 text-[0.8125rem] text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Scanning {idp}…</div>
		{:else if error}
			<div class="card flex items-start gap-3 p-4 text-[0.8125rem]">
				<CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
				<div><p class="font-medium">{idp} didn’t answer the scan</p><p class="mt-0.5 text-xs text-muted-foreground">{error}</p></div>
			</div>
		{:else if apps && !apps.length}
			<EmptyState icon={ScanSearch} title="No apps found" body="{idp} didn’t list any applications for this token. Check that its user can see every application." />
		{:else if apps}
			<ul class="card divide-y">
				{#each apps as app (app.ref)}
					<li class="flex gap-3 p-4">
						<input type="checkbox" class="mt-1 accent-[var(--primary)]" aria-label="Import {app.name}" disabled={!!app.resourceId} bind:checked={chosen[app.ref]} />
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-[0.8125rem] font-medium">{app.name}</span>
								{#if app.url}<a class="inline-flex items-center gap-1 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground" href={app.url} target="_blank" rel="noreferrer">{host(app.url)}<ExternalLink class="size-3" /></a>{/if}
								{#if app.resourceId}
									<a class="badge badge-success" href="/resources/{app.resourceId}"><CircleCheck />Imported</a>
								{:else if app.provisioned}
									<span class="badge badge-primary">Provisioned through {idp}</span>
								{:else}
									<span class="badge">Set up by hand</span>
								{/if}
								{#if app.openToAll}<span class="badge badge-warning">Open to everyone in {idp}</span>{/if}
							</div>
							{#if app.levels.length}
								<div class="mt-2 flex flex-wrap gap-1.5">
									{#each app.levels as l (l.name)}
										<span class="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[0.6875rem]" title={l.notMembers.length ? `Not in ac·modern: ${l.notMembers.join(', ')}` : undefined}>
											<Users class="size-3 text-muted-foreground" />{l.name}
											<span class="font-mono text-muted-foreground tabular-nums">{l.people}</span>
											{#if l.notMembers.length}<span class="text-warning">· {l.notMembers.length} not here</span>{/if}
											{#if !l.provisioned}<span class="text-muted-foreground">· by hand</span>{/if}
										</span>
									{/each}
								</div>
							{:else if !app.openToAll}
								<p class="mt-1 text-xs text-muted-foreground">Access is decided by policies, not groups. It’s imported with one level, set up by hand, and nobody’s access is recorded.</p>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

{#if apps?.length}
	<div class="sticky bottom-0 border-t bg-background/90 px-8 py-3 backdrop-blur">
		<div class="flex max-w-4xl items-center gap-3">
			<p class="flex-1 text-xs text-muted-foreground">
				{selected.length} {selected.length === 1 ? 'app' : 'apps'} selected{#if selected.length}, recording <span class="font-mono tabular-nums">{people}</span> existing {people === 1 ? 'grant' : 'grants'}{/if}
			</p>
			<button class="btn btn-primary" disabled={!selected.length || !!busy} onclick={importChosen}>{#if busy === 'import'}<LoaderCircle class="animate-spin" />{/if}Import {selected.length || ''}</button>
		</div>
	</div>
{/if}
