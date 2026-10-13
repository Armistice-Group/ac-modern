<script lang="ts">
	let { size = 28 }: { size?: number } = $props();
	// Gradient ids must be unique per instance; the logo appears more than once on some pages.
	const id = $props.id();
</script>

<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
	<defs>
		<linearGradient id="{id}-fill" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="oklch(72% 0.17 292.717)" />
			<stop offset="1" stop-color="oklch(48% 0.25 292.717)" />
		</linearGradient>
		<linearGradient id="{id}-sheen" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.22" />
			<stop offset="0.5" stop-color="#fff" stop-opacity="0" />
		</linearGradient>
	</defs>
	<rect width="32" height="32" rx="9" fill="url(#{id}-fill)" />
	<rect width="32" height="32" rx="9" fill="url(#{id}-sheen)" />
	<!-- A key: the bow, the shaft, and two bits fading off for depth. -->
	<circle cx="11" cy="16" r="5" fill="none" stroke="#fff" stroke-width="2.8" />
	<path d="M15.8 16h10.4" stroke="#fff" stroke-width="2.8" stroke-linecap="round" />
	<path d="M21.6 16v4.2" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.72" />
	<path d="M25.6 16v3" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.45" />
</svg>
