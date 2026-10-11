<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';
	import { stamp } from '$lib/status';
	import { fragments } from '$lib/fragments';

	import ProductForm from '../ProductForm.svelte';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.name} · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">{data.name}</h1>
	<p class="page-lede">
		version {data.version} · {data.sold.orders} orders · {data.sold.units} units
	</p>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

{#if data.optionError}
	<Notice
		bad
		title="the option schema does not parse"
		body="{data.optionError} - this product cannot be bought until it does, because submitted values could not be checked against anything."
	/>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">edit</h2>
		<span class="panel-note">{data.active ? 'listed' : 'not listed'}</span>
	</header>

	<ProductForm
		product={data.form}
		kinds={data.kinds}
		categories={data.categories}
		action="?/update"
		submitLabel="save"
	/>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">versions</h2>
		<span class="panel-note">{data.revisions.length}</span>
	</header>

	<div class="panel-body">
		{#each data.revisions as revision (revision.id)}
			<div class="row">
				<span class="row-label">
					v{revision.version} - {revision.name}
					<span class="row-hint">
						{revision.kind} · {revision.perUserLimit === null
							? 'no limit'
							: `limit ${revision.perUserLimit}`} · {revision.requiresEligibility
							? 'eligible only'
							: 'anyone'} · {stamp(revision.createdAt)}
					</span>
				</span>
				<span class="row-value">{fragments(revision.price)}</span>
			</div>
		{/each}
	</div>

	<div class="panel-foot">
		<a class="control-btn is-quiet" href={resolve('/(app)/shop/[slug]', { slug: data.slug })}>
			see it as a participant
		</a>
	</div>
</section>
