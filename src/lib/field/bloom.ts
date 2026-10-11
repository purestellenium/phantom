/**
 * The spill around the title: light leaking from the ink into the grain.
 *
 * Drawn once into a small canvas behind the title, not per frame. The title's
 * own text is rasterised in its own font; every cell within reach of ink takes
 * the brightest ink nearby, weighted by how near it is - max() rather than a
 * mean, because a halo asks how far the nearest ink is, not how much ink is
 * about, so the glow wraps the outer strokes as evenly as the inner ones. The
 * result is quantised to the field's seven levels against the same threshold
 * weave the ground uses, one cell per two pixels, so the halo is the grain
 * lighting up rather than a blur laid over it.
 */
import { ign, ihash } from './noise';

const CELL = 2;
const REACH = 7; // cells
const LEVELS = 7;
const GROUND = 0.045;

const RAMP: string[] = [];
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
		RAMP.push(`rgb(${c[0]},${c[1]},${c[2]})`);
	}
}

/* The falloff: full against the ink, gone at the reach, curved so it holds
   close to the strokes and thins out rather than fading in a straight line. */
const WEIGHT = (() => {
	const size = REACH * 2 + 1;
	const w = new Float32Array(size * size);
	for (let j = -REACH; j <= REACH; j++) {
		for (let i = -REACH; i <= REACH; i++) {
			const d = Math.hypot(i, j) / (REACH + 0.5);
			w[(j + REACH) * size + (i + REACH)] = d >= 1 ? 0 : Math.pow(1 - d, 1.7);
		}
	}
	return w;
})();

/** Draw the halo for `title` into `canvas`, and place the canvas behind it.
 *  The canvas must be absolutely positioned inside the title's offset parent. */
export function drawBloom(title: HTMLElement, canvas: HTMLCanvasElement) {
	const range = document.createRange();
	range.selectNodeContents(title);
	const box = range.getBoundingClientRect();
	if (box.width < 1 || box.height < 1) return;
	const cs = getComputedStyle(title);

	/* The ink, at cell resolution, with the reach as a margin all round. */
	const pad = REACH + 1;
	const gw = Math.ceil(box.width / CELL) + pad * 2;
	const gh = Math.ceil(box.height / CELL) + pad * 2;
	const ink = document.createElement('canvas');
	ink.width = gw;
	ink.height = gh;
	const ic = ink.getContext('2d', { willReadFrequently: true });
	if (!ic) return;
	ic.scale(1 / CELL, 1 / CELL);
	/* Assembled rather than read from the `font` shorthand, which Firefox
	   reports as an empty string. */
	ic.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
	ic.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
	ic.fillStyle = '#fff';
	const m = ic.measureText('M');
	const lineBox = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
	ic.fillText(
		title.textContent ?? '',
		pad * CELL,
		pad * CELL + (box.height - lineBox) / 2 + m.fontBoundingBoxAscent
	);
	const px = ic.getImageData(0, 0, gw, gh).data;
	const cov = new Float32Array(gw * gh);
	for (let i = 0; i < cov.length; i++) cov[i] = px[i * 4 + 3] / 255;

	/* Ink luminance from the title's own colour. */
	const rgb = cs.color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
	const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;

	canvas.width = gw;
	canvas.height = gh;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.clearRect(0, 0, gw, gh);
	const size = REACH * 2 + 1;
	/* The threshold weave is the ground's, keyed to where this lands on
	   screen, so the halo's grain lines up with the grain it is lighting. */
	const ox = Math.round((box.left - pad * CELL) / CELL);
	const oy = Math.round((box.top - pad * CELL) / CELL);
	for (let y = 0; y < gh; y++) {
		for (let x = 0; x < gw; x++) {
			let glow = 0;
			for (let j = -REACH; j <= REACH; j++) {
				const ty = y + j;
				if (ty < 0 || ty >= gh) continue;
				for (let i = -REACH; i <= REACH; i++) {
					const tx = x + i;
					if (tx < 0 || tx >= gw) continue;
					const v = cov[ty * gw + tx] * WEIGHT[(j + REACH) * size + (i + REACH)];
					if (v > glow) glow = v;
				}
			}
			if (glow <= 0) continue;
			const sx = ox + x;
			const sy = oy + y;
			const rgx = Math.floor(sx / 37);
			const rgy = Math.floor(sy / 37);
			const rr = ihash(rgx, rgy);
			let c2x = sx;
			let c2y = sy;
			if (rr > 0.75) {
				c2x = sy;
				c2y = sx;
			} else if (rr > 0.5) {
				c2x = -sy;
				c2y = sx;
			} else if (rr > 0.25) {
				c2x = sx;
				c2y = -sy;
			}
			const t = ign(
				c2x + Math.floor(ihash(rgx + 3.7, rgy + 3.7) * 97),
				c2y + Math.floor(ihash(rgx + 9.1, rgy + 9.1) * 97)
			);
			const s = (GROUND + lum * glow * 0.3) * LEVELS;
			const fl = Math.floor(s);
			let q = fl + (t < s - fl ? 1 : 0);
			if (q > LEVELS) q = LEVELS;
			if (q === 0) continue;
			ctx.fillStyle = RAMP[q];
			ctx.fillRect(x, y, 1, 1);
		}
	}

	const parent = canvas.offsetParent?.getBoundingClientRect();
	canvas.style.left = `${box.left - pad * CELL - (parent?.left ?? 0)}px`;
	canvas.style.top = `${box.top - pad * CELL - (parent?.top ?? 0)}px`;
	canvas.style.width = `${gw * CELL}px`;
	canvas.style.height = `${gh * CELL}px`;
}
