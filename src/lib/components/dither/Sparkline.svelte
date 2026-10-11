<script lang="ts">
	/**
	 * dither-kit's Sparkline, for Svelte: one numeric series as an ordered-dither
	 * area, painted through the kit's own paintColumn. Static - one paint per
	 * data or size change, no loop.
	 */
	import {
		type AreaVariant,
		backingSize,
		paintColumn,
		resample
	} from '$lib/dither-kit/dither-paint';
	import { type DitherColor, seedOfColor } from '$lib/dither-kit/palette';

	let {
		data,
		color = 'grey',
		variant = 'gradient'
	}: { data: number[]; color?: DitherColor; variant?: AreaVariant } = $props();

	let wrap: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();

	function paint() {
		if (!wrap || !canvas) return;
		const box = wrap.getBoundingClientRect();
		const { cols, rows } = backingSize(box.width, box.height);
		canvas.width = cols;
		canvas.height = rows;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, cols, rows);
		if (data.length === 0) return;
		const max = Math.max(1, ...data);
		/* Value → backing row of the top edge; the floor is the last row. */
		const top = resample(
			data.map((v) => (1 - v / max) * (rows - 1)),
			cols
		);
		const seed = seedOfColor(color);
		for (let x = 0; x < cols; x++) {
			paintColumn(ctx, x, top[x] ?? rows - 1, rows - 1, seed, {
				variant,
				intensity: 0,
				dim: 1,
				stacked: false
			});
		}
	}

	$effect(() => {
		void data;
		void color;
		void variant;
		paint();
		if (!wrap || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(paint);
		ro.observe(wrap);
		return () => ro.disconnect();
	});
</script>

<div class="dk-spark" bind:this={wrap} aria-hidden="true">
	<canvas bind:this={canvas}></canvas>
</div>

<style>
	.dk-spark {
		position: relative;
		width: 100%;
		height: 100%;
	}

	.dk-spark canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}
</style>
