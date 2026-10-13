<script lang="ts">
	import { page } from '$app/state';
	import { CircleAlert } from '@lucide/svelte';
</script>

<svelte:head><title>{page.status} · ac·modern</title></svelte:head>

<div class="grid min-h-[70dvh] place-items-center px-8">
	<div class="card flex max-w-sm flex-col items-center px-8 py-10 text-center">
		<span class="grid size-11 place-items-center rounded-xl bg-danger/10 text-danger"><CircleAlert class="size-5" /></span>
		<p class="mt-4 font-mono text-xs text-muted-foreground">{page.status}</p>
		<h1 class="mt-1 text-[0.9375rem] font-semibold tracking-tight">{page.error?.message ?? 'Something went wrong'}</h1>
		<a href="/" class="btn btn-secondary mt-5">Back to overview</a>
	</div>
</div>
