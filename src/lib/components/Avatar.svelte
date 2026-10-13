<script lang="ts">
	import { initials } from '#lib/format.ts';
	let { user, size = 'size-7' }: { user: { name: string; email: string }; size?: string } = $props();
</script>

<span
	class="grid {size} shrink-0 place-items-center rounded-full bg-primary-soft text-[0.625rem] font-semibold text-primary uppercase"
	title={user.name ? `${user.name} <${user.email}>` : user.email}>{initials(user)}</span
>
