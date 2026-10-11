<script lang="ts">
	/**
	 * The loading cover, and the dither-out.
	 *
	 * The cover is a plain coal screen with `loading...` on it, shown from the
	 * very first paint by #loader in the served HTML (app.html, base.css).
	 * Nothing moves while it loads.
	 *
	 * When the page is ready this canvas draws that same flat cover, drops the
	 * static one beneath it (a seamless swap - identical pixels), and dithers it
	 * away: the cover freezes and a soft front sweeps each cell's fixed
	 * clear-order, fading it out over a band, so the coal breaks into dithered
	 * chunks and clears into the page. Quick - about 0.7s - and once.
	 *
	 * Two signals gate it: `load`, the browser's own "document is done", and
	 * `fieldReady`, the field worker's first painted frame, so the ground behind
	 * the cover is real before it comes off. A floor under both so a stuck field
	 * can never keep the cover up.
	 */
	import { onMount } from 'svelte';

	import { fieldReady } from '$lib/field/ready.svelte';

	const SAFETY_MS = 4000;
	/* The dissolve's clear-order granularity, in CSS px: the size of the chunks
	   the cover breaks into as it wipes. */
	const CELL = 5;
	/* How fast the cover dissipates once ready. Short - a loading screen that
	   lingers on its way out is the thing it exists to avoid. */
	const FIZZLE_MS = 700;
	/* The width of the wipe's soft edge, in clear-order units: a cell fades
	   over this window as the front passes rather than snapping off. */
	const FIZZLE_BAND = 0.16;

	let canvas: HTMLCanvasElement | undefined = $state();

	let pageLoaded = $state(false);
	let forced = $state(false);
	let done = $state(false);
	let fizzling = $state(false);

	/* Read by the loop only, never in a reactive position. */
	let fizzleStart = 0;
	let startDissolve: (() => void) | null = null;

	onMount(() => {
		/* `is-loading` is already on <html> and #loader is already covering the
		   page, both from the served markup. This canvas only takes over to
		   dissolve, so nothing is drawn here until the page is ready. */
		const ctx = canvas?.getContext('2d');
		if (!canvas || !ctx) return;

		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

		/* The coal fill #loader uses, so the canvas draws the identical cover
		   before dithering it away - kept in step with base.css.

		   It is --bg, the ground the whole app sits on, rather than a lighter grey
		   of its own: a cover a few steps above the page it covers reads as a
		   panel somebody left over the screen, and on a seven-level ramp those few
		   steps are most of the distance between the ground and a surface. At the
		   ground it is the page with the lights off, and the dissolve hands over
		   to the field on the same fill it was already painting. */
		const COAL = '#0a0a0c';

		let W = 0;
		let H = 0;
		let img: ImageData | null = null;
		let buf: Uint32Array | null = null;
		let frozen: Uint32Array | null = null;
		let pxOrder: Float32Array | null = null;

		/* System monospace, matching #loader-word - no webfont, so nothing to
		   swap. The size mirrors the CSS `clamp(28px, 11vw, 104px)`. */
		const wordFont = () =>
			`800 ${Math.max(28, Math.min(window.innerWidth * 0.11, 104))}px ui-monospace, monospace`;

		/* Draw the cover the canvas will dither away: the flat coal fill and the
		   word - matched to #loader so the swap from the static cover is
		   invisible. Then freeze it and lay out the per-pixel clear-order. */
		const drawCover = () => {
			W = window.innerWidth;
			H = window.innerHeight;
			canvas!.width = W;
			canvas!.height = H;

			ctx.fillStyle = COAL;
			ctx.fillRect(0, 0, W, H);

			/* Put the word exactly where the static #loader-word sits, or it nudges
			   as the canvas takes over. Centring by the em-box middle does not
			   match CSS - CSS lands the alphabetic baseline inside the line box -
			   so compute that baseline from the box (still in the DOM here) and the
			   font's own ascent/descent, and draw to it. */
			ctx.fillStyle = '#d7d7de';
			ctx.font = wordFont();
			ctx.textAlign = 'center';
			ctx.textBaseline = 'alphabetic';
			const wordEl = document.getElementById('loader-word');
			const r = wordEl?.getBoundingClientRect();
			const m = ctx.measureText('loading...');
			if (r) {
				const cx = r.left + r.width / 2;
				const baseline =
					r.top + (r.height + m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
				ctx.fillText('loading...', cx, baseline);
			} else {
				ctx.textBaseline = 'middle';
				ctx.fillText('loading...', W / 2, H / 2);
			}

			img = ctx.getImageData(0, 0, W, H);
			buf = new Uint32Array(img.data.buffer);
			frozen = new Uint32Array(buf);

			const cols = Math.ceil(W / CELL);
			const rows = Math.ceil(H / CELL);
			const cellOrder = new Float32Array(cols * rows);
			for (let i = 0; i < cellOrder.length; i++) cellOrder[i] = Math.random();
			pxOrder = new Float32Array(W * H);
			for (let y = 0; y < H; y++) {
				const cy = ((y / CELL) | 0) * cols;
				const row = y * W;
				for (let x = 0; x < W; x++) pxOrder[row + x] = cellOrder[cy + ((x / CELL) | 0)];
			}
		};

		/* The wipe: colours held, only alpha moves. A front sweeps the clear
		   order from 0 up; each pixel fades across FIZZLE_BAND as the front
		   reaches it. `p` is the eased 0..1 progress; the front runs a band past
		   1 so the last cells finish clear. */
		const dissolve = (p: number) => {
			if (!img || !buf || !frozen || !pxOrder) return;
			const front = p * (1 + FIZZLE_BAND);
			for (let i = 0; i < buf.length; i++) {
				const d = front - pxOrder[i];
				const a =
					d <= 0 ? 0xff : d >= FIZZLE_BAND ? 0 : (((FIZZLE_BAND - d) / FIZZLE_BAND) * 255) | 0;
				buf[i] = (frozen[i] & 0x00ffffff) | (a << 24);
			}
			ctx.putImageData(img, 0, 0);
		};

		let raf = 0;
		let torn = false;

		const teardown = () => {
			if (torn) return;
			torn = true;
			if (raf) cancelAnimationFrame(raf);
			window.removeEventListener('load', finish);
			clearTimeout(safety);
			img = buf = frozen = null as never;
			pxOrder = null as never;
			done = true;
		};

		const frame = () => {
			const t = (performance.now() - fizzleStart) / FIZZLE_MS;
			const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
			/* Smoothstep - eased in and out, so it neither jumps nor drags. */
			dissolve(c * c * (3 - 2 * c));
			if (t >= 1) {
				teardown();
				return;
			}
			raf = requestAnimationFrame(frame);
		};

		/* Called once, when the page is ready. Paints the cover onto the canvas
		   (identical to #loader), removes the static cover, and runs the wipe. */
		startDissolve = () => {
			if (torn) return;
			if (reduceMotion) {
				document.getElementById('loader')?.remove();
				done = true;
				return;
			}
			drawCover();
			document.getElementById('loader')?.remove();
			raf = requestAnimationFrame(frame);
		};

		const finish = () => (pageLoaded = true);
		if (document.readyState === 'complete') finish();
		else window.addEventListener('load', finish, { once: true });
		const safety = setTimeout(() => (forced = true), SAFETY_MS);

		return teardown;
	});

	$effect(() => {
		if (fizzling) return;
		if (!forced && !(pageLoaded && fieldReady.value)) return;
		fizzling = true;
		fizzleStart = performance.now();
		/* The page is real behind the cover now; let it (and the operator doors)
		   in, still hidden under the cover, so the wipe reveals a finished page. */
		document.documentElement.classList.remove('is-loading');
		startDissolve?.();
	});
</script>

{#if !done}
	<canvas bind:this={canvas} class="loader-cover" aria-hidden="true"></canvas>
{/if}

<style>
	/* Above the static #loader (z-index 200) so the canvas swap is seamless.
	   No background: a cleared pixel has to show the page through it, not a fill
	   of our own. Transparent until the dissolve draws, so the static cover
	   shows through in the meantime. */
	.loader-cover {
		position: fixed;
		inset: 0;
		z-index: 201;
		width: 100dvw;
		height: 100dvh;
		display: block;
		pointer-events: none;
	}
</style>
