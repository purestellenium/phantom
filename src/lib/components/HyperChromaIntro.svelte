<script lang="ts">
	/**
	 * "Your project is hyper-chroma", once per project: the first time its
	 * owner looks at it after a reviewer marked it (see
	 * projects/hyper-chroma.ts), on its own page or on explore.
	 *
	 * The DM says it too, but a DM is easily missed, and the pill on its own
	 * says the project is special without saying how. Remembered in this
	 * browser only (localStorage, like FragmentsIntro): it is a celebration,
	 * not a record, and seeing it again on another device costs one click.
	 * Counted as seen once it is dismissed, however - "nice!", Escape, a click
	 * beside it. Leaving or refreshing the page while it is still up plays it
	 * again next time.
	 *
	 * Not a modal like the others: it takes the whole screen, once. An ordered
	 * dither - the Bayer pattern every picture on the site is put through
	 * (Dither.svelte) - is drawn across the page from the top left, its leading edge in the
	 * pill's colours, filling in cell by cell until the page is behind an even,
	 * solid dark. Then the card arrives. One move, made of the site's
	 * own material, and nothing after it but the pill's drift. A reader who
	 * asked for less motion gets the finished screen at once.
	 */
	import { onMount } from 'svelte';

	import { trackEvent } from '$lib/analytics/client';
	import HyperChroma from '$lib/components/HyperChroma.svelte';
	import { whenRevealed } from '$lib/reveal';

	let { number, name, where }: { number: number; name: string; where: 'page' | 'explore' } =
		$props();

	let dialog: HTMLDialogElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let title: HTMLHeadingElement | undefined = $state();
	let closing = $state(false);

	/* The 4×4 Bayer matrix: the order the cells of a tile fill in. */
	const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
	/* One cell of the screen, in CSS pixels. A tile is four by four. */
	const CELL = 4;
	const TILE = CELL * 4;
	/* Every one of a tile's sixteen cells ends up dark: the dither is how the
	   screen arrives, not how it stays. */
	const COVER = 16;
	/* How many of the most recently filled cells are drawn in colour - the
	   width of the coloured edge, in dither levels. */
	const EDGE = 4;
	/* Not quite opaque, so the page is still faintly there under it - evenly,
	   rather than through holes. */
	const SCREEN = 'rgba(10, 10, 12, 0.9)';
	/* The pill's edge colours, along the sweep's front. */
	const PALETTE = ['#c2414c', '#c9a227', '#3f9d57', '#3f86b8', '#9a5bc4'];
	/* On a first load, how long after the loader starts dissolving (0.7s, see
	   Loader.svelte) before this starts, in ms: the page has finished
	   arriving and had a beat on its own. */
	const WAIT = 900;
	/* Arriving by a link inside the site, with no loader: shorter, just long
	   enough for the page to be seen before it is broken into. */
	const WAIT_NAVIGATED = 200;
	/* The sweep, in ms. The card's own delay below is keyed to it. */
	const SWEEP = 1100;

	onMount(() => {
		let seen = false;
		try {
			seen = localStorage.getItem(seenKey()) !== null;
		} catch {
			/* A private window: it comes back next time, which is fine. */
		}
		if (seen || !dialog) return;
		/* Behind the loader on a first load, so it waits for the cover to come
		   off and the page to be seen as it is before anything breaks into it.
		   Arriving by a link inside the site there is no loader, so the beat
		   is shorter. The card's CSS delays count from the opening, so they
		   move with this. */
		const loading = document.documentElement.classList.contains('is-loading');
		let stop: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const open = () => {
			if (!dialog) return;
			dialog.showModal();
			/* `showModal` focuses the first thing it can, which is the button -
			   and a focused button wears its hover look, so it sat lit until
			   clicked. The title instead: nothing lights, and a screen reader
			   starts from the top. */
			title?.focus();
			trackEvent('project.hyper_chroma_introduced', { where });
			stop = sweep();
		};
		const cancelReveal = whenRevealed(() => {
			timer = setTimeout(open, loading ? WAIT : WAIT_NAVIGATED);
		});
		return () => {
			cancelReveal();
			clearTimeout(timer);
			stop?.();
		};
	});

	/**
	 * The screen. Each tile of the page is at some dither level, from nothing
	 * to COVER, according to how far the front has passed it; the last few
	 * levels a tile gained are drawn in colour, which is what makes the front
	 * an edge of colour rather than a shadow. A level is one pre-drawn tile
	 * used as a pattern, so a frame is a fill per run of like tiles, not a
	 * fill per cell.
	 */
	function sweep(): (() => void) | undefined {
		const context = canvas?.getContext('2d');
		if (!canvas || !context) return;
		const surface = canvas;
		const edge = document.createElement('canvas');
		const edgeContext = edge.getContext('2d');
		if (!edgeContext) return;

		/* A tile with the cells whose Bayer rank is in [from, to) filled. */
		const tiles: Record<string, CanvasPattern | null> = {};
		const tile = (from: number, to: number): CanvasPattern | null => {
			const key = `${from}:${to}`;
			if (!(key in tiles)) {
				const t = document.createElement('canvas');
				t.width = TILE;
				t.height = TILE;
				const c = t.getContext('2d');
				if (c) {
					c.fillStyle = '#fff';
					BAYER.forEach((rank, i) => {
						if (rank >= from && rank < to)
							c.fillRect((i % 4) * CELL, Math.floor(i / 4) * CELL, CELL, CELL);
					});
				}
				tiles[key] = context.createPattern(t, 'repeat');
			}
			return tiles[key];
		};

		let width = 0;
		let height = 0;
		const fit = () => {
			const ratio = window.devicePixelRatio || 1;
			width = surface.clientWidth;
			height = surface.clientHeight;
			for (const [c, ctx] of [
				[surface, context],
				[edge, edgeContext]
			] as const) {
				c.width = Math.round(width * ratio);
				c.height = Math.round(height * ratio);
				ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
				ctx.imageSmoothingEnabled = false;
			}
		};

		/* The pattern is white; drawing it with `source-in` under a fill keeps
		   the cells and takes the fill's colour. */
		/* A run of tiles along one row, all at the same levels: one fill. */
		const run = (
			ctx: CanvasRenderingContext2D,
			x: number,
			y: number,
			w: number,
			from: number,
			to: number
		) => {
			const pattern = tile(from, to);
			if (!pattern || to <= from) return;
			ctx.fillStyle = pattern;
			ctx.fillRect(x, y, w, TILE);
		};

		const draw = (progress: number) => {
			context.clearRect(0, 0, width, height);
			edgeContext.clearRect(0, 0, width, height);
			/* The front runs diagonally, from the top left corner to the bottom
			   right: a tile's turn comes by how far it is along that diagonal.
			   Each takes `span` of the run to go from bare to covered, and the
			   front starts and ends off the screen so the whole of it crosses.
			   Neighbouring tiles at the same levels are drawn as one run, so a
			   frame is a few fills per row rather than one per tile. */
			const span = 0.55;
			for (let y = 0; y < height; y += TILE) {
				let from = 0;
				let key = '';
				let dark = 0;
				let level = 0;
				/* One step past the last tile, whatever the width, so the run
				   still open at the end of the row is always drawn. */
				for (let x = 0; x < width + TILE; x += TILE) {
					let next = '';
					let nextDark = 0;
					let nextLevel = 0;
					if (x < width) {
						const at = ((x / width + y / height) / 2) * (1 - span);
						const u = Math.min(1, Math.max(0, (progress - at) / span));
						nextLevel = Math.round(u * COVER);
						nextDark = nextLevel - (u >= 1 ? 0 : Math.min(EDGE, nextLevel));
						next = `${nextDark}:${nextLevel}`;
					}
					if (next !== key) {
						if (key) {
							run(context, from, y, x - from, 0, dark);
							run(edgeContext, from, y, x - from, dark, level);
						}
						from = x;
						key = next;
						dark = nextDark;
						level = nextLevel;
					}
				}
			}
			context.globalCompositeOperation = 'source-in';
			context.fillStyle = SCREEN;
			context.fillRect(0, 0, width, height);
			context.globalCompositeOperation = 'source-over';

			edgeContext.globalCompositeOperation = 'source-in';
			/* Along the front, from the bottom left to the top right. */
			const gradient = edgeContext.createLinearGradient(0, height, width, 0);
			PALETTE.forEach((colour, i) => gradient.addColorStop(i / (PALETTE.length - 1), colour));
			edgeContext.fillStyle = gradient;
			edgeContext.fillRect(0, 0, width, height);
			edgeContext.globalCompositeOperation = 'source-over';
			context.drawImage(edge, 0, 0, width, height);
		};

		fit();
		let done = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (done) draw(1);

		const onResize = () => {
			fit();
			if (done) draw(1);
		};
		window.addEventListener('resize', onResize);

		let frame = 0;
		if (!done) {
			const start = performance.now();
			const tick = (now: number) => {
				const k = Math.min(1, (now - start) / SWEEP);
				/* Eased at both ends, so the front gathers and settles rather
				   than lurching off the corner; with a wide front, the levels
				   step through gently enough to read as a fade. */
				draw((1 - Math.cos(Math.PI * k)) / 2);
				if (k < 1) frame = requestAnimationFrame(tick);
				else done = true;
			};
			frame = requestAnimationFrame(tick);
		}

		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('resize', onResize);
		};
	}

	const seenKey = () => `phantom:hyper-chroma-intro:${number}`;

	function close() {
		if (!dialog || closing) return;
		try {
			localStorage.setItem(seenKey(), '1');
		} catch {
			/* A private window: it comes back next time, which is fine. */
		}
		closing = true;
		const finish = () => {
			if (!closing) return;
			closing = false;
			dialog?.close();
		};
		/* Only the dialog's own fade: the button inside has a transition too,
		   and its end bubbles up here. */
		const onEnd = (event: TransitionEvent) => {
			if (event.target !== dialog) return;
			dialog?.removeEventListener('transitionend', onEnd);
			finish();
		};
		dialog.addEventListener('transitionend', onEnd);
		setTimeout(finish, 300);
	}

	/* The dialog is the whole screen and everything on it but the card lets
	   clicks through, so a click that lands on the dialog itself is a click
	   outside the card. */
	function onClick(event: MouseEvent) {
		if (event.target === dialog) close();
	}

	function onCancel(event: Event) {
		event.preventDefault();
		close();
	}
</script>

<dialog
	class="hc-intro"
	class:is-closing={closing}
	bind:this={dialog}
	aria-labelledby="hc-intro-title"
	onclick={onClick}
	oncancel={onCancel}
>
	<canvas class="hc-intro-screen" bind:this={canvas} aria-hidden="true"></canvas>
	<div class="hc-intro-stage">
		<div class="hc-intro-card">
			<header class="hc-intro-head">
				<h2 class="hc-intro-title" id="hc-intro-title" tabindex="-1" bind:this={title}>
					your project is <HyperChroma title="" />
				</h2>
			</header>
			<div class="hc-intro-body">
				<p>
					a reviewer really loved <strong>{name}</strong>, and marked it <em>hyper-chroma</em>:
					exceptionally good, one of the best things shipped to phantom.
				</p>
				<p>
					the latest hyper-chroma projects are featured at the top of explore, and you'll receive
					some bonuses for it soon, too.
				</p>
				<div class="hc-intro-actions">
					<button type="button" class="control-btn" onclick={close}>nice!</button>
				</div>
			</div>
		</div>
	</div>
</dialog>

<style>
	/* Prefixed: src/styles has generic global classes that would otherwise
	   reach in here. */

	/* The whole screen, transparent: the canvas is the backdrop, so the
	   browser's own is turned off. */
	.hc-intro {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		overflow: hidden;
		color: var(--ink);
		background: transparent;
		font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
		transition: opacity 240ms ease;
	}

	.hc-intro::backdrop {
		background: transparent;
	}

	.hc-intro.is-closing {
		opacity: 0;
	}

	.hc-intro-screen {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.hc-intro-stage {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 16px;
		overflow: auto;
		pointer-events: none;
	}

	/* The card: a panel's fill and weave inside an edge of the pill's colours,
	   drifting - the pill's own trick (HyperChroma.svelte) at the size of a
	   card. The fill is a one-colour gradient because only an image layer can
	   be clipped to the padding box while another reaches the border.

	   It arrives as the sweep settles, the way the site's cards arrive
	   (cards.css) - rising a few pixels and fading up on --ease-out - with a
	   faint red and blue split that closes as it lands. */
	.hc-intro-card {
		width: min(460px, 100%);
		pointer-events: auto;
		border: 1px solid transparent;
		border-radius: var(--control-radius);
		overflow: hidden;
		background-image:
			var(--weave-grid-wide), var(--shade-inset),
			linear-gradient(var(--level-panel), var(--level-panel)),
			linear-gradient(90deg, #c2414c, #c9a227, #3f9d57, #3f86b8, #9a5bc4, #c2414c);
		background-size:
			auto,
			auto,
			auto,
			200% 100%;
		background-clip: padding-box, padding-box, padding-box, border-box;
		background-origin: padding-box, padding-box, padding-box, border-box;
		box-shadow: 0 24px 64px -16px rgba(0, 0, 0, 0.7);
		animation:
			hc-intro-arrive 640ms var(--ease-out) 700ms backwards,
			hc-intro-drift 6s linear infinite;
	}

	@keyframes hc-intro-arrive {
		from {
			opacity: 0;
			transform: translateY(12px) scale(0.98);
			filter: drop-shadow(-5px 0 rgba(194, 65, 76, 0.6)) drop-shadow(5px 0 rgba(63, 134, 184, 0.6));
		}
		to {
			filter: drop-shadow(0 0 rgba(194, 65, 76, 0)) drop-shadow(0 0 rgba(63, 134, 184, 0));
		}
	}

	@keyframes hc-intro-drift {
		from {
			background-position:
				0 0,
				0 0,
				0 0,
				0 0;
		}
		to {
			background-position:
				0 0,
				0 0,
				0 0,
				200% 0;
		}
	}

	/* The title on its own material: the featured panel's on explore - the
	   darker ground under a Bayer static rather than the panel's grid
	   (explore/+page.svelte, .xp-hc) - which is where hyper-chroma projects
	   already live, against the reading surface the body is on. The static is
	   on a layer of its own so it can be softened without the fill. */
	.hc-intro-head {
		position: relative;
		isolation: isolate;
		padding: 20px 22px;
		background-color: #121215;
		background-image: var(--shade-inset);
		border-bottom: 1px solid var(--panel-line);
	}

	.hc-intro-head::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		background-image: var(--weave-bayer);
		opacity: 0.75;
		pointer-events: none;
	}

	.hc-intro-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 20px 22px 22px;
	}

	/* The pill on the title's line, wrapping under it on a narrow screen. */
	.hc-intro-title {
		outline: none;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		margin: 0;
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-weight: 400;
		font-size: 30px;
		line-height: 1.1;
		color: var(--fg);
	}

	/* A step up from its usual small text, so it holds its own beside a 30px
	   serif. */

	.hc-intro-title :global(.hc-pill) {
		padding: 7px 14px;
		font-size: var(--text-sm);
	}

	.hc-intro-body p {
		margin: 0;
		font-size: var(--text-md);
		line-height: 1.6;
		color: #cfcac2;
	}

	.hc-intro-body strong {
		color: var(--ink);
	}

	.hc-intro-actions {
		display: flex;
		justify-content: flex-end;
		padding-top: 4px;
	}

	@media (prefers-reduced-motion: reduce) {
		.hc-intro-card {
			animation: none;
		}
	}
</style>
