<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';
	import { fragments } from '$lib/fragments';

	let { data, form }: PageProps = $props();

	/* Shelf names by id, so a product row can say where it is filed without the
	   load sending the whole category down beside every product. */
	const categoryNames = $derived(new Map(data.categories.map((c) => [c.id, c.name])));
</script>

<svelte:head>
	<title>catalog · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">catalog</h1>
</header>

{#if form?.categoryError}
	<Notice bad alert body={form.categoryError} />
{:else if form?.categoryCreated}
	<Notice title="created “{form.categoryCreated}”" body="it is on the shop's filter row now." />
{:else if form?.categoryDeleted}
	<Notice
		title="deleted “{form.categoryDeleted}”"
		body="anything that was filed under it is still in the shop, just unfiled."
	/>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">categories</h2>
		<span class="panel-note">{data.categories.length}</span>
	</header>

	<div class="panel-body">
		{#if data.categories.length === 0}
			<p class="panel-prose">
				no categories yet. without them the shop lists everything together, which is a fine way to
				run a small shop.
			</p>
		{:else}
			{#each data.categories as category (category.id)}
				<div class="row">
					<span class="row-label">
						{category.name}
						<span class="row-hint">
							{category.slug} · {category.productCount === 1
								? '1 product'
								: `${category.productCount} products`}
						</span>
					</span>
					<!-- Deleting unfiles rather than destroys, so this is a plain button
					     rather than a confirmation dance. The count above it is the
					     warning: it says exactly how many products are about to lose
					     their shelf, which is the only fact the decision turns on. -->
					<form method="POST" action="?/deleteCategory" use:enhance>
						<input type="hidden" name="id" value={category.id} />
						<button type="submit" class="control-btn is-quiet is-small">delete</button>
					</form>
				</div>
			{/each}
		{/if}

		{#if data.unfiled > 0}
			<p class="panel-prose">
				{data.unfiled === 1 ? '1 product is' : `${data.unfiled} products are`} unfiled. the shop shows
				{data.unfiled === 1 ? 'it' : 'them'} under “everything else”.
			</p>
		{/if}
	</div>

	<div class="panel-foot">
		<form method="POST" action="?/createCategory" class="form-inline" use:enhance>
			<label class="sr-only" for="category-name">new category name</label>
			<input
				id="category-name"
				name="name"
				class="control-input"
				type="text"
				maxlength="60"
				placeholder="new category"
				value={form?.categoryName ?? ''}
				required
			/>
			<label class="sr-only" for="category-slug">new category slug</label>
			<input
				id="category-slug"
				name="slug"
				class="control-input"
				type="text"
				pattern="[a-z0-9]+(-[a-z0-9]+)*"
				maxlength="60"
				placeholder="slug (optional)"
			/>
			<button type="submit" class="control-btn">add</button>
		</form>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">products</h2>
		<span class="panel-note">{data.products.length}</span>
	</header>

	<div class="panel-body">
		{#if data.products.length === 0}
			<p class="panel-prose">nothing in the catalog yet.</p>
		{:else}
			{#each data.products as product (product.id)}
				<a class="row" href={resolve('/(app)/admin/catalog/[id]', { id: product.id })}>
					<span class="row-label">
						{product.name}
						<span class="row-hint">
							{product.slug} · v{product.version} · {product.kind} · {product.categoryId
								? (categoryNames.get(product.categoryId) ?? 'unfiled')
								: 'unfiled'} · {product.stock === null
								? 'unlimited'
								: `${product.stock} left`}{product.optionError ? ` · ${product.optionError}` : ''}
						</span>
					</span>
					<span
						class={[
							'badge',
							product.optionError ? 'is-bad' : product.blockedReason ? 'is-waiting' : 'is-good'
						]}
					>
						{product.optionError
							? 'broken'
							: product.blockedReason
								? product.blockedReason
								: fragments(product.price)}
					</span>
				</a>
			{/each}
		{/if}
	</div>

	<div class="panel-foot">
		<a class="control-btn" href={resolve('/(app)/admin/catalog/new')}>new product</a>
	</div>
</section>
