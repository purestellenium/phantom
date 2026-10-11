<script lang="ts">
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';

	import { applyAction, enhance } from '$app/forms';
	import { trackEvent } from '$lib/analytics/client';
	import { resolve } from '$app/paths';
	import Card from '$lib/components/Card.svelte';
	import ArrowUp from '@lucide/svelte/icons/arrow-big-up';
	import Hours from '$lib/components/Hours.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { KINDS, NO_FILTERS, SORTS, exploreQuery, isNarrowed } from '$lib/explore/filters';
	import { PAGE_SIZE, onVisible } from '$lib/paging';
	import type { ShowcaseCard } from '$lib/server/projects/pages';

	let { data, form }: PageProps = $props();

	/* The filters are a GET form, so they work before (and without) the
	   script: the URL is the state, and the load reads it. With the script, a
	   dropdown applies the moment it changes and the search box as you pause
	   typing - each as a navigation that replaces the history entry rather
	   than stacking one per keystroke. */
	let filterForm = $state<HTMLFormElement>();
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function applyNow() {
		clearTimeout(searchTimer);
		filterForm?.requestSubmit();
	}

	function applySoon() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => filterForm?.requestSubmit(), 350);
	}

	const narrowed = $derived(isNarrowed(data.filters));

	/* The card's line under the name: who, and what kind - or, on a
	   hyper-chroma project, who, with the pill in place of the kind (Card
	   draws it at the end of this line). */
	function byline(project: ShowcaseCard): string {
		return [
			project.authorUsername ? `by @${project.authorUsername}` : null,
			project.hyperChroma ? null : project.kind
		]
			.filter(Boolean)
			.join(' · ');
	}

	/* Votes cast on this page, by project number, over what the server said.
	   A vote moves the moment it is pressed and is put back if the server
	   refuses it. Kept here rather than by re-running the load, because the
	   load only knows the first page - a vote on a card that arrived on
	   scroll would otherwise lose its own count. */
	let votes = $state<Record<number, { upvoted: boolean; upvotes: number }>>({});

	function voteOf(project: ShowcaseCard) {
		return votes[project.number] ?? { upvoted: project.upvoted, upvotes: project.upvotes };
	}

	function vote(project: ShowcaseCard): SubmitFunction {
		return () => {
			const before = voteOf(project);
			votes[project.number] = {
				upvoted: !before.upvoted,
				upvotes: before.upvotes + (before.upvoted ? -1 : 1)
			};
			return async ({ result }) => {
				if (result.type === 'success') return;
				votes[project.number] = before;
				await applyAction(result);
			};
		};
	}

	type Page = { items: ShowcaseCard[]; more: boolean; nextOffset: number };

	/**
	 * The grid, growing.
	 *
	 * Only the pages fetched AFTER the first are held as state; the first page
	 * stays `data.items` and everything on screen is derived from the two. That
	 * ordering matters. Copying `data.items` into `$state` would snapshot it -
	 * the value is read once, at initialisation, and a later load returning
	 * different rows would never reach the grid. Deriving means a navigation, an
	 * invalidation or a form action reruns the load and the grid simply follows,
	 * and it still server-renders, which seeding from an effect would not:
	 * effects do not run during SSR, so the first paint would be empty.
	 */
	let pages = $state<Page[]>([]);
	let loading = $state(false);
	let failed = $state(false);

	const items = $derived([...data.items, ...pages.flatMap((page) => page.items)]);
	const last = $derived(pages.at(-1));
	const more = $derived(last ? last.more : data.more);
	const nextOffset = $derived(last ? last.nextOffset : data.nextOffset);

	/* Fresh data means a fresh list, so the pages appended to the OLD one have to
	   go - otherwise coming back to /explore stacks a second copy underneath.
	   This reads `data.items` and writes `pages`, which are different values, so
	   it settles in one pass rather than retriggering itself. */
	$effect(() => {
		void data.items;
		pages = [];
		failed = false;
		votes = {};
	});

	async function loadMore() {
		/* Three guards, three different ways this gets called more than once: the
		   observer fires again while a fetch is in flight, it fires after the last
		   page, and it fires again after a failure. Without the last one a dropped
		   connection turns into a request per scroll frame. */
		if (loading || !more || failed) return;
		loading = true;
		try {
			const filters = exploreQuery(data.filters).replace(/^\?/, '&');
			const response = await fetch(`/api/showcase?offset=${nextOffset}${filters}`);
			if (!response.ok) throw new Error(String(response.status));
			pages = [...pages, (await response.json()) as Page];
			trackEvent('explore.loaded_more', { page: pages.length + 1 });
		} catch {
			/* Silent in the console, visible on the page: the button below becomes
			   the way forward, because an infinite scroll that has quietly stopped
			   is indistinguishable from one that has reached the end. */
			failed = true;
		} finally {
			loading = false;
		}
	}

	function retry() {
		failed = false;
		loadMore();
	}
</script>

<!-- The clear-filters link is resolve() plus a query string, which the rule
     cannot follow through the template literal. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->

<svelte:head>
	<title>explore · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">explore</h1>
</header>

<!-- One project's card, in the grid and in the hyper-chroma panel alike.
     `featured` is the panel: a shorter card, so the panel does not push the
     grid a screen down, and an open counted as coming from it. -->
{#snippet projectCard(project: ShowcaseCard, index: number, featured: boolean)}
	{@const cast = voteOf(project)}
	<Card
		{index}
		image={project.screenshotUrl}
		name={project.name}
		hyperChroma={project.hyperChroma}
		compact={featured}
		by={byline(project)}
		description={project.description}
	>
		{#snippet aside()}<Hours seconds={project.totalApprovedSeconds} />{/snippet}
		{#snippet actions()}
			<!-- Two buttons across the card's foot: most of it opens the
			     project, the end upvotes. Both the quiet grey until a vote
			     lights the upvote white. Side by side rather than a button
			     inside a link, which is invalid and leaves the vote
			     unreachable by keyboard. -->
			<span class="xp-cta">
				<a
					class="control-btn is-quiet xp-cta-view"
					href={resolve('/(app)/explore/[number]', { number: String(project.number) })}
					onclick={featured ? () => trackEvent('explore.hyper_chroma_opened') : undefined}
					>view project</a
				>
				{#if project.mine}
					<span
						class="control-btn is-quiet xp-cta-vote is-mine"
						title="your project"
						aria-label="{cast.upvotes} upvotes on your project"
					>
						<ArrowUp size={17} aria-hidden="true" />
						<span class="xp-count">{cast.upvotes}</span>
					</span>
				{:else}
					<form method="POST" action="?/upvote" use:enhance={vote(project)}>
						<input type="hidden" name="number" value={project.number} />
						<input type="hidden" name="up" value={cast.upvoted ? '0' : '1'} />
						<button
							type="submit"
							class={['control-btn', cast.upvoted ? 'is-on' : 'is-quiet', 'xp-cta-vote']}
							aria-pressed={cast.upvoted}
							aria-label="{cast.upvoted ? 'remove your upvote' : 'upvote'} ({cast.upvotes})"
						>
							<ArrowUp size={17} aria-hidden="true" />
							<span class="xp-count">{cast.upvotes}</span>
						</button>
					</form>
				{/if}
			</span>
		{/snippet}
	</Card>
{/snippet}

<!-- The projects most recently marked hyper-chroma, above everything else and
     the same whatever the grid is sorted by. Left out while there are none,
     and while the grid is narrowed: a search is asking for something in
     particular, and three unrelated projects above its answer are in the way.
     They stay in the grid too, wearing the same pill. -->
{#if data.featured.items.length > 0 && !narrowed}
	<section class="panel xp-hc" aria-labelledby="xp-hc-title">
		<header class="panel-head">
			<h2 class="panel-title" id="xp-hc-title">featured projects</h2>
			<!-- With more than the panel holds, the note becomes the way to the
			     rest: the grid, narrowed to hyper-chroma. -->
			{#if data.featured.more}
				<a
					class="control-btn is-small xp-hc-all"
					href={`${resolve('/explore')}${exploreQuery({ ...NO_FILTERS, hyperChroma: true })}`}
					>all hyper-chroma projects →</a
				>
			{:else}
				<span class="panel-note">marked exceptionally good by a reviewer</span>
			{/if}
		</header>
		<div class="panel-body">
			<div class="cards">
				{#each data.featured.items as project, i (project.projectId)}
					{@render projectCard(project, i, true)}
				{/each}
			</div>
		</div>
	</section>
{/if}

<form
	class="xp-filters"
	method="GET"
	action={resolve('/explore')}
	bind:this={filterForm}
	data-sveltekit-replacestate
	data-sveltekit-keepfocus
	data-sveltekit-noscroll
	role="search"
>
	<label class="xp-search">
		<span class="sr-only">search projects</span>
		<input
			class="control-input"
			type="search"
			name="q"
			value={data.filters.q ?? ''}
			placeholder="search projects or @users"
			maxlength="100"
			autocomplete="off"
			oninput={applySoon}
		/>
	</label>
	<label class="xp-pick select-field">
		<span class="sr-only">project type</span>
		<select class="control-select" name="kind" value={data.filters.kind ?? ''} onchange={applyNow}>
			{#each KINDS as kind (kind.label)}
				<option value={kind.key ?? ''}>{kind.label}</option>
			{/each}
		</select>
		<span class="select-caret" aria-hidden="true">▼</span>
	</label>
	<label class="xp-pick select-field">
		<span class="sr-only">sort by</span>
		<select class="control-select" name="sort" value={data.filters.sort} onchange={applyNow}>
			{#each SORTS as sort (sort.key)}
				<option value={sort.key}>{sort.label}</option>
			{/each}
		</select>
		<span class="select-caret" aria-hidden="true">▼</span>
	</label>
	<!-- Kept through the dropdowns and the search: the hyper-chroma filter
	     has no control of its own in this form (see the line below it). -->
	{#if data.filters.hyperChroma}<input type="hidden" name="hc" value="1" />{/if}
	<!-- What applies the filters before the script arrives; with it, they apply
	     themselves and this stays out of the way. -->
	<noscript><button type="submit" class="control-btn is-quiet">apply</button></noscript>
</form>

<!-- The hyper-chroma filter has no dropdown, so it says it is on, and how to
     turn it off, where the grid starts. -->
{#if data.filters.hyperChroma}
	<p class="xp-narrowed">
		showing hyper-chroma projects only ·
		<a
			class="link"
			href={`${resolve('/explore')}${exploreQuery({ ...data.filters, hyperChroma: false })}`}
			>show every project</a
		>
	</p>
{/if}

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

{#if items.length === 0}
	<section class="panel">
		<div class="panel-body">
			{#if narrowed}
				<p class="panel-prose">
					nothing matches that.
					<a
						class="link"
						href={`${resolve('/explore')}${exploreQuery({ ...NO_FILTERS, sort: data.filters.sort })}`}
						>clear the filters</a
					>
				</p>
			{:else}
				<p class="panel-prose">
					nothing here yet; <a class="link" href={resolve('/projects')}>be the first.</a>
				</p>
			{/if}
		</div>
	</section>
{:else}
	<div class="cards">
		{#each items as project, i (project.projectId)}
			{@render projectCard(project, i % PAGE_SIZE, false)}
		{/each}
	</div>

	{#if more}
		<!-- The sentinel and the button are the same control, and the button is
		     not a fallback nobody sees: it is what is left when JavaScript has not
		     arrived, when IntersectionObserver never fires, and when a fetch
		     fails. The observer just saves you pressing it. -->
		<div class="page-more" use:onVisible={loadMore}>
			{#if failed}
				<button type="button" class="control-btn is-quiet" onclick={retry}>
					that did not load - try again
				</button>
			{:else}
				<button type="button" class="control-btn is-quiet" onclick={loadMore} disabled={loading}>
					{loading ? 'loading…' : 'show more'}
				</button>
			{/if}
		</div>
	{/if}
{/if}

<style>
	/* Prefixed: src/styles has generic global classes that would otherwise
	   reach in here. */

	/* The cards sit a step down from the panel, on very nearly the page's own
	   dark. On the panel's grey they sank in: the card edge (--line) is all
	   but the panel's colour, and the card's fill is darker than it, so each
	   read as a hole in the panel rather than a card on it.

	   Printed with the Bayer weave rather than the panel's grid: the cards
	   carry the grid themselves, and grid on grid read as one ruled sheet with
	   the cards' edges lost in it. The dither is one of the site's own
	   materials, so it reads as static behind them rather than as a texture
	   from somewhere else. Even the soft weave pulled the eye off the cards,
	   and there is no fainter tile, so it is laid on its own layer at three-quarter
	   strength - behind the cards, which `isolation` keeps it from slipping
	   under the panel itself. The head keeps the panel's grey, so it still
	   reads as one piece. */
	.xp-hc :global(.panel-body) {
		position: relative;
		isolation: isolate;
		background-color: #121215;
		background-image: var(--shade-inset);
	}

	.xp-hc :global(.panel-body)::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		background-image: var(--weave-bayer);
		opacity: 0.75;
		pointer-events: none;
	}

	/* In the featured panel the pictures keep their colour: every other card's
	   picture goes through the grey dither (cards.css, .card-thumb img), and
	   these are the projects named for being full of it. Still dithered, so
	   they are made of the same material as everything around them - through
	   the colour filter instead (Dither.svelte, #dither-colour), seven levels
	   per channel. Reaching the card shows the picture as it really is, as on
	   every card; said again here, since this rule would otherwise outrank
	   that one. Only here - the same projects in the grid below are dithered
	   grey like the rest. */
	.xp-hc :global(.card-thumb img) {
		filter: url(#dither-colour);
	}

	.xp-hc :global(.card:hover .card-thumb img),
	.xp-hc :global(.card:has(:focus-visible) .card-thumb img) {
		filter: none;
	}

	/* The button to every hyper-chroma project, at the head's far end where
	   the note it replaces sat (panel.css, .panel-note). */
	.xp-hc-all {
		margin-left: auto;
		text-decoration: none;
	}

	.xp-narrowed {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	.xp-filters {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		/* No margin of its own: the shell already spaces every block on the
		   page (shell.css, .shell-main's gap). */
	}

	.xp-search {
		display: flex;
		flex: 1 1 260px;
		min-width: 0;
	}

	.xp-search :global(.control-input) {
		flex: 1 1 auto;
	}

	/* `.select-field` is full width for a form column; in this row it is as
	   wide as what it says. */
	.xp-pick {
		flex: 0 0 auto;
		width: auto;
	}

	/* The card's foot: two buttons cut into the card itself rather than
	   sitting on it. The row bleeds to the card's edges the way the picture
	   does at the top (cards.css, .card-thumb), the buttons lose their own
	   border and corners, and a hairline across the top and one between them
	   are the cuts - view takes the room, the vote is its own piece at the
	   end. The bottom corners follow the card's, less its 1px edge. */
	/* 17px rather than the card's 16px of padding: the row reaches over the
	   card's own 1px edge and draws its own in the resting colour, so when the
	   card is reached and its edge lights, the stretch beside the buttons
	   does not. */
	.xp-cta {
		display: flex;
		flex: 1 1 auto;
		width: calc(100% + 34px);
		margin: 4px -17px -17px;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 0 0 var(--control-radius) var(--control-radius);
	}

	.xp-cta :global(.control-btn) {
		border: 0;
		border-radius: 0;
	}

	.xp-cta :global(.xp-cta-view) {
		flex: 1 1 auto;
		justify-content: center;
		text-align: center;
		text-decoration: none;
	}

	.xp-cta :global(.xp-cta-vote) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
		height: 100%;
		/* A fixed width, in every state: the count changing, or the fill and
		   edge changing with the vote, never moves the button. */
		justify-content: center;
		width: 80px;
		min-width: 0;
		padding-inline: 0;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		border-inline-start: 1px solid var(--line);
	}

	/* Reached and upvoted are one look: the quiet button's light hover fill,
	   under the softer weave (--weave-bayer) rather than its hard one, so the
	   squares sit back. A vote looks like the hover, held. The card is the
	   view link stretched, so reaching anywhere on it lights "view project". */
	.xp-cta :global(.xp-cta-vote.is-on),
	.xp-cta :global(.xp-cta-vote:not(.is-mine):hover),
	.xp-cta :global(.xp-cta-vote:not(.is-mine):focus-visible),
	.xp-cta :global(.xp-cta-view:hover),
	.xp-cta :global(.xp-cta-view:focus-visible) {
		color: var(--on-light);
		background-color: var(--ink);
		background-image: var(--weave-bayer), var(--shade-raised);
	}

	/* The whole card opens the project. "view project" is the one link, and
	   it is stretched over the card - the card is its positioning box - so a
	   click anywhere on the picture, name or blurb lands on it. The upvote sits
	   above that layer, so it stays its own control. One link per card, not a
	   link wrapped round a button, which would be invalid. */
	:global(.card:has(.xp-cta)) {
		position: relative;
		transition: border-color 120ms ease;
	}

	.xp-cta :global(.xp-cta-view)::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
	}

	.xp-cta form,
	.xp-cta :global(.xp-cta-vote.is-mine) {
		position: relative;
		z-index: 1;
	}

	.xp-cta form {
		display: flex;
	}

	/* Reaching the card lifts its edge and brightens its name, as every other
	   linked card does (cards.css, .card-link). The button row keeps its own
	   edge, so the lift stops where the buttons begin. */
	:global(.card:has(.xp-cta-view:hover)),
	:global(.card:has(.xp-cta-view:focus-visible)) {
		border-color: var(--panel-line);
	}

	:global(.card:has(.xp-cta-view:hover) h3),
	:global(.card:has(.xp-cta-view:focus-visible) h3) {
		color: #ffffff;
	}

	/* The count holds three digits' room, so a vote that takes 9 to 10 does
	   not widen the button under the pointer. */
	.xp-count {
		display: inline-block;
		min-width: 3ch;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.xp-cta :global(.xp-cta-vote.is-mine) {
		cursor: not-allowed;
		opacity: 0.75;
	}
</style>
