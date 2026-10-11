<script lang="ts">
	/**
	 * One card, three pages.
	 *
	 * The projects page, the explore gallery and the shop each show a grid of
	 * things with a picture, a name and a line or two - so they share one card
	 * rather than three that drift apart. The order is fixed: picture, the name
	 * with a figure or a state beside it, who it is by, then the blurb. What
	 * differs is passed in: a link makes the whole card the target; actions are
	 * buttons at the foot.
	 */
	import type { Snippet } from 'svelte';
	/* No picture: a thumbnail of the field itself, seeded by the name. */
	import { thumbField } from '$lib/field/thumb';
	import { fitText } from '$lib/fit-text';
	import HyperChroma from '$lib/components/HyperChroma.svelte';

	let {
		href,
		image,
		imagePadding = 0,
		name,
		aside,
		badge,
		hyperChroma = false,
		compact = false,
		by,
		description,
		cta,
		ctaNote = null,
		shop = false,
		index = null,
		actions
	}: {
		href?: string;
		image?: string | null;
		/** Space around that picture, in CSS pixels. Zero bleeds it to the card's
		 *  edges, which is what a photograph wants; a cut-out wants air. */
		imagePadding?: number;
		name: string;
		/** The figure beside the name: hours, a price. A snippet when it needs
		 *  markup of its own - an hours figure with its clock, say. */
		aside?: string | Snippet | null;
		/** A state beside the name instead of a figure. */
		badge?: { label: string; tone?: string } | null;
		/** A project marked exceptionally good: the hyper-chroma pill, at the end
		 *  of the byline - or on its own line under the name when there is no
		 *  byline - so it sits beside a figure or a state rather than replacing
		 *  it. */
		hyperChroma?: boolean;
		/** A shorter card, for a strip of them above a grid: a wider, lower
		 *  picture and two lines of blurb (cards.css, `.is-compact`). */
		compact?: boolean;
		/** The line under the name: an author, a number, a stock count. */
		by?: string | null;
		description?: string | null;
		/**
		 * The call to action closing the card: "buy for 5h".
		 *
		 * Drawn as a full-width button but rendered as a span, because on a card
		 * that is itself a link this is not a second thing to click - it is the
		 * card's own target, said out loud. A real button or anchor here would
		 * be interactive content nested inside an anchor, which is invalid, and
		 * a second tab stop leading exactly where the first one goes.
		 */
		cta?: string | Snippet | null;
		/** A thing for sale: the blurb is drawn small. */
		shop?: boolean;
		/** [3a] Its place in a list being laid out. Given one, the card fades
		 *  up a beat after the one before it as it arrives (cards.css) - on a
		 *  grid's first draw and on each "show more". Left out for a card that
		 *  is not one of a list, like the new-project flow's preview. */
		index?: number | null;
		actions?: Snippet;
		/** A quiet line under the call to action - the shop's "about 5h of
		 *  work", saying a price in the time it takes to earn. */
		ctaNote?: string | null;
	} = $props();
</script>

{#snippet inner()}
	{#if image}
		<span
			class={['card-thumb', imagePadding > 0 && 'is-padded']}
			style={imagePadding > 0 ? `padding: ${imagePadding}px` : undefined}
			><img src={image} alt="" loading="lazy" /></span
		>
	{:else}
		<span class="card-thumb is-empty" aria-hidden="true">
			<canvas use:thumbField={name}></canvas>
		</span>
	{/if}
	<span class="card-head">
		<h3>{name}</h3>
		{#if badge}
			<span class={['badge', badge.tone]}>{badge.label}</span>
		{:else if aside}
			<span class="card-aside"
				>{#if typeof aside === 'string'}{aside}{:else}{@render aside()}{/if}</span
			>
		{/if}
	</span>
	{#if by}<p class={['card-by', hyperChroma && 'card-by-hc']}>
			<span>{by}</span>{#if hyperChroma}<HyperChroma />{/if}
		</p>
	{:else if hyperChroma}<span class="card-hc"><HyperChroma /></span>{/if}
	{#if description}<p class="card-desc">{description}</p>{/if}
	<!-- One line, always: a price broken across two lines read as two
	     buttons. fitText sets the rare long one a little smaller instead. -->
	{#if cta}<span class="card-cta control-btn" use:fitText
			>{#if typeof cta === 'string'}{cta}{:else}{@render cta()}{/if}</span
		>{/if}
	{#if ctaNote}<span class="card-cta-note">{ctaNote}</span>{/if}
	{#if actions}<span class="card-actions">{@render actions()}</span>{/if}
{/snippet}

{#if href}
	<!-- Callers pass an already-resolved href (or an external URL). -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		class={[
			'card card-link',
			shop && 'is-shop',
			compact && 'is-compact',
			index !== null && 'is-listed'
		]}
		style={index !== null ? `--i: ${index}` : undefined}
		{href}>{@render inner()}</a
	>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
	<article
		class={['card', shop && 'is-shop', compact && 'is-compact', index !== null && 'is-listed']}
		style={index !== null ? `--i: ${index}` : undefined}
	>
		{@render inner()}
	</article>
{/if}

<style>
	.card-hc {
		display: flex;
	}

	/* The byline with the pill at its end: one row, wrapping the pill under
	   it when a long handle leaves no room. */
	.card-by-hc {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
	}
</style>
