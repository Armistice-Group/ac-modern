<script lang="ts">
	let {
		checked = $bindable(false),
		label,
		disabled = false,
		onchange
	}: { checked: boolean; label?: string; disabled?: boolean; onchange?: (v: boolean) => void } = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	onclick={() => {
		checked = !checked;
		onchange?.(checked);
	}}
	class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors disabled:opacity-50 {checked
		? 'bg-primary'
		: 'bg-input'}"
>
	<span
		class="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform {checked
			? 'translate-x-4'
			: 'translate-x-0.5'}"
	></span>
</button>
