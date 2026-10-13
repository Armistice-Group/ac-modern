<script lang="ts">
	import PageHeader from '#lib/components/PageHeader.svelte';
	import ResourceForm from '#lib/components/ResourceForm.svelte';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Add resource · ac·modern</title></svelte:head>

<PageHeader title="Add a resource" description="Something people need access to: an app, an account, a database, a shared drive." />
<div class="px-8 pb-10">
	<ResourceForm people={data.people} defaultApproval={data.defaultApproval} origin={data.origin} />
</div>
