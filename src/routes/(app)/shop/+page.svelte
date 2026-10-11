<script lang="ts">
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';

	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Card from '$lib/components/Card.svelte';
	import Fragments from '$lib/components/Fragments.svelte';
	import FragmentsIntro from '$lib/components/FragmentsIntro.svelte';
	import Notice from '$lib/components/Notice.svelte';
	/* Same fallback picture the grid cards use when a product has no photo: a
	   thumbnail of the field itself, seeded by the name. */
	import { thumbField } from '$lib/field/thumb';
	import { motionOk } from '$lib/reveal';
	import { NO_FILTERS, SORTS, UNFILED, filterQuery, isNarrowed } from '$lib/shop/filters';
	import { day } from '$lib/status';
	import type { Filters } from '$lib/shop/filters';

	let { data }: PageProps = $props();

	/* A price as the work it takes: "about 5h of work" under each buy button.
	   Hours to one decimal, dropping a ".0" - the catalog is priced in whole
	   hours' worth, so it is nearly always a round number. */
	function workNote(price: number, varies: boolean): string {
		const h = Math.round((price / 3600) * 10) / 10;
		return `${varies ? 'from ' : ''}about ${h}h of work`;
	}

	const shop = resolve('/shop');

	/** A chip's href: the filters as they are, with one thing changed. Built from
	 *  the whole set rather than by editing the current query string, so picking
	 *  a kind keeps the category and the sort instead of dropping whichever ones
	 *  the string happened not to mention. */
	function href(patch: Partial<Filters>): string {
		return `${shop}${filterQuery({ ...data.filters, ...patch })}`;
	}

	const narrowed = $derived(isNarrowed(data.filters));
</script>

<svelte:head>
	<title>shop · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<div class="page-head-row">
		<div class="page-head-text">
			<h1 class="page-title">shop</h1>
			<p class="page-lede">you have <Fragments seconds={data.balance} /> to spend.</p>
			<p class="form-hint">every hour of approved work earns 10 fragments.</p>
		</div>
		<a class="control-btn is-quiet is-large" href={resolve('/orders')}>your orders</a>
	</div>
</header>

<FragmentsIntro balance={data.balance} />

{#if data.shopLocked}
	<div class="shop-limited">
		<Notice
			title="your shop is limited"
			body="since you've received a visa letter or a flight stipend from us, your fragments are set aside for getting to phantom: you can buy the invite and the flight stipend, but not the rest of the shop. ask in #phantom-help if you think that's a mistake."
		/>
	</div>
{/if}

<!--
	Links, not buttons, and not a form.

	Every chip is a real href to a real URL, so the whole row works before any
	JavaScript arrives, the browser's back button walks back through the filters
	one at a time, and a narrowed shop is something you can send somebody. The
	router turns the click into a client-side navigation on the way past; that is
	an optimisation, not the mechanism.

	aria-current="true" rather than "page", which would be a lie - these are not
	pages, they are the state of this one. It is the same fact as the fill, for
	the reason Nav.svelte gives: a state a screen reader cannot hear is a state
	only half the people using the page can see.
-->
<!-- eslint-disable svelte/no-navigation-without-resolve -- every href below is
     `shop` (which IS resolve('/shop')) with a query string appended by
     filterQuery. The rule matches the literal resolve() call at the attribute
     and cannot follow it through a helper, so it reads a resolved path as an
     unresolved one. Same exemption, same reason, as the console's dashboard. -->
{#if data.total > 0}
	<nav class="filters" aria-label="filter the shop">
		{#if data.kinds.length > 1}
			<div class="filter-row">
				<span class="filter-legend" id="filter-kind">kind</span>
				<div class="filter-chips" role="group" aria-labelledby="filter-kind">
					<a
						class="filter-chip"
						href={href({ kind: null })}
						aria-current={data.filters.kind === null ? 'true' : undefined}
					>
						all
					</a>
					{#each data.kinds as kind (kind)}
						<a
							class="filter-chip"
							href={href({ kind })}
							aria-current={data.filters.kind === kind ? 'true' : undefined}
						>
							{kind}
						</a>
					{/each}
				</div>
			</div>
		{/if}

		{#if data.categories.length > 0}
			<div class="filter-row">
				<span class="filter-legend" id="filter-category">category</span>
				<div class="filter-chips" role="group" aria-labelledby="filter-category">
					<a
						class="filter-chip"
						href={href({ category: null })}
						aria-current={data.filters.category === null ? 'true' : undefined}
					>
						all
					</a>
					{#each data.categories as category (category.slug)}
						<a
							class="filter-chip"
							href={href({ category: category.slug })}
							aria-current={data.filters.category === category.slug ? 'true' : undefined}
						>
							{category.name}
						</a>
					{/each}
					<!-- Offered only when something is actually unfiled, so the row
					     never carries a chip that leads nowhere. -->
					{#if data.hasUnfiled}
						<a
							class="filter-chip"
							href={href({ category: UNFILED })}
							aria-current={data.filters.category === UNFILED ? 'true' : undefined}
						>
							everything else
						</a>
					{/if}
				</div>
			</div>
		{/if}

		<div class="filter-row">
			<span class="filter-legend" id="filter-sort">sort</span>
			<div class="filter-chips" role="group" aria-labelledby="filter-sort">
				{#each SORTS as sort (sort.key)}
					<a
						class="filter-chip"
						href={href({ sort: sort.key })}
						aria-current={data.filters.sort === sort.key ? 'true' : undefined}
					>
						{sort.label}
					</a>
				{/each}
			</div>
		</div>
	</nav>
{/if}

{#if !data.window.open}
	<Notice title="the shop is closed">
		{#if data.window.message}<span class="notice-body">{data.window.message}</span>{/if}
		{#if data.window.closedAt}
			<span class="notice-body">it closed on {day(data.window.closedAt)}.</span>
		{/if}
	</Notice>
{/if}

<!-- Said once, at the top, rather than on every row. A person who is not
     eligible cannot buy most of the catalog, and finding that out one product
     at a time is worse than being told. -->
{#if !data.eligible}
	<Notice
		title="you cannot buy yet"
		body="most of this needs Hack Club to have verified you. your home page says where that stands."
	/>
{/if}

<!--
	The invite, pinned.

	Above the grid and outside every filter - the loader never puts it in the
	list the chips are built from, so there is no combination of kind, shelf and
	sort that can take it off this page. It is what the fifty hours are FOR, and
	a prize that can be filtered away by picking "physical" is a prize somebody
	will not find.

	Full width rather than a cell in the grid: the grid is things to browse, and
	this is the one thing here that is not a choice among others. The card is one
	link, and the button at its end is a span for the reason Card.svelte gives -
	on a card that is itself a link, a real button would be a second tab stop
	leading exactly where the first one goes.
-->
{#if data.invite}
	<a
		class="invite"
		class:is-owned={data.invite.owned}
		href={resolve('/(app)/shop/[slug]', { slug: data.invite.slug })}
	>
		<span
			class={['invite-thumb', data.invite.imagePadding > 0 && 'is-padded']}
			style={data.invite.imagePadding > 0 ? `padding: ${data.invite.imagePadding}px` : undefined}
		>
			{#if data.invite.imageUrl}
				<img src={data.invite.imageUrl} alt="" />
			{:else}
				<canvas use:thumbField={data.invite.name}></canvas>
			{/if}
		</span>

		<span class="invite-text">
			<span class="invite-name">{data.invite.name}</span>
			{#if data.invite.description}
				<span class="invite-desc">{data.invite.description}</span>
			{/if}
			{#if data.invite.hint}
				<span class="invite-hint">{data.invite.hint}</span>
			{/if}
		</span>

		<span class={['invite-cta', 'control-btn', data.invite.owned && 'is-quiet']}>
			{#if data.invite.owned}
				yours
			{:else}
				buy for <Fragments seconds={data.invite.price} />
			{/if}
		</span>
	</a>
{/if}

{#if data.total === 0}
	<section class="panel">
		<div class="panel-body">
			<!-- "else" only when the invite is above this, where "nothing is listed"
			     would be contradicted by the card the reader is looking at. -->
			<p class="panel-prose">nothing{data.invite ? ' else' : ''} is listed yet.</p>
		</div>
	</section>
{:else if data.products.length === 0}
	<!-- Narrowed to nothing. The way out is in the panel rather than only up in
	     the row, because the row is above the fold and this is what the person is
	     looking at. -->
	<section class="panel">
		<div class="panel-body">
			<p class="panel-prose">nothing in the shop matches that.</p>
		</div>
		<div class="panel-foot">
			<a class="control-btn is-quiet" href={`${shop}${filterQuery(NO_FILTERS)}`}>
				show everything
			</a>
		</div>
	</section>
{:else}
	{#if narrowed}
		<p class="filter-count">
			{data.products.length} of {data.total} ·
			<a href={`${shop}${filterQuery({ ...NO_FILTERS, sort: data.filters.sort })}`}>
				show everything
			</a>
		</p>
	{/if}

	<!-- [3b] Each card in a slot that slides to its new place when a filter or
	     the sort changes, rather than the grid being redrawn: what stays is
	     seen moving, and only what is new arrives (Card's `index`). -->
	<div class="cards">
		{#each data.products as product, i (product.id)}
			<div class="card-slot" animate:flip={{ duration: motionOk() ? 420 : 0, easing: cubicOut }}>
				<Card
					index={i}
					href={resolve('/(app)/shop/[slug]', { slug: product.slug })}
					image={product.imageUrl}
					imagePadding={product.imagePadding}
					name={product.name}
					aside={product.hint}
					description={product.description}
					shop
					ctaNote={workNote(product.price, product.priceVaries)}
				>
					{#snippet cta()}buy {product.priceVaries ? 'from' : 'for'}
						<Fragments seconds={product.price} />{/snippet}
				</Card>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* [3b] The slot is the grid item now; the card fills it, so the grid's
	   rows still line up as they did. */
	.card-slot {
		display: grid;
		min-width: 0;
	}

	/* The pinned card: a grid card turned on its side. Same material as the
	   others - the surface fill, the fine weave, the same edge - so it reads as
	   part of the shop rather than as an advert dropped on top of it, and the
	   only thing that marks it out is that it is as wide as the page. */
	.invite {
		display: grid;
		grid-template-columns: 200px minmax(0, 1fr) auto;
		align-items: center;
		gap: 20px;
		padding: 16px;
		color: var(--ink);
		text-decoration: none;
		background-color: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--control-radius);
		background-image: var(--weave-grid), var(--shade-inset);
		/* The grid cards' own hover, and the same 120ms: the edge lights up, the
		   name goes white, the photograph drops its dither. This used to swap the
		   weave underneath as well, which is a background-image and therefore the
		   one property in the set that cannot be animated - so the whole thing
		   landed in a single frame however long the transition said it was. */
		transition: border-color 120ms ease;
	}

	.invite:hover,
	.invite:focus-visible {
		border-color: var(--panel-line);
		outline: none;
	}

	.invite:hover .invite-name,
	.invite:focus-visible .invite-name {
		color: #ffffff;
	}

	/* Bled to the card's left edge, carrying that side's corners itself for the
	   reason cards.css gives about squaring off what the card rounds.

	   `align-self: stretch` rather than an aspect ratio, and that is the fix for
	   a picture whose top and bottom edges were showing. The row's height is set
	   by the text beside it - a name, a blurb, a button - and a 16/9 box is
	   whatever height 16/9 makes it, so the two agreed only by accident and the
	   card's fill showed above and below the photograph. Stretched, the picture
	   is exactly as tall as the row, and the negative margins take it the last
	   16px through the card's padding to the edge. */
	.invite-thumb {
		display: block;
		align-self: stretch;
		min-height: 132px;
		margin: -16px 0 -16px -16px;
		overflow: hidden;
		border-radius: var(--control-radius) 0 0 var(--control-radius);
		border-right: 1px solid var(--line);
		background-color: var(--bg);
	}

	.invite-thumb img,
	.invite-thumb canvas {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* Padded, so the picture is framed rather than bled - same pairing as the
	   grid card: contain goes with padding, because a covered image still meets
	   the edges of whatever box is left and the space would read as a border
	   rather than as room. */
	.invite-thumb.is-padded img {
		object-fit: contain;
	}

	/* Dithered like every photograph here, and colour on hover - the same
	   exchange the grid cards make. */
	.invite-thumb img {
		filter: url(#dither);
	}

	.invite:hover .invite-thumb img,
	.invite:focus-visible .invite-thumb img {
		filter: none;
	}

	.invite-thumb canvas {
		image-rendering: pixelated;
	}

	.invite-text {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	/* The one thing on this page set at page-title scale rather than card scale:
	   it is the prize, and the grid below it is everything else. */
	.invite-name {
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-size: 32px;
		line-height: 1.05;
	}

	.invite-desc {
		font-size: var(--text-md);
		line-height: 1.6;
		color: #cfcac2;
		/* The breaks the operator typed, like every other blurb in the shop. This
		   one is not clamped, so it costs nothing to honour them. */
		white-space: pre-line;
	}

	.invite-hint {
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	/* The "your shop is limited" notice: a paragraph somebody has to read
	   closely, and at full strength the notice's weave made the small text
	   on it hard to read. So the weave stays, under a wash of the notice's
	   own fill that takes it to about half. */
	.shop-limited :global(.notice) {
		background-image:
			linear-gradient(
				color-mix(in srgb, var(--level-surface) 55%, transparent),
				color-mix(in srgb, var(--level-surface) 55%, transparent)
			),
			var(--weave-bayer), var(--shade-inset);
	}

	.shop-limited :global(.notice-body) {
		color: var(--ink);
	}

	/* The grid cards' size (cards.css, .card-cta), so the two kinds of buy
	   button on this page match. */
	.invite-cta {
		font-size: 15px;
		white-space: nowrap;
	}

	/* Already bought: the card stays, because it is still where the invite's
	   details live, and the button stops pretending there is anything to do. */
	.invite.is-owned .invite-name {
		color: var(--ink-dim);
	}

	/* One column on a phone: the picture on top, the way the grid cards wear
	   theirs, and the button full width under the text. */
	@media (max-width: 700px) {
		.invite {
			grid-template-columns: 1fr;
			gap: 12px;
		}

		/* One column, so the picture is its own row with nothing beside it to take
		   its height from - the aspect ratio comes back to give it one. */
		.invite-thumb {
			aspect-ratio: 16 / 9;
			min-height: 0;
			margin: -16px -16px 0;
			border-radius: var(--control-radius) var(--control-radius) 0 0;
			border-right: 0;
			border-bottom: 1px solid var(--line);
		}

		.invite-cta {
			justify-content: center;
		}
	}
</style>
