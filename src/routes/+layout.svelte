<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import {
		LayoutDashboard,
		PackagePlus,
		Inbox,
		KeyRound,
		ClipboardCheck,
		Boxes,
		Users,
		ScrollText,
		Settings,
		Moon,
		Sun,
		LogOut,
		PanelLeftClose,
		PanelLeftOpen,
		ChevronsUpDown,
		Check,
		Plus
	} from '@lucide/svelte';
	import Logo from '#lib/components/Logo.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import Toaster from '#lib/components/Toaster.svelte';
	import ConfirmHost from '#lib/components/ConfirmHost.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { setTheme, theme, toast } from '#lib/client/state.svelte.ts';
	import { displayName, ROLE_LABEL } from '#lib/format.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	$effect(() => {
		theme.value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	});

	let collapsed = $state(false);
	let orgMenu = $state(false);
	$effect(() => {
		if (window.innerWidth < 768) collapsed = true;
	});

	const bare = $derived(!data.org || ['/login', '/setup', '/signup'].includes(page.url.pathname) || page.url.pathname.startsWith('/invite/'));
	const admin = $derived(data.viewer?.role === 'owner' || data.viewer?.role === 'admin');

	const main = $derived([
		{ href: '/', label: 'Overview', icon: LayoutDashboard },
		{ href: '/catalog', label: 'Request access', icon: PackagePlus },
		{ href: '/requests', label: 'Requests', icon: Inbox, badge: data.badges.approve + data.badges.fulfill },
		{ href: '/access', label: 'Access', icon: KeyRound },
		{ href: '/reviews', label: 'Reviews', icon: ClipboardCheck, badge: data.badges.review }
	]);
	const manage = $derived(
		admin
			? [
					{ href: '/resources', label: 'Resources', icon: Boxes },
					{ href: '/people', label: 'People', icon: Users },
					{ href: '/audit', label: 'Audit log', icon: ScrollText },
					{ href: '/settings', label: 'Settings', icon: Settings }
				]
			: []
	);

	async function logout() {
		await api.post('/api/auth/logout');
		await invalidateAll();
		goto('/login');
	}

	async function switchOrg(orgId: string) {
		orgMenu = false;
		try {
			await api.post('/api/orgs/switch', { orgId });
			await goto('/', { refreshAll: true });
		} catch (err) {
			toast('error', 'Couldn’t switch organisation', errorMessage(err));
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
			e.preventDefault();
			collapsed = !collapsed;
		}
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>ac·modern</title>
</svelte:head>

<svelte:window {onkeydown} />

{#snippet navLink(item: { href: string; label: string; icon: typeof Inbox; badge?: number })}
	{@const active = item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
	<a
		href={item.href}
		title={item.label}
		class="relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[0.8125rem] font-medium transition-colors {active
			? 'bg-accent text-foreground shadow-surface'
			: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
	>
		{#if active}<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary"></span>{/if}
		<item.icon class="size-4 shrink-0" />
		{#if !collapsed}
			<span class="flex-1">{item.label}</span>
			{#if item.badge}<span class="grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-primary-soft px-1 font-mono text-[0.625rem] font-semibold text-primary tabular-nums">{item.badge}</span>{/if}
		{:else if item.badge}
			<span class="absolute top-1 right-1 size-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]"></span>
		{/if}
	</a>
{/snippet}

{#if bare}
	{@render children()}
{:else}
	<div class="flex h-dvh overflow-hidden">
		<aside class="flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 {collapsed ? 'w-14' : 'w-64'}">
			<div class="relative px-2 pt-2.5 pb-1">
				<button
					class="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-accent/60"
					onclick={() => (orgMenu = !orgMenu)}
					title={data.org?.name}
				>
					<Logo size={26} />
					{#if !collapsed}
						<span class="min-w-0 flex-1">
							<span class="block text-[0.9375rem] leading-tight font-semibold tracking-tight">ac<span class="text-primary">·</span>modern</span>
							<span class="block truncate text-[0.6875rem] leading-tight text-muted-foreground">{data.org?.name}</span>
						</span>
						<ChevronsUpDown class="size-3.5 text-muted-foreground" />
					{/if}
				</button>
				{#if orgMenu}
					<button class="fixed inset-0 z-30 cursor-default" aria-label="Close menu" onclick={() => (orgMenu = false)}></button>
					<div class="card absolute top-full left-2 z-40 mt-1 w-60 p-1 shadow-surface-lg">
						<p class="px-2 pt-1.5 pb-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Organisations</p>
						{#each data.viewer?.orgs ?? [] as o (o.orgId)}
							<button class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.8125rem] hover:bg-accent" onclick={() => switchOrg(o.orgId)}>
								<span class="min-w-0 flex-1 truncate">{o.orgName}</span>
								<span class="text-[0.6875rem] text-muted-foreground">{ROLE_LABEL[o.role]}</span>
								{#if o.orgId === data.org?.id}<Check class="size-3.5 text-primary" />{/if}
							</button>
						{/each}
						{#if data.mode === 'cloud'}
							<div class="my-1 h-px bg-border"></div>
							<a href="/signup?new=1" class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[0.8125rem] text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => (orgMenu = false)}>
								<Plus class="size-3.5" />New organisation
							</a>
						{/if}
					</div>
				{/if}
			</div>

			<nav class="space-y-0.5 px-2 pt-2">
				{#each main as item (item.href)}{@render navLink(item)}{/each}
			</nav>

			{#if manage.length}
				{#if !collapsed}
					<p class="mt-5 px-4 pb-1.5 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Manage</p>
				{:else}
					<div class="mx-3 my-3 h-px bg-border"></div>
				{/if}
				<nav class="space-y-0.5 px-2">
					{#each manage as item (item.href)}{@render navLink(item)}{/each}
				</nav>
			{/if}

			<div class="flex-1"></div>

			{#if data.viewer && !collapsed}
				<a href="/account" title="My account" class="flex items-center gap-2.5 border-t border-border px-3 py-2.5 transition-colors hover:bg-accent/60">
					<Avatar user={data.viewer} />
					<div class="min-w-0 flex-1">
						<p class="truncate text-xs font-medium">{displayName(data.viewer)}</p>
						<p class="truncate text-[0.6875rem] text-muted-foreground">{ROLE_LABEL[data.viewer.role]}</p>
					</div>
				</a>
			{/if}
			<div class="flex items-center gap-1 border-t border-border p-2 {collapsed ? 'flex-col' : ''}">
				<button class="btn btn-ghost btn-icon btn-sm" title="Toggle sidebar (⌘B)" onclick={() => (collapsed = !collapsed)}>
					{#if collapsed}<PanelLeftOpen />{:else}<PanelLeftClose />{/if}
				</button>
				<button class="btn btn-ghost btn-icon btn-sm" title="Toggle theme" onclick={() => setTheme(theme.value === 'dark' ? 'light' : 'dark')}>
					{#if theme.value === 'dark'}<Sun />{:else}<Moon />{/if}
				</button>
				{#if !collapsed}
					<span class="ml-1 truncate font-mono text-[0.6875rem] text-muted-foreground/70" title="ac·modern version">v{data.version}</span>
				{/if}
				<button class="btn btn-ghost btn-icon btn-sm {collapsed ? '' : 'ml-auto'}" title="Sign out" onclick={logout}><LogOut /></button>
			</div>
		</aside>

		<main class="relative min-w-0 flex-1 overflow-y-auto">
			{@render children()}
		</main>
	</div>
{/if}

<Toaster />
<ConfirmHost />
