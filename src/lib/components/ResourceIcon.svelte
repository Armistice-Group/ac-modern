<script lang="ts">
	import { HUES } from '#lib/format.ts';
	let { name, color = 'violet', size = 'size-8', text = 'text-[0.8125rem]' }: { name: string; color?: string; size?: string; text?: string } = $props();
	const hue = $derived(HUES[color] ?? 292);
	const chroma = $derived(color === 'slate' ? 0.03 : 0.15);
</script>

<span
	class="relative grid {size} shrink-0 place-items-center overflow-hidden rounded-lg font-semibold text-white {text} shadow-surface"
	style="background: linear-gradient(135deg, oklch(70% {chroma} {hue}), oklch(50% {chroma + 0.03} {hue}))"
	aria-hidden="true"
>
	<span class="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/20 to-transparent"></span>
	<span class="relative">{name.trim().slice(0, 1).toUpperCase()}</span>
</span>
