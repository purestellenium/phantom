<script lang="ts">
	/**
	 * dither-kit's DitherAvatar, for Svelte: a mirrored 8x8 pixel glyph derived
	 * from a name, rendered with the kit's ordered-dither texture. Same name,
	 * same avatar. Grey by default here, since the platform's ramp is grey;
	 * pass a hue or a palette colour for the kit's own colour behaviour.
	 * The wrapper takes whatever class the caller gives it, so the existing
	 * size and shape rules apply.
	 *
	 * Two departures from the kit. It draws at the size it is shown, with the
	 * field's own two-pixel weave, instead of a 32px canvas scaled up until each
	 * dither dot is a slab. And the cells the glyph leaves empty carry a faint
	 * weave of their own rather than the bare ground, so the disc reads as one
	 * texture instead of grey islands in black.
	 */
	import { rgb } from '$lib/dither-kit/palette';
	import { BAYER4, fillOf, fnv1a, type PixelColor, xorshift32 } from '$lib/dither-kit/pixel';

	const GRID = 8;
	/** One dither dot per two CSS pixels, the field's own cell. */
	const DOT = 2;
	const EMPTY_DENSITY = 0.28;

	let {
		name,
		color = 'grey',
		mirror = 'auto',
		class: className = ''
	}: {
		name: string;
		color?: PixelColor;
		mirror?: 'auto' | 'horizontal' | 'vertical';
		class?: string;
	} = $props();

	let wrap: HTMLSpanElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();

	function paint() {
		if (!canvas || !wrap) return;
		const rand = xorshift32(fnv1a(name));
		const bits = Array.from({ length: 32 }, () => rand() < 0.5);
		const drawnVertical = rand() < 0.5;
		rand(); // the kit's drawn hue, consumed so the stream matches
		const halfDensity = Array.from({ length: 32 }, () => 0.55 + rand() * 0.45);
		const vertical = mirror === 'auto' ? drawnVertical : mirror === 'vertical';
		const fill = fillOf(color);

		const size = Math.max(GRID * DOT, Math.round(wrap.clientWidth || GRID * DOT * 2));
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const cell = size / GRID;

		for (let r = 0; r < GRID; r++) {
			for (let c = 0; c < GRID; c++) {
				const i = vertical
					? Math.min(r, GRID - 1 - r) * GRID + c
					: r * (GRID / 2) + Math.min(c, GRID - 1 - c);
				const on = bits[i];
				const density = on ? halfDensity[i] : EMPTY_DENSITY;
				const base = on ? 0.35 + 0.65 * halfDensity[i] : 0.5;
				const dim = on ? base * 0.35 : 0.28;
				const x0 = Math.round(c * cell);
				const y0 = Math.round(r * cell);
				const x1 = Math.round((c + 1) * cell);
				const y1 = Math.round((r + 1) * cell);
				for (let y = y0; y < y1; y += DOT) {
					for (let x = x0; x < x1; x += DOT) {
						const lit = density > BAYER4[(y / DOT) & 3][(x / DOT) & 3];
						ctx.fillStyle = rgb(fill, lit ? base : dim);
						ctx.fillRect(x, y, Math.min(DOT, x1 - x), Math.min(DOT, y1 - y));
					}
				}
			}
		}
	}

	$effect(() => {
		void name;
		void color;
		void mirror;
		paint();
	});
</script>

<span bind:this={wrap} class={['dk-avatar', className]} role="img" aria-label="{name} avatar">
	<canvas bind:this={canvas}></canvas>
</span>

<style>
	.dk-avatar {
		display: block;
		overflow: hidden;
		background-color: var(--bg);
	}

	.dk-avatar canvas {
		display: block;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}
</style>
