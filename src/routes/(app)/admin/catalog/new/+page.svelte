<script lang="ts">
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';

	import ProductForm from '../ProductForm.svelte';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>new product · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">new product</h1>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">details</h2>
	</header>

	<ProductForm
		product={null}
		kinds={data.kinds}
		categories={data.categories}
		action="?/create"
		submitLabel="create"
	/>
</section>
