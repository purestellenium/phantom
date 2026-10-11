/**
 * The field: the dithered ground every page sits on, and the ring lifted off it.
 *
 * A fixed canvas behind the page, one cell per two CSS pixels, scaled up with
 * image-rendering: pixelated. Its contents are computed once per resize in a
 * worker (see field.worker) as a few variants of the same picture - the grain
 * and the block figure re-rolled - and the only thing that happens afterwards
 * is one drawImage every third of a second to swap between them. There is no
 * render loop: an idle page costs nothing, which is the point of doing this
 * without a shader.
 *
 * The worker returns two layers: the ground, a few variants swapped behind the
 * page, and the ring, one static frame drawn on a transparent canvas above the
 * page and below the vignette.
 *
 * One worker for the life of the page, and the frames it last built are kept by
 * viewport size, so a page that mounts the field again - every navigation
 * between the landing page and the shell - draws at once instead of waiting on a
 * rebuild.
 */
import type { FieldRequest, FieldResponse } from './field.worker';

export const CELL = 2;
const VARIANTS = 3;
/* The grain re-rolls at 3Hz; the variants play in a short shuffle. */
const SWAP_MS = 330;
const ORDER = [0, 1, 2, 1, 0, 2];

type Layers = { base: HTMLCanvasElement[]; ring: HTMLCanvasElement[] };

let worker: Worker | null = null;
const cache = new Map<string, Layers>();
const pending = new Map<string, Array<(layers: Layers) => void>>();

function toCanvases(bufs: ArrayBuffer[], FW: number, FH: number): HTMLCanvasElement[] {
	return bufs.map((buf) => {
		const c = document.createElement('canvas');
		c.width = FW;
		c.height = FH;
		c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(buf), FW, FH), 0, 0);
		return c;
	});
}

/* Builds the ground and the ring for a viewport, once; later callers for the
   same size get the cached frames. */
function ground(
	W: number,
	H: number,
	done: (layers: Layers) => void,
	seed = 0,
	zoom?: number,
	gain?: number
) {
	const key = `${W}x${H}@${seed}/${zoom ?? 'page'}/${gain ?? 1}`;
	const hit = cache.get(key);
	if (hit) {
		done(hit);
		return;
	}
	const waiting = pending.get(key);
	if (waiting) {
		waiting.push(done);
		return;
	}
	pending.set(key, [done]);
	if (!worker) {
		worker = new Worker(new URL('./field.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (e: MessageEvent<FieldResponse & { key: string }>) => {
			const { FW, FH, frames, ringFrames, key: k } = e.data;
			const layers: Layers = {
				base: toCanvases(frames, FW, FH),
				ring: toCanvases(ringFrames, FW, FH)
			};
			cache.set(k, layers);
			const cbs = pending.get(k) ?? [];
			pending.delete(k);
			for (const cb of cbs) cb(layers);
		};
	}
	const msg: FieldRequest & { key: string } = {
		W,
		H,
		cell: CELL,
		variants: VARIANTS,
		seed,
		zoom,
		gain,
		key
	};
	worker.postMessage(msg);
}

export function startField(
	canvas: HTMLCanvasElement,
	ringCanvas?: HTMLCanvasElement,
	/** Called once, the first time a real frame lands - never again after
	 *  that, including on a later resize. The caller's cue to reveal the
	 *  canvas however it likes; see Field.svelte for what does that today. */
	onFirstFrame?: () => void
) {
	const ctx = canvas.getContext('2d', { alpha: false });
	if (!ctx) return () => {};
	/* The ring keeps its alpha: it is clear everywhere the arc is not. */
	const rctx = ringCanvas?.getContext('2d') ?? null;

	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	let base: HTMLCanvasElement[] = [];
	let ring: HTMLCanvasElement[] = [];
	let timer: ReturnType<typeof setInterval> | null = null;
	let step = 0;
	let stopped = false;
	let announced = false;
	/* Bumped on every request, so a response can tell whether it is still the
	   one anyone asked for. See `request` for what this is standing in for. */
	let generation = 0;

	const drawBase = (idx: number) => {
		if (base[idx]) ctx.drawImage(base[idx], 0, 0);
	};
	/* The ring is one static frame - drawn once, never swapped. */
	const drawRing = () => {
		if (!rctx || !ringCanvas || !ring[0]) return;
		rctx.clearRect(0, 0, ringCanvas.width, ringCanvas.height);
		rctx.drawImage(ring[0], 0, 0);
	};

	const blit = () => {
		if (base.length === 0) return;
		step = (step + 1) % ORDER.length;
		drawBase(ORDER[step] % base.length);
	};

	const request = () => {
		const gen = ++generation;
		const W = window.innerWidth;
		const H = window.innerHeight;
		const cw = Math.ceil(W / CELL);
		const ch = Math.ceil(H / CELL);
		/* NOT resized here. Setting `canvas.width`/`.height` clears the bitmap
		   on the spot, and the worker's answer is a round trip away - a resize
		   that reset the canvas up front left the CSS box (100dvw/100dvh, sized
		   independently of the backing store) with nothing to show but its own
		   background-color until that answer arrived, which is the black flash
		   this was built to avoid. Left alone, the canvas keeps stretching its
		   last frame to fill the new box in the meantime - blockier than usual
		   behind `image-rendering: pixelated`, but never empty. The resize and
		   the redraw happen together, in the one place below where a fresh
		   frame is actually ready to replace the old one. */
		ground(W, H, (built) => {
			/* Superseded by a later resize, or the field was torn down while this
			   was in flight. */
			if (stopped || gen !== generation) return;
			canvas.width = cw;
			canvas.height = ch;
			if (ringCanvas) {
				ringCanvas.width = cw;
				ringCanvas.height = ch;
			}
			base = built.base;
			ring = built.ring;
			step = 0;
			drawBase(0);
			drawRing();
			if (timer === null && !reduceMotion) timer = setInterval(blit, SWAP_MS);
			if (!announced) {
				announced = true;
				onFirstFrame?.();
			}
		});
	};
	request();

	/* Resizes come in bursts; the ground is rebuilt once the burst is over. */
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	const onResize = () => {
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			resizeTimer = null;
			request();
		}, 150);
	};
	window.addEventListener('resize', onResize);

	return () => {
		stopped = true;
		window.removeEventListener('resize', onResize);
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		if (timer !== null) clearInterval(timer);
	};
}

/* ── a thumbnail of the field ─────────────────────────────────────────────── */

/* Pulled back from the page's zoom, so the hole and its ring sit whole in the
   middle of the card with the ground around them; lit up, since a thumbnail is
   small and sits inside a lit card. */
const THUMB_ZOOM = 1.7;
const THUMB_GAIN = 2.2;

function hashSeed(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	/* A modest offset into the noise: enough to be a different picture,
	   small enough that fbm's inputs stay in a well-behaved range. */
	return ((h >>> 0) % 1000) / 10;
}

/**
 * The same field, cut to a card: the ground, the hole and its ring, at the
 * size of the canvas it is given, seeded by a name so every card differs.
 * Same slow swap of the grain as the page behind it, and nothing per frame.
 * The ring is composited into the one canvas rather than on its own layer.
 */
export function startThumb(canvas: HTMLCanvasElement, seedText: string): () => void {
	const ctx = canvas.getContext('2d', { alpha: false });
	if (!ctx) return () => {};
	const seed = hashSeed(seedText);
	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	let base: HTMLCanvasElement[] = [];
	let ring: HTMLCanvasElement | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let step = 0;
	let stopped = false;
	let generation = 0;

	const draw = (idx: number) => {
		if (!base[idx]) return;
		ctx.drawImage(base[idx], 0, 0);
		if (ring) ctx.drawImage(ring, 0, 0);
	};
	const blit = () => {
		if (base.length === 0) return;
		step = (step + 1) % ORDER.length;
		draw(ORDER[step] % base.length);
	};

	const request = () => {
		const gen = ++generation;
		const rect = canvas.getBoundingClientRect();
		const W = Math.max(1, Math.round(rect.width));
		const H = Math.max(1, Math.round(rect.height));
		/* Resized only once the replacement frame is ready - see the matching
		   comment in `startField`'s `request` for why. */
		ground(
			W,
			H,
			(built) => {
				if (stopped || gen !== generation) return;
				canvas.width = Math.ceil(W / CELL);
				canvas.height = Math.ceil(H / CELL);
				base = built.base;
				ring = built.ring[0] ?? null;
				step = 0;
				draw(0);
				if (timer === null && !reduceMotion) timer = setInterval(blit, SWAP_MS);
			},
			seed,
			THUMB_ZOOM,
			THUMB_GAIN
		);
	};
	request();

	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	const onResize = () => {
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			resizeTimer = null;
			request();
		}, 150);
	};
	window.addEventListener('resize', onResize);

	return () => {
		stopped = true;
		window.removeEventListener('resize', onResize);
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		if (timer !== null) clearInterval(timer);
	};
}
