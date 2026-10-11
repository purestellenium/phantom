<script lang="ts">
	/**
	 * An amount of fragments with the fragment beside it: a balance, a price, an
	 * order's total, a ledger row. Hours.svelte's counterpart for money - time
	 * worked is still said in hours with a clock, what it buys in fragments with a
	 * fragment, so the two never read as the same number.
	 *
	 * The conversion is $lib/fragments' alone; this adds the mark and keeps the
	 * two from being split across a line. The mark is the fragment pixel icon
	 * ($lib/pixel-icons), drawn in em so it holds its proportion beside a row
	 * hint and a 40px figure alike, in the text's own colour.
	 *
	 * Like Hours, a figure that changes on screen runs from the old number to
	 * the new one, and with `count` runs up from zero once the page is
	 * revealed. The server renders the real number either way.
	 */
	import { onMount, untrack } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { Tween } from 'svelte/motion';

	import { pixelCells } from '$lib/pixel-icons';
	import { motionOk, whenRevealed } from '$lib/reveal';
	import { toFragments } from '$lib/fragments';

	let {
		seconds,
		signed = false,
		count = false,
		plain = false,
		word = true
	}: {
		seconds: number;
		/** Keep the sign, for a ledger row where the direction is the point. */
		signed?: boolean;
		/** Run up from zero on first appearing. */
		count?: boolean;
		/** The number alone, without the mark or the word: for a figure that
		 *  sits beside its own unit or target, like the home goal's "120 / 500
		 *  fragments". */
		plain?: boolean;
		/** The word after the number. Off for a headline figure whose unit is
		 *  said beside it - the home goal's "120 / 500 fragments" - which keeps
		 *  the mark but would otherwise say "fragments" twice. */
		word?: boolean;
	} = $props();

	const tween = new Tween(
		untrack(() => toFragments(seconds)),
		{ duration: 600, easing: cubicOut }
	);

	let mounted = false;
	$effect(() => {
		const target = toFragments(seconds);
		if (!mounted) return;
		void tween.set(target, { duration: motionOk() ? 600 : 0 });
	});

	onMount(() => {
		mounted = true;
		if (!count || !motionOk()) return;
		return whenRevealed(() => {
			void tween.set(0, { duration: 0 });
			void tween.set(toFragments(seconds), { duration: 900 });
		});
	});

	const text = $derived.by(() => {
		const value = Math.round(tween.current);
		const rendered = Math.abs(value).toLocaleString('en-US');
		const sign = value < 0 ? '−' : signed ? '+' : '';
		return `${sign}${rendered}`;
	});

	/* The word, always, after the number: the mark alone is not yet a thing
	   anybody reads as money. Singular from the real figure, not the running
	   one, so it does not flicker as a count runs up through one. */
	const unit = $derived(Math.abs(toFragments(seconds)) === 1 ? 'fragment' : 'fragments');

	const cells = pixelCells('fragment');
</script>

{#if plain}<span class="fragments is-plain">{text}</span>{:else}<span class="fragments"
		><svg
			class="fragments-mark"
			viewBox="0 0 12 12"
			shape-rendering="crispEdges"
			aria-hidden="true"
			focusable="false"
		>
			{#each cells as cell (`${cell.x},${cell.y}`)}
				<rect x={cell.x} y={cell.y} width="1" height="1" />
			{/each}
		</svg>{text}{word ? ` ${unit}` : ''}</span
	>{/if}

<style>
	/* Inline and unbreakable, with a little air in front for the dense glyph.
	   A plain inline run rather than a flex row: in a flex row the number was
	   centred against the taller mark and rode above the sentence's baseline.
	   Inline, the digits sit on the same line as the words around them and
	   the mark is placed against that line instead. */
	.fragments {
		display: inline;
		margin-inline-start: 0.14em;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.fragments.is-plain {
		margin-inline-start: 0;
	}

	/* A touch bigger than the clock. Its bottom sits a little under the
	   baseline - where a descender would - so its middle meets the digits'
	   middle. The gap after is wider than the clock's: the fragment leans out
	   over its right edge, and any closer it touched the first digit. */
	.fragments-mark {
		display: inline-block;
		width: 1.1em;
		height: 1.1em;
		margin-inline-end: 0.4em;
		vertical-align: -0.22em;
		fill: currentColor;
	}
</style>
