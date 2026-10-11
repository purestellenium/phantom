<script lang="ts">
	/**
	 * dither-kit's bar chart, for Svelte: one category per band, each bar
	 * filled with the kit's paintColumn ordered dither, labels beneath.
	 * Static: one paint per data or size change.
	 */
	import { type AreaVariant, backingSize, paintColumn } from '$lib/dither-kit/dither-paint';
	import { type DitherColor, seedOfColor } from '$lib/dither-kit/palette';

	let {
		items,
		color = 'grey',
		variant = 'gradient'
	}: {
		items: { label: string; n: number }[];
		color?: DitherColor;
		variant?: AreaVariant;
	} = $props();

	let wrap: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();

	/* The kit's band scale: 0.28 inner and 0.18 outer padding. */
	function slot(i: number, count: number, width: number) {
		const inner = 0.28;
		const outer = 0.18;
		const step = width / (count - inner + 2 * outer);
		const band = step * (1 - inner);
		return { x: step * outer + i * step, width: band };
	}

	function paint() {
		if (!wrap || !canvas) return;
		const box = wrap.getBoundingClientRect();
		const { cols, rows } = backingSize(box.width, box.height);
		canvas.width = cols;
		canvas.height = rows;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, cols, rows);
		if (items.length === 0) return;
		const max = Math.max(1, ...items.map((item) => item.n));
		const seed = seedOfColor(color);
		items.forEach((item, i) => {
			const s = slot(i, items.length, cols);
			const top = (1 - item.n / max) * (rows - 1);
			const c0 = Math.round(s.x);
			const c1 = Math.round(s.x + s.width);
			for (let x = c0; x < c1; x++) {
				paintColumn(ctx, x, top, rows - 1, seed, {
					variant,
					intensity: 0,
					dim: 1,
					stacked: false
				});
			}
		});
	}

	$effect(() => {
		void items;
		void color;
		void variant;
		paint();
		if (!wrap || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(paint);
		ro.observe(wrap);
		return () => ro.disconnect();
	});
</script>

<div class="dk-bars">
	<div class="dk-bars-plot" bind:this={wrap} aria-hidden="true">
		<canvas bind:this={canvas}></canvas>
	</div>
	<div class="dk-bars-labels">
		{#each items as item (item.label)}
			<span><span class="dk-bars-n">{item.n}</span>{item.label}</span>
		{/each}
	</div>
</div>

<style>
	.dk-bars {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}

	.dk-bars-plot {
		position: relative;
		width: 100%;
		height: 56px;
	}

	.dk-bars-plot canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}

	.dk-bars-labels {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 4px;
		padding: 0 6%;
		font-size: 11px;
		line-height: 1.2;
		text-align: center;
		color: var(--ink-dim);
	}

	.dk-bars-labels > span {
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dk-bars-n {
		color: var(--ink);
		font-family: var(--font-geist-mono), ui-monospace, monospace;
	}
</style>
