/**
 * The bell's dither: the field's quantiser, run over the bell alone.
 *
 * The turn is a video of raw luminance, one pixel per cell. Each decoded frame
 * is read back, given the block figure the ground carries, and quantised to
 * the seven-level ramp against the same threshold weave the field uses - so
 * the bell is cut from the same material as everything around it, live, as
 * the shader once cut it. It runs only when a new video frame arrives, over a
 * few hundred cells wide, and stops with the video.
 */
import { clamp01, ign, ihash } from './noise';

const LEVELS = 7;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const RAMP = new Uint32Array(LEVELS + 1);
{
	const shadow = [0.02, 0.02, 0.028];
	const mid = [0.34, 0.32, 0.33];
	const light = [0.94, 0.92, 0.89];
	for (let k = 0; k <= LEVELS; k++) {
		const q = k / LEVELS;
		const c = [0, 1, 2].map((i) =>
			Math.round(
				255 *
					(q < 0.5
						? shadow[i] + (mid[i] - shadow[i]) * q * 2
						: mid[i] + (light[i] - mid[i]) * (q - 0.5) * 2)
			)
		);
		RAMP[k] = LITTLE_ENDIAN
			? (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]
			: (c[0] << 24) | (c[1] << 16) | (c[2] << 8) | 255;
	}
}

/* The block motifs at the smallest block size, three cells. */
const MOTIFS = 7;
const MASK3 = (() => {
	const cs = 3;
	const m = new Uint8Array(MOTIFS * cs * cs);
	for (let pid = 0; pid < MOTIFS; pid++) {
		for (let ky = 0; ky < cs; ky++) {
			for (let kx = 0; kx < cs; kx++) {
				const x = (kx + 0.5) / cs;
				const y = (ky + 0.5) / cs;
				const dr = Math.hypot(x - 0.5, y - 0.5);
				let pat: boolean;
				switch (pid) {
					case 0:
						pat = ((x + y) * 2) % 1 >= 0.5;
						break;
					case 1:
						pat = (x * 3) % 1 >= 0.5;
						break;
					case 2:
						pat = ((((x - y) * 3) % 1) + 1) % 1 >= 0.5;
						break;
					case 3:
						pat = dr >= 0.34;
						break;
					case 4:
						pat = dr < 0.32;
						break;
					case 5:
						pat = Math.hypot(((x * 2) % 1) - 0.5, ((y * 2) % 1) - 0.5) < 0.24;
						break;
					default:
						pat = dr >= 0.2 && dr < 0.38;
				}
				m[(pid * cs + ky) * cs + kx] = pat ? 1 : 0;
			}
		}
	}
	return m;
})();

function motifOf(pid: number) {
	return pid < 0.16
		? 0
		: pid < 0.3
			? 1
			: pid < 0.44
				? 2
				: pid < 0.62
					? 3
					: pid < 0.78
						? 4
						: pid < 0.9
							? 5
							: 6;
}

/** Drives `canvas` from `video` until the returned function is called. */
export function startBellDither(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
	const W = canvas.width;
	const H = canvas.height;
	const N = W * H;
	const out = canvas.getContext('2d', { alpha: false });
	const src = document.createElement('canvas');
	src.width = W;
	src.height = H;
	const sctx = src.getContext('2d', { alpha: false, willReadFrequently: true });
	if (!out || !sctx) return () => {};

	const image = out.createImageData(W, H);
	const px = new Uint32Array(image.data.buffer);

	/* The threshold weave, with each coarse region turned or flipped so it
	   never runs far enough in one direction to be followed. Static. */
	const thresh = new Float32Array(N);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const rgx = Math.floor(x / 37);
			const rgy = Math.floor(y / 37);
			const rr = ihash(rgx, rgy);
			let c2x = x;
			let c2y = y;
			if (rr > 0.75) {
				c2x = y;
				c2y = x;
			} else if (rr > 0.5) {
				c2x = -y;
				c2y = x;
			} else if (rr > 0.25) {
				c2x = x;
				c2y = -y;
			}
			thresh[y * W + x] = ign(
				c2x + Math.floor(ihash(rgx + 3.7, rgy + 3.7) * 97),
				c2y + Math.floor(ihash(rgx + 9.1, rgy + 9.1) * 97)
			);
		}
	}

	/* The block figure: per 16px block, quantised to a few hard tiers on a
	   3.2Hz clock; per 6px cell, a motif re-rolled on its own clock. */
	const BW = Math.ceil(W / 8);
	const BH = Math.ceil(H / 8);
	const blockK = new Float32Array(BW * BH);
	let blockTick = -1;
	const MW = Math.ceil(W / 3);
	const MH = Math.ceil(H / 3);
	const motif = new Uint8Array(MW * MH);
	const phase = new Float32Array(MW * MH);
	for (let j = 0; j < phase.length; j++) phase[j] = ihash(j % MW, Math.floor(j / MW)) * 4;

	const t0 = performance.now();
	const draw = () => {
		const t = (performance.now() - t0) / 1000;
		const btick = Math.floor(t * 3.2) * 2.7;
		if (btick !== blockTick) {
			blockTick = btick;
			for (let j = 0; j < blockK.length; j++) {
				const n = (ihash((j % BW) + btick, Math.floor(j / BW) + btick) - 0.5) * 0.62;
				const f = Math.floor(clamp01(n) * 4) / 4;
				blockK[j] = (0.6 + 7.5 * Math.pow(f, 1.15)) * 0.6;
			}
		}
		const mclock = t * 4.2;
		for (let j = 0; j < motif.length; j++) {
			const slot = Math.floor(mclock + phase[j]);
			motif[j] = motifOf(ihash((j % MW) + slot * 17.3, Math.floor(j / MW) + slot * 17.3));
		}

		sctx.drawImage(video, 0, 0, W, H);
		const d = sctx.getImageData(0, 0, W, H).data;
		for (let y = 0; y < H; y++) {
			const row = y * W;
			const ky = y % 3;
			const my = Math.floor(y / 3) * MW;
			const by = (y >> 3) * BW;
			for (let x = 0; x < W; x++) {
				const i = row + x;
				const content = d[i * 4] / 255;
				const pat = MASK3[(motif[my + Math.floor(x / 3)] * 3 + ky) * 3 + (x % 3)];
				let v = content + content * blockK[by + (x >> 3)] * (0.35 + 0.75 * pat);
				if (v > 0.72) v = 0.72 + (v - 0.72) / (1 + (v - 0.72) * 2.4);
				const s = v * LEVELS;
				const fl = Math.floor(s);
				let q = fl + (thresh[i] < s - fl ? 1 : 0);
				if (q > LEVELS) q = LEVELS;
				px[i] = RAMP[q];
			}
		}
		out.putImageData(image, 0, 0);
	};

	/* One pass per decoded frame where the browser can say when that is;
	   elsewhere, once a frame while the video plays. */
	let stopped = false;
	let raf = 0;
	let handle = 0;
	const hasVfc = 'requestVideoFrameCallback' in video;
	const onFrame = () => {
		if (stopped) return;
		draw();
		handle = video.requestVideoFrameCallback(onFrame);
	};
	const tick = () => {
		if (stopped) return;
		if (!video.paused && !video.ended) draw();
		raf = requestAnimationFrame(tick);
	};
	const onReady = () => {
		draw();
		if (hasVfc) handle = video.requestVideoFrameCallback(onFrame);
		else raf = requestAnimationFrame(tick);
	};
	if (video.readyState >= 2) onReady();
	else video.addEventListener('loadeddata', onReady, { once: true });

	return () => {
		stopped = true;
		video.removeEventListener('loadeddata', onReady);
		if (hasVfc && handle) video.cancelVideoFrameCallback(handle);
		cancelAnimationFrame(raf);
	};
}
