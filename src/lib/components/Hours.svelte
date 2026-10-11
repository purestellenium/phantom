<script lang="ts">
	/**
	 * An hour figure with a clock beside it: a balance, a price, a project's
	 * approved total.
	 *
	 * The number still comes from $lib/status - `hours`, `wholeHours` and
	 * `signedHours` remain the only places seconds become hours, and this does
	 * not do that arithmetic itself. What it adds is the mark in front, and a
	 * wrapper that keeps the two from being split across a line break.
	 *
	 * Drawn on a 9x9 grid of whole pixels rather than as curves, because every
	 * other figure on this site is made of cells - the field, the weaves, the
	 * dithered photographs - and a smooth vector clock beside them reads as
	 * something pasted in from another program. `shape-rendering: crispEdges`
	 * is what keeps it from being anti-aliased back into a blur at small
	 * sizes.
	 *
	 * Deliberately its own grid rather than the twelve-cell clock the console's
	 * jobs section wears: at the size this sits at - beside a row hint, inside
	 * a button - twelve cells across is too fine to read, and nine is drawn for
	 * exactly this.
	 *
	 * [1b] A figure that changes while you are looking at it - a purchase
	 * taking hours off the balance, an approval landing - runs from the old
	 * number to the new one instead of swapping, so the change is seen being
	 * made. [1a] With `count`, it also runs up from zero when it first
	 * appears, once the page is actually on screen (whenRevealed): for the
	 * headline figures, where arriving at the number is the point. The server
	 * renders the real number either way, so without script it simply reads.
	 */
	import { onMount, untrack } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { Tween } from 'svelte/motion';

	import { motionOk, whenRevealed } from '$lib/reveal';
	import { hours, signedHours, wholeHours } from '$lib/status';

	let {
		seconds,
		whole = false,
		signed = false,
		count = false,
		plain = false
	}: {
		seconds: number;
		/** Round hours, for a price: "8h" rather than "8.0h". */
		whole?: boolean;
		/** Keep the sign, for a ledger row where the direction is the point. */
		signed?: boolean;
		/** Run up from zero on first appearing - see above. */
		count?: boolean;
		/** The number alone, without the clock: for a figure that sits beside
		 *  its own unit or target, like the home page's "12.3h / 50h". */
		plain?: boolean;
	} = $props();

	const tween = new Tween(
		untrack(() => seconds),
		{ duration: 600, easing: cubicOut }
	);

	/* Follows `seconds` once mounted. Before that the tween already holds the
	   value it was made with, which is what the server rendered. */
	let mounted = false;
	$effect(() => {
		const target = seconds;
		if (!mounted) return;
		void tween.set(target, { duration: motionOk() ? 600 : 0 });
	});

	onMount(() => {
		mounted = true;
		if (!count || !motionOk()) return;
		return whenRevealed(() => {
			void tween.set(0, { duration: 0 });
			void tween.set(seconds, { duration: 900 });
		});
	});

	const text = $derived.by(() => {
		const value = tween.current;
		return signed ? signedHours(value) : whole ? wholeHours(value) : hours(value);
	});

	/* The face and the two hands, a row per line. Written out rather than
	   computed so what it looks like is legible in the source. */
	const PIXELS = [
		'..XXXXX..',
		'.X.....X.',
		'X...X...X',
		'X...X...X',
		'X...XXX.X',
		'X.......X',
		'X.......X',
		'.X.....X.',
		'..XXXXX..'
	];
	const cells = PIXELS.flatMap((row, y) =>
		[...row].map((cell, x) => (cell === 'X' ? { x, y } : null)).filter((cell) => cell !== null)
	);
</script>

{#if plain}<span class="hours is-plain">{text}</span>{:else}<span class="hours">
		<svg
			class="hours-clock"
			viewBox="0 0 9 9"
			shape-rendering="crispEdges"
			aria-hidden="true"
			focusable="false"
		>
			{#each cells as cell (`${cell.x},${cell.y}`)}
				<rect x={cell.x} y={cell.y} width="1" height="1" />
			{/each}
		</svg>{text}</span
	>{/if}

<style>
	/* Inline, and unbreakable: the clock and the number are one figure, and a
	   line break between them would read as a stray icon.

	   The spacing is set against itself on purpose, and is asymmetric because
	   the figure is. A word space is about 0.25em, and a gap of 0.36em inside
	   the figure put the clock CLOSER to the preceding word than to its own
	   number - "you have [clock]" followed by a stray figure. So the inner gap
	   is now narrower than a word space, and a little is added in FRONT, where
	   a dense pixel glyph needs the air. Nothing is added after: the figure
	   ends in a plain "h", which is ordinary text and wants nothing more than
	   the ordinary space already following it. */
	.hours {
		display: inline-flex;
		align-items: center;
		gap: 0.26em;
		margin-inline-start: 0.14em;
		white-space: nowrap;
		/* Digits of one width, so a number running up does not jitter. */
		font-variant-numeric: tabular-nums;
	}

	.hours.is-plain {
		display: inline;
		margin-inline-start: 0;
	}

	/* Sized from the type it sits beside rather than in pixels, so it holds its
	   proportion in a row hint and in a 40px figure alike. `currentColor` for
	   the same reason: it is part of the text, not a decoration with an opinion
	   of its own. */
	.hours-clock {
		width: 0.82em;
		height: 0.82em;
		flex: none;
		fill: currentColor;
		/* The cap height sits a little above the box's middle; this drops the
		   clock to sit on the digits' optical centre instead of floating. */
		transform: translateY(0.04em);
	}
</style>
