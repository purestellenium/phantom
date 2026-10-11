/* The noise the field is built from, ported from the shaders one function at
   a time so a cell here lands on the same value the fragment did. */

export const fract = (x: number) => x - Math.floor(x);

const mod512 = (x: number) => x - Math.floor(x / 512) * 512;

export function clamp01(x: number) {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(e0: number, e1: number, x: number) {
	const t = clamp01((x - e0) / (e1 - e0));
	return t * t * (3 - 2 * t);
}

/* mod() keeps the lattice index bounded: without it a drifting input grows
   until fract() runs out of mantissa and neighbouring cells hash alike. */
export function hash(x: number, y: number) {
	x = mod512(x);
	y = mod512(y);
	let px = fract(x * 123.34);
	let py = fract(y * 345.45);
	const d = px * (px + 34.345) + py * (py + 34.345);
	px += d;
	py += d;
	return fract(px * py);
}

export function ihash(x: number, y: number) {
	x = mod512(x);
	y = mod512(y);
	let px = fract(x * 127.31);
	let py = fract(y * 311.7);
	const d = px * (px + 41.23) + py * (py + 41.23);
	px += d;
	py += d;
	return fract(px * py);
}

export function vnoise(x: number, y: number) {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const a = hash(ix, iy);
	const b = hash(ix + 1, iy);
	const c = hash(ix, iy + 1);
	const d = hash(ix + 1, iy + 1);
	const ux = fx * fx * (3 - 2 * fx);
	const uy = fy * fy * (3 - 2 * fy);
	return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

export function fbm(x: number, y: number) {
	let v = 0;
	let a = 0.5;
	for (let i = 0; i < 5; i++) {
		v += a * vnoise(x, y);
		const nx = 1.6 * x - 1.2 * y;
		const ny = 1.2 * x + 1.6 * y;
		x = nx;
		y = ny;
		a *= 0.5;
	}
	return v;
}

/* Interleaved gradient noise: the dither threshold. Built for integer screen
   coordinates, so it is only ever fed cell indices. */
export function ign(x: number, y: number) {
	return fract(52.9829189 * fract(0.06711056 * x + 0.00583715 * y));
}
