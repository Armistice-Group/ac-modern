<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import PageHeader from '#lib/components/PageHeader.svelte';

	let { children }: { children: Snippet } = $props();
	const tabs = [
		{ href: '/settings', label: 'General' },
		{ href: '/settings/approvals', label: 'Approval rules' },
		{ href: '/settings/sso', label: 'Single sign-on' },
		{ href: '/settings/directory', label: 'Directory sync' },
		{ href: '/settings/integrations', label: 'Integrations' },
		{ href: '/settings/api', label: 'API' },
		{ href: '/settings/billing', label: 'Billing', cloud: true }
	];
	const shown = $derived(tabs.filter((t) => !t.cloud || page.data.mode === 'cloud'));
</script>

<PageHeader title="Settings" description="How {page.data.org?.name} works in ac·modern." />

<div class="px-8">
	<nav class="mb-6 flex gap-1 overflow-x-auto border-b border-border">
		{#each shown as t (t.href)}
			{@const active = t.href === '/settings' ? page.url.pathname === '/settings' : page.url.pathname.startsWith(t.href)}
			<a href={t.href} class="relative -mb-px border-b-2 px-3 pb-2.5 text-[0.8125rem] font-medium whitespace-nowrap transition-colors {active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">{t.label}</a>
		{/each}
	</nav>
</div>

{@render children()}
