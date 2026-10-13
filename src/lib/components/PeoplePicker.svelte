<script lang="ts">
	import { Search, X } from '@lucide/svelte';
	import Avatar from './Avatar.svelte';
	import { displayName } from '#lib/format.ts';

	type P = { id: string; name: string; email: string };
	let { people, selected = $bindable([]), placeholder = 'Add people…', single = false }: { people: P[]; selected: string[]; placeholder?: string; single?: boolean } = $props();

	let q = $state('');
	let open = $state(false);
	const chosen = $derived(selected.map((id) => people.find((p) => p.id === id)).filter((p): p is P => !!p));
	const options = $derived(
		people.filter((p) => !selected.includes(p.id) && `${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
	);

	function add(id: string) {
		selected = single ? [id] : [...selected, id];
		q = '';
		if (single) open = false;
	}
</script>

<div class="relative">
	{#if chosen.length}
		<div class="mb-1.5 flex flex-wrap gap-1.5">
			{#each chosen as p (p.id)}
				<span class="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-muted pr-1 pl-1 text-xs">
					<Avatar user={p} size="size-5" />{displayName(p)}
					<button type="button" class="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Remove {displayName(p)}" onclick={() => (selected = selected.filter((s) => s !== p.id))}><X class="size-3" /></button>
				</span>
			{/each}
		</div>
	{/if}
	{#if !single || !chosen.length}
		<div class="relative">
			<Search class="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
			<input class="input pl-9" {placeholder} bind:value={q} onfocus={() => (open = true)} onblur={() => setTimeout(() => (open = false), 150)} />
		</div>
	{/if}
	{#if open && options.length}
		<div class="card absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto p-1 shadow-surface-lg">
			{#each options as p (p.id)}
				<button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[0.8125rem] hover:bg-accent" onmousedown={(e) => (e.preventDefault(), add(p.id))}>
					<Avatar user={p} size="size-6" />
					<span class="min-w-0 flex-1 truncate">{displayName(p)}</span>
					{#if p.name}<span class="truncate text-xs text-muted-foreground">{p.email}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
