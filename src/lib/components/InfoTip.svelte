<script module>
	/* Per-instance ids, so the mark and its bubble can be tied together for a
	   screen reader without the caller having to invent one. */
	let count = 0;
</script>

<script lang="ts">
	/**
	 * A small "?" that reveals a line of explanation on hover or focus.
	 *
	 * Shown by CSS: `:hover` on the wrapper, and keyboard focus on the mark,
	 * so it answers a mouse and a keyboard alike without a click pinning it
	 * open. Placed by script: a panel hides its overflow, so a bubble
	 * positioned inside it was cut off at the panel's edge. On hover or focus
	 * it is pinned to the window instead - under the mark, pushed left if it
	 * would run off the screen - which lets it spill past the panel. Before
	 * hydration it falls back to sitting inside.
	 *
	 * The mark is a real button so it is reachable by tab and announces
	 * itself; the bubble is `role="tooltip"` and tied to it with
	 * `aria-describedby`, so what it says is read out rather than left as a
	 * thing only a pointer can find.
	 */
	import type { Snippet } from 'svelte';

	let { label = 'more info', children }: { label?: string; children: Snippet } = $props();

	count += 1;
	const id = `infotip-${count}`;

	let wrap = $state<HTMLSpanElement>();
	let bubble = $state<HTMLSpanElement>();
	let placed = $state<{ top: number; left: number } | null>(null);

	/* Hidden bubbles still lay out (visibility, not display), so the width is
	   there to measure before it shows. */
	function place() {
		if (!wrap || !bubble) return;
		const mark = wrap.getBoundingClientRect();
		const edge = 8;
		const left = Math.max(edge, Math.min(mark.left, window.innerWidth - bubble.offsetWidth - edge));
		placed = { top: mark.bottom + 14, left };
	}
</script>

<svelte:window onscroll={() => placed && place()} onresize={() => placed && place()} />

<span class="infotip" bind:this={wrap}>
	<!-- Placed from the mark, which is what opens it by hover or by focus. -->
	<button
		type="button"
		class="infotip-mark"
		aria-label={label}
		aria-describedby={id}
		onmouseenter={place}
		onfocus={place}>?</button
	>
	<span
		{id}
		class={['infotip-bubble', placed && 'is-placed']}
		role="tooltip"
		bind:this={bubble}
		style={placed ? `top: ${placed.top}px; left: ${placed.left}px` : undefined}
		>{@render children()}</span
	>
</span>

<style>
	.infotip {
		position: relative;
		display: inline-flex;
		vertical-align: middle;
	}

	/* Its own font, not the heading's - dropped into a serif italic title, an
	   inherited "?" would come out italic and oversized. A round chip on the lift
	   level so it reads as a control against the panel, lighting to the full fill
	   when reached. */
	.infotip-mark {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		padding: 0;
		font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
		font-style: normal;
		font-weight: 600;
		font-size: 11px;
		line-height: 1;
		color: var(--ink);
		background-color: var(--level-lift);
		border: 1px solid var(--panel-line);
		border-radius: 50%;
		background-image: var(--weave-bayer), var(--shade-inset);
		cursor: help;
		transition:
			background-color 120ms ease,
			color 120ms ease,
			border-color 120ms ease;
	}

	.infotip-mark:hover,
	.infotip-mark:focus-visible {
		color: var(--on-light);
		background-color: var(--ink);
		border-color: var(--ink);
		outline: none;
	}

	/* Drops below the mark rather than above it: these sit in a panel head, and a
	   panel clips its own overflow, so a bubble going up would be cut off while
	   one going down falls into the body it is already inside. The surface level -
	   darker than the panel - so it reads as a distinct floating thing and the
	   small text on it clears contrast the way the notice's does; the raise level
	   above the panel would have left 12px text at under three to one. */
	.infotip-bubble {
		position: absolute;
		top: calc(100% + 14px);
		left: 0;
		z-index: 20;
		width: max-content;
		max-width: 280px;
		padding: 11px 13px;
		/* Its own font, not the caller's. Dropped into a serif-italic panel title
		   this was inheriting it - a small italic serif is exactly the hard-to-read
		   combination. Geist sans, upright, a step up from the mono/xs so the line
		   is comfortable at tooltip size. */
		font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
		font-style: normal;
		font-size: var(--text-sm);
		font-weight: 400;
		line-height: 1.5;
		color: var(--ink);
		background-color: var(--level-surface);
		border: 1px solid var(--panel-line);
		border-radius: var(--control-radius);
		background-image: var(--weave-bayer), var(--shade-inset);
		opacity: 0;
		visibility: hidden;
		transform: translateY(-2px);
		pointer-events: none;
		transition:
			opacity 120ms ease,
			transform 120ms ease,
			visibility 120ms;
	}

	/* Pinned to the window so no panel can clip it; `place` sets top and left. */
	.infotip-bubble.is-placed {
		position: fixed;
	}

	.infotip:hover .infotip-bubble,
	/* Keyboard focus only. A mouse click also focuses the mark, and with
	   :focus-within that pinned the bubble open until you clicked elsewhere. */
	.infotip:has(.infotip-mark:focus-visible) .infotip-bubble {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
	}
</style>
