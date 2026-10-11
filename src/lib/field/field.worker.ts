/**
 * The ground, computed off the main thread.
 *
 * Everything in the field is a function of the viewport alone: the grain
 * lattice, the dither thresholds, the rim of the hole. So it is
 * computed once per resize, here, and handed back as a few finished frames of
 * pixels - the same picture with the grain and the block figure re-rolled, so
 * the page can swap between them on a slow clock and the ground keeps its
 * weather without a render loop. Nothing here runs per frame.
 */
import { clamp01, fbm, ign, ihash, smoothstep } from './noise';

export type FieldRequest = {
	W: number;
	H: number;
	cell: number;
	variants: number;
	/** A different weather: shifts the noise the ground and the rim are
	 *  sampled from. The page's own field is seed 0; a card's thumbnail is
	 *  seeded by its name, so every empty card is its own picture. */
	seed?: number;
	/** How far into the scene the frame sits. The page uses ZOOM, which puts
	 *  the rim of the hole at the edges of the viewport; a thumbnail pulls
	 *  back so the whole hole and its ring fit inside the card. */
	zoom?: number;
	/** Light on the rim and the ring. 1 on the page; a thumbnail is small and
	 *  sits inside a lit card, so it takes more to read. */
	gain?: number;
};

export type FieldResponse = {
	FW: number;
	FH: number;
	frames: ArrayBuffer[];
	ringFrames: ArrayBuffer[];
};

const LEVELS = 7;
const EH = 0.13;
const ZOOM = 4.8;
const FRAME_ASPECT = 16 / 10;
const RING_PULL = 0.22;
const JET_MOUTH = 0.95;
const JET_THREAD = 0.1;
const JET_DECAY = 3.2;
const JET_R0 = 1.25;
/* The rim is smooth at this scale and costs a dozen fbm evaluations a sample. */
const OUTER_PX = 4;
/* How hard the isolated ring reads on its own layer. In the field it was one
   term among several; lifted out on its own it needs some gain to read, but too
   much slams every stop to full light and loses the grey falloff at its edge. */
const RING_GAIN = 1.3;

/* Pass C's ramp: shadow to mid to light, eight stops, packed for ImageData. */
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

/* The ring's own ramp: the ground's own shadow→mid→light tones, so the arc
   greys off toward its edge exactly as it did in the field, with alpha climbing
   by level so the faint outer stops fade into the page rather than sitting on it
   opaquely. RING_RAMP[0] is fully transparent. */
const RING_RAMP = new Uint32Array(LEVELS + 1);
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
		const a = Math.round(q * 450);
		RING_RAMP[k] = LITTLE_ENDIAN
			? (a << 24) | (c[2] << 16) | (c[1] << 8) | c[0]
			: (c[0] << 24) | (c[1] << 16) | (c[2] << 8) | a;
	}
}

/* The block motifs at the smallest block size, three cells: three rulings, a
   hollow disc, a filled dot, a two-by-two of dots and a ring. */
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

function jetHalfWidth(axl: number) {
	const d = Math.max(0, axl - JET_R0 * EH);
	return JET_THREAD * EH + (JET_MOUTH - JET_THREAD) * EH * Math.exp(-d / (JET_DECAY * EH));
}

/* The outer scene at the final zoom - the rim, the gas, the halo - and the
   aperture that lets it through. One sample per OUTER_PX square. */
function buildOuter(W: number, H: number, frameScale: number, ts: number, zoom: number) {
	const OW = Math.ceil(W / OUTER_PX);
	const OH = Math.ceil(H / OUTER_PX);
	const L = new Float32Array(OW * OH);
	const apert = new Float32Array(OW * OH);
	const R = new Float32Array(OW * OH);
	const cx = W / 2;
	const cy = H / 2;
	for (let oy = 0; oy < OH; oy++) {
		for (let ox = 0; ox < OW; ox++) {
			const i = oy * OW + ox;
			const fx = (ox + 0.5) * OUTER_PX;
			const fy = (oy + 0.5) * OUTER_PX;
			let ux = (fx - cx) / (H * zoom) / frameScale;
			const uy = (cy - fy) / (H * zoom);
			const r0 = Math.hypot(ux, uy);
			ux /= 1 + 0.3 * Math.exp((-r0 * r0) / (0.55 * 0.55));
			const r = Math.hypot(ux, uy);
			const cdx = ux / (r + 1e-4);
			const cdy = uy / (r + 1e-4);
			const churn = fbm(cdx * 2.6 + Math.sin(ts * 0.23) * 1.6, cdy * 2.6 + ts * 0.42) - 0.5;
			const rs = r * (1 + 0.035 * churn);
			const ap = smoothstep(EH * 0.92, EH * 1.04, rs);
			apert[i] = ap;
			if (ap <= 0) continue;

			const ang = Math.atan2(uy, ux);
			const churn2 = fbm(cdx * 5.3 - ts * 0.37, cdy * 5.3 + r * 3.2 + ts * 0.24) - 0.5;
			const churn3 = fbm(cdx * 9.1 + ts * 0.6, cdy * 9.1 + r * 6.0 - ts * 0.45) - 0.5;
			const rw = r * (1 + 0.34 * churn + 0.17 * churn2);

			const lens = 0.024 / (r * r + 0.006);
			let lx = ux - cdx * lens;
			const ly = uy - cdy * lens;
			const stretch = 0.35 * Math.exp(-(lx * lx + ly * ly) / (0.46 * 0.46));
			lx /= 1 + stretch;
			let lr = Math.hypot(lx, ly);
			const ldx = lx / (lr + 1e-4);
			const ldy = ly / (lr + 1e-4);
			lr *= 1 + 0.3 * churn + 0.17 * churn2 + 0.09 * churn3;

			const rot = (ts * (0.45 / (lr + 0.12))) / 1.8;
			const cr = Math.cos(rot);
			const sr = Math.sin(rot);
			const rdx = cr * ldx - sr * ldy;
			const rdy = sr * ldx + cr * ldy;
			const qx = rdx * 1.8 + lr * 3.5 - ts * 0.05;
			const qy = rdy * 1.8;
			const warp = fbm(qx, qy + ts * 0.1);
			const turb = fbm(qx * 2 + warp * 1.5, qy * 2 + warp * 1.5);

			const gust = fbm(cdx * 1.7 + ts * 0.19, cdy * 1.7 + lr * 2.2 - ts * 0.55);
			const bgx = Math.floor((lx * H) / 9);
			const bgy = Math.floor((ly * H) / 9);
			const bdith = ihash(bgx, bgy) >= 0.58 ? 1 : 0;
			const g =
				0.013 +
				0.017 * bdith +
				(0.07 * turb * smoothstep(1.4, 0.2, lr) + 0.032 * gust * smoothstep(1.25, 0.15, lr)) *
					(0.5 + 0.8 * bdith);

			const axial = Math.abs(lx);
			const writhe =
				(fbm(lx * 2.9 + ts * 1.1, ts * 0.55) - 0.5) * 0.11 * smoothstep(0.1, 0.85, axial);
			const yy = ly - writhe;
			const th = jetHalfWidth(axial);
			const band = Math.exp(-(yy * yy) / (th * th));
			const radial = smoothstep(EH * 1.05, EH * 1.5, lr) * (1 - smoothstep(0.5, 1.25, lr));
			const kn = fbm(ldx * 1.4 + lr * 11 - ts * 1.5, ldy * 1.4 + ts * 0.3);
			const shock = 0.1 + 2.6 * kn * kn * kn;
			const flick = 0.84 + 0.3 * fbm(lr * 4.2 - ts * 0.9, ts * 0.4);
			const tear = smoothstep(0.2, 0.62, fbm(ldx * 2.8 + lr * 6.6 - ts * 2.6, ldy * 2.8));
			let disk = band * radial * (0.22 + 1.15 * turb) * shock * flick * (0.1 + 1.05 * tear);
			disk *= 1 + 2 * Math.exp(-Math.pow((lr - EH * 1.35) / 0.06, 2));
			disk *= 0.3 + 1.15 * smoothstep(-1, 1, -Math.cos(ang));

			const rux = ux / (1 + RING_PULL);
			const rq = Math.hypot(rux, uy) * (1 + 0.09 * churn + 0.05 * churn2);
			const axialness = Math.abs(ux) / (r + 1e-4);
			const rthick = 0.009 * (1 + 0.9 * axialness);
			const rturb = fbm(cdx * 4.4 + ts * 0.85, cdy * 4.4 + r * 9 - ts * 0.6);
			let ring =
				Math.exp(-Math.pow((rq - EH * 1.13) / rthick, 2)) *
				(0.45 + 0.6 * rturb) *
				(0.55 + 0.5 * axialness);
			ring +=
				Math.exp(-Math.pow(uy / (0.55 * jetHalfWidth(Math.abs(ux))), 2)) *
				smoothstep(EH * 1.1, EH * 1.7, rq) *
				(1 - smoothstep(0.22, 0.55, rq)) *
				axialness *
				axialness *
				(0.2 + 0.7 * rturb) *
				0.22;
			const halo =
				Math.exp(-Math.pow((rw - EH * 1.5) / 0.14, 2)) *
				smoothstep(0, 0.5, Math.abs(Math.sin(ang))) *
				(0.3 + 0.9 * turb) *
				0.5;

			/* The gas fell away as the hole took the view; the rim is what stays.
			   The ring is held out of the ground here and returned on its own, so it
			   can be drawn as a layer above the page rather than under it. */
			let v = (g + disk * 0.8 * 0.05 + halo) * (1 - 0.42);
			const grain = fbm(rdx * 8.5 + lr * 19 - ts * 1.4, rdy * 8.5 + ts * 0.6) - 0.5;
			v += grain * 0.135 * smoothstep(1.7, 0.1, lr);
			L[i] = v;
			R[i] = ring * 1.15 * (1 - 0.42);
		}
	}
	return { OW, L, apert, R };
}

function build({
	W,
	H,
	cell,
	variants,
	seed = 0,
	zoom = ZOOM,
	gain = 1
}: FieldRequest): FieldResponse {
	const FW = Math.ceil(W / cell);
	const FH = Math.ceil(H / cell);
	const N = FW * FH;
	const frameScale = Math.max(W, 1) / Math.max(H, 1) / FRAME_ASPECT;

	const thresh = new Float32Array(N);
	const bcellX = new Int32Array(N);
	const bcellY = new Int32Array(N);
	const bden = new Float32Array(N);

	/* The slow fields - the lattice's fold, its pitch, the pooling - are
	   smooth over hundreds of pixels, so they are sampled every fourth cell
	   and interpolated. */
	const S = 4;
	const GW = Math.ceil(FW / S) + 1;
	const GH = Math.ceil(FH / S) + 1;
	const gBang = new Float32Array(GW * GH);
	const gPitch = new Float32Array(GW * GH);
	const gPool = new Float32Array(GW * GH);
	for (let gy = 0; gy < GH; gy++) {
		for (let gx = 0; gx < GW; gx++) {
			const fx = gx * S * cell;
			const fy = gy * S * cell;
			const j = gy * GW + gx;
			gBang[j] = 0.4 + 2.0 * fbm(fx / 540 + seed, fy / 540);
			gPitch[j] = fbm(fx / 330 + 17.3 + seed, fy / 330 + 17.3);
			gPool[j] = fbm(fx / 230 + seed, fy / 230);
		}
	}
	const lerp2 = (g: Float32Array, x: number, y: number) => {
		const gx = x / S;
		const gy = y / S;
		const ix = Math.floor(gx);
		const iy = Math.floor(gy);
		const fx = gx - ix;
		const fy = gy - iy;
		const j = iy * GW + ix;
		return (
			(g[j] * (1 - fx) + g[j + 1] * fx) * (1 - fy) +
			(g[j + GW] * (1 - fx) + g[j + GW + 1] * fx) * fy
		);
	};

	for (let y = 0; y < FH; y++) {
		for (let x = 0; x < FW; x++) {
			const i = y * FW + x;
			const fx = (x + 0.5) * cell;
			const fy = (y + 0.5) * cell;

			/* Each coarse region turns or flips the threshold's weave so it never
			   runs far enough in one direction to be followed. */
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
			thresh[i] = ign(
				c2x + Math.floor(ihash(rgx + 3.7 + seed, rgy + 3.7) * 97),
				c2y + Math.floor(ihash(rgx + 9.1 + seed, rgy + 9.1) * 97)
			);

			/* The grain lattice, turned by an angle that varies across the frame
			   so the cells fold into swept combs rather than a grid. */
			const bang = lerp2(gBang, x, y);
			const bdx = Math.cos(bang);
			const bdy = Math.sin(bang);
			const pitch = 6 + 7 * (lerp2(gPitch, x, y) >= 0.5 ? 1 : 0);
			bcellX[i] = Math.floor((fx * bdx + fy * bdy) / pitch);
			bcellY[i] = Math.floor((fx * -bdy + fy * bdx) / pitch);
			bden[i] = 0.8 + (0.3 - 0.8) * smoothstep(0.34, 0.66, lerp2(gPool, x, y));
		}
	}

	const { OW, L: outer, apert, R: ringOuter } = buildOuter(W, H, frameScale, seed, zoom);

	const BW = Math.ceil(FW / 8);
	const MW = Math.ceil(FW / 3);
	const MH = Math.ceil(FH / 3);
	const blockK = new Float32Array(BW * Math.ceil(FH / 8));
	const motif = new Uint8Array(MW * MH);

	const frames: ArrayBuffer[] = [];
	for (let k = 0; k < variants; k++) {
		/* The instability under everything: per 16px block, quantised to a few
		   hard tiers, and which motif each 6px cell holds. Both re-rolled per
		   variant, so swapping variants is the weather moving. */
		const btick = k * 2.7 + seed;
		for (let j = 0; j < blockK.length; j++) {
			const bx = j % BW;
			const by = Math.floor(j / BW);
			const n = (ihash(bx + btick, by + btick) - 0.5) * 0.62;
			const f = Math.floor(clamp01(n) * 4) / 4;
			blockK[j] = (0.6 + 7.5 * Math.pow(f, 1.15)) * 0.6;
		}
		for (let j = 0; j < motif.length; j++) {
			const mx = j % MW;
			const my = Math.floor(j / MW);
			const slot = Math.floor(k * 1.3 + ihash(mx, my) * 4);
			motif[j] = motifOf(ihash(mx + slot * 17.3, my + slot * 17.3));
		}
		const s = k * 3.1 + seed;

		const buf = new ArrayBuffer(N * 4);
		const px = new Uint32Array(buf);
		for (let y = 0; y < FH; y++) {
			const row = y * FW;
			const ky = y % 3;
			const my = Math.floor(y / 3) * MW;
			const by = (y >> 3) * BW;
			const oy = (y >> 1) * OW;
			for (let x = 0; x < FW; x++) {
				const i = row + x;
				/* The grain: which cells of the lattice are lit, re-rolled per
				   variant; the lattice itself does not move. */
				const content = 0.03 + (ihash(bcellX[i] + s, bcellY[i] + s) >= bden[i] ? 0.028 : 0);
				const pat = MASK3[(motif[my + Math.floor(x / 3)] * 3 + ky) * 3 + (x % 3)];
				let v = content + content * blockK[by + (x >> 3)] * (0.35 + 0.75 * pat);
				if (v > 0.72) v = 0.72 + (v - 0.72) / (1 + (v - 0.72) * 2.4);
				const oi = oy + (x >> 1);
				const ap = apert[oi];
				if (ap > 0) v += (outer[oi] * gain - v) * ap;
				/* Quantise: seven levels against this cell's own threshold. */
				const t = (v < 0 ? 0 : v) * LEVELS;
				const fl = Math.floor(t);
				let q = fl + (thresh[i] < t - fl ? 1 : 0);
				if (q > LEVELS) q = LEVELS;
				px[i] = RAMP[q];
			}
		}
		frames.push(buf);
	}
	/* The ring, on its own transparent layer above the page: the outer scene's
	   ring alone, dithered and clear where it is dark. One static frame. */
	const rbuf = new ArrayBuffer(N * 4);
	const rpx = new Uint32Array(rbuf);
	for (let y = 0; y < FH; y++) {
		const oy = (y >> 1) * OW;
		for (let x = 0; x < FW; x++) {
			const i = y * FW + x;
			const oi = oy + (x >> 1);
			const rv = ringOuter[oi] * apert[oi] * RING_GAIN * gain;
			if (rv > 0) {
				const rt = rv * LEVELS;
				const rfl = Math.floor(rt);
				let rq = rfl + (thresh[i] < rt - rfl ? 1 : 0);
				if (rq > LEVELS) rq = LEVELS;
				rpx[i] = RING_RAMP[rq];
			}
		}
	}
	return { FW, FH, frames, ringFrames: [rbuf] };
}

self.onmessage = (e: MessageEvent<FieldRequest & { key?: string }>) => {
	const out = build(e.data);
	(self as unknown as Worker).postMessage({ ...out, key: e.data.key }, [
		...out.frames,
		...out.ringFrames
	]);
};
