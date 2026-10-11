<script lang="ts">
	/**
	 * One column per day in the kit's ordered dither, for reading a series
	 * closely rather than glancing at it: hover a day for its figures, click or
	 * arrow to one to pick it, with an optional trend drawn over the columns as
	 * a line. The picked day and the hovered one stay lit, the rest dim.
	 */
	import { backingSize, paintColumn } from '$lib/dither-kit/dither-paint';
	import { type DitherColor, rgb, seedOfColor } from '$lib/dither-kit/palette';

	type Day = { day: string; n: number; hint?: string };

	let {
		days,
		trend = null,
		selected = null,
		color = 'blue',
		label,
		onpick
	}: {
		days: Day[];
		/** One number per day, drawn as a line over the columns. */
		trend?: number[] | null;
		selected?: string | null;
		color?: DitherColor;
		/** What the plot is, for a screen reader. */
		label: string;
		onpick?: (day: string) => void;
	} = $props();

	let wrap: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let hover: number | null = $state(null);

	const picked = $derived(selected === null ? -1 : days.findIndex((d) => d.day === selected));
	const focus = $derived(hover ?? (picked >= 0 ? picked : null));

	/* A round top for the scale, so the gridline reads as a number somebody
	   would say rather than whatever the busiest day happened to be. */
	const top = $derived.by(() => {
		const most = Math.max(1, ...days.map((d) => d.n), ...(trend ?? []));
		if (most <= 5) return most;
		const step = 10 ** Math.floor(Math.log10(most));
		for (const k of [1, 2, 2.5, 5, 10]) if (k * step >= most) return k * step;
		return 10 * step;
	});

	function short(day: string): string {
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
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
		if (days.length === 0) return;

		const seed = seedOfColor(color);
		const step = cols / days.length;
		/* A one-cell gap between columns once they are wide enough to spare it;
		   narrower than that, a gap would be most of the column. */
		const gap = step >= 3 ? 1 : 0;
		const floor = rows - 1;
		const y = (v: number) => (1 - v / top) * floor;

		days.forEach((d, i) => {
			const x0 = Math.round(i * step);
			const x1 = Math.max(x0 + 1, Math.round((i + 1) * step) - gap);
			const lit = focus === null || focus === i;
			for (let x = x0; x < x1; x++) {
				paintColumn(ctx, x, y(d.n), floor, seed, {
					variant: 'gradient',
					intensity: focus === i ? 1 : 0,
					dim: lit ? 1 : 0.4,
					stacked: false
				});
			}
		});

		if (trend && trend.length === days.length) {
			/* Through each column's centre, a cell at every backing column, so the
			   line is made of the same pixels as the fill under it. */
			ctx.fillStyle = rgb(seed.line, 1, 0.95);
			for (let x = 0; x < cols; x++) {
				const t = Math.min(Math.max((x + 0.5) / step - 0.5, 0), trend.length - 1);
				const i = Math.floor(t);
				const a = trend[i] ?? 0;
				const b = trend[Math.min(i + 1, trend.length - 1)] ?? a;
				ctx.fillRect(x, Math.round(y(a + (b - a) * (t - i))), 1, 1);
			}
		}
	}

	$effect(() => {
		void days;
		void trend;
		void color;
		void focus;
		void top;
		paint();
		if (!wrap || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(paint);
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	function indexAt(event: MouseEvent): number | null {
		if (!wrap || days.length === 0) return null;
		const box = wrap.getBoundingClientRect();
		const i = Math.floor(((event.clientX - box.left) / box.width) * days.length);
		return Math.min(Math.max(i, 0), days.length - 1);
	}

	function pick(i: number) {
		const d = days[i];
		if (d) onpick?.(d.day);
	}

	function onkey(event: KeyboardEvent) {
		if (days.length === 0) return;
		const at = picked >= 0 ? picked : days.length - 1;
		const to =
			event.key === 'ArrowLeft'
				? at - 1
				: event.key === 'ArrowRight'
					? at + 1
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? days.length - 1
							: null;
		if (to === null) return;
		event.preventDefault();
		pick(Math.min(Math.max(to, 0), days.length - 1));
	}

	const shown = $derived(focus === null ? null : days[focus]);
	/* Kept inside the plot: pinned to an edge near the ends rather than
	   centred over a column and cut off. */
	const tipAt = $derived(focus === null ? 0 : ((focus + 0.5) / days.length) * 100);
	const tipAlign = $derived(tipAt < 15 ? 'is-start' : tipAt > 85 ? 'is-end' : '');
</script>

<div class="dk-days">
	<div class="dk-days-axis" aria-hidden="true">
		<span>{top}</span>
		<span>{Math.round(top / 2) === top / 2 ? top / 2 : ''}</span>
		<span>0</span>
	</div>

	<div
		class="dk-days-plot"
		bind:this={wrap}
		role="slider"
		tabindex="0"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={Math.max(0, days.length - 1)}
		aria-valuenow={picked >= 0 ? picked : undefined}
		aria-valuetext={picked >= 0
			? `${short(days[picked].day)}: ${days[picked].n}${days[picked].hint ? `, ${days[picked].hint}` : ''}`
			: undefined}
		onpointermove={(event) => (hover = indexAt(event))}
		onpointerleave={() => (hover = null)}
		onclick={(event) => {
			const i = indexAt(event);
			if (i !== null) pick(i);
		}}
		onkeydown={onkey}
	>
		<span class="dk-days-grid is-top"></span>
		<span class="dk-days-grid is-mid"></span>
		<canvas bind:this={canvas}></canvas>
		{#if shown}
			<span class={['dk-days-tip', tipAlign]} style="--at: {tipAt}%">
				<span class="dk-days-tip-day">{short(shown.day)}</span>
				<span class="dk-days-tip-n">{shown.n}</span>
				{#if shown.hint}<span class="dk-days-tip-hint">{shown.hint}</span>{/if}
			</span>
		{/if}
	</div>

	<div class="dk-days-labels" aria-hidden="true">
		{#if days.length > 0}
			<span>{short(days[0].day)}</span>
			{#if days.length > 2}<span>{short(days[Math.floor(days.length / 2)].day)}</span>{/if}
			{#if days.length > 1}<span>{short(days[days.length - 1].day)}</span>{/if}
		{/if}
	</div>
</div>

<style>
	.dk-days {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		grid-template-rows: 1fr auto;
		column-gap: 8px;
		row-gap: 6px;
		width: 100%;
		height: 100%;
	}

	.dk-days-axis {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		font-size: 11px;
		line-height: 1;
		text-align: right;
		color: var(--ink-dim);
	}

	.dk-days-plot {
		position: relative;
		min-height: 0;
		cursor: crosshair;
		outline: none;
		touch-action: pan-y;
	}

	.dk-days-plot:focus-visible {
		box-shadow: 0 0 0 1px var(--panel-line);
	}

	.dk-days-plot canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}

	.dk-days-grid {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px dashed var(--panel-line);
	}

	.dk-days-grid.is-top {
		top: 0;
	}

	.dk-days-grid.is-mid {
		top: 50%;
	}

	.dk-days-tip {
		position: absolute;
		top: 4px;
		left: var(--at);
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 9px;
		pointer-events: none;
		white-space: nowrap;
		font-size: 11px;
		line-height: 1.2;
		color: var(--ink);
		background-color: var(--level-raise);
		border: 1px solid var(--panel-line);
		border-radius: var(--control-radius);
	}

	.dk-days-tip.is-start {
		transform: none;
	}

	.dk-days-tip.is-end {
		transform: translateX(-100%);
	}

	.dk-days-tip-day,
	.dk-days-tip-hint {
		color: var(--ink-dim);
	}

	.dk-days-tip-n {
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		font-size: 17px;
	}

	.dk-days-labels {
		grid-column: 2;
		display: flex;
		justify-content: space-between;
		font-size: 11px;
		line-height: 1.2;
		color: var(--ink-dim);
	}
</style>
