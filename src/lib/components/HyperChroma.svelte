<script lang="ts">
	/**
	 * The hyper-chroma pill: a project marked exceptionally good (see
	 * projects/hyper-chroma.ts).
	 *
	 * The one badge that is every colour at once, built from the colours the
	 * other decision badges already wear (panel.css): the dark fills and edges
	 * of rejected, changes requested and approved, with a blue and a violet
	 * added in the same recipe - a dark fill, a mid edge, light text, the alarm
	 * weave over it. So it reads as one of the family, just all of them.
	 */
	let { title = 'marked exceptionally good by a reviewer' }: { title?: string } = $props();
</script>

<span class="badge hc-pill" {title}>hyper-chroma</span>

<style>
	/* Prefixed: src/styles has generic global classes that would otherwise
	   reach in here. */

	/* The fill and the edge are two backgrounds - the fills clipped to the
	   padding box, the edges showing through a transparent border - because a
	   border cannot carry a gradient and still follow the pill's radius. The
	   weave sits over the fills, as it does on every decision badge.

	   Both gradients end on the colour they start with and are drawn at twice
	   the pill's width, so sliding them one full width along loops without a
	   seam. The weave stays put: it is the material, and only the colour
	   moves. Still, for a reader who asked for less motion. */
	/* The type is set rather than inherited, so the pill is the same pill
	   inside a heading's serif italic as anywhere else. */
	.hc-pill {
		flex: none;
		font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
		font-style: normal;
		color: #f4ecd6;
		border-color: transparent;
		background-color: #241a2c;
		background-image:
			var(--weave-alarm),
			linear-gradient(90deg, #3a1519, #33290f, #16301e, #132838, #2a1738, #3a1519),
			linear-gradient(90deg, #c2414c, #c9a227, #3f9d57, #3f86b8, #9a5bc4, #c2414c);
		background-size:
			auto,
			200% 100%,
			200% 100%;
		background-clip: padding-box, padding-box, border-box;
		background-origin: padding-box, padding-box, border-box;
		animation: hc-drift 4s linear infinite;
	}

	/* A background twice the box's width, positioned at 200%, has moved one
	   whole width of itself: back where it started, as far as the eye can
	   tell. */
	@keyframes hc-drift {
		from {
			background-position:
				0 0,
				0 0,
				0 0;
		}
		to {
			background-position:
				0 0,
				200% 0,
				200% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.hc-pill {
			animation: none;
		}
	}
</style>
