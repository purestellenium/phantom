<script module lang="ts">
	import { geoEqualEarth, geoPath } from 'd3-geo';
	import { feature } from 'topojson-client';
	import type { GeometryCollection, Topology } from 'topojson-specification';
	import world from 'world-atlas/countries-110m.json';

	/* The outlines are the same for every reader, so they are projected once,
	   when the module loads - on the server for the first paint, and again in
	   the browser - rather than on every render. Antarctica is left off: it
	   has no visitors and takes a fifth of the height. */
	const WIDTH = 960;
	const HEIGHT = 440;

	const topology = world as unknown as Topology<{
		countries: GeometryCollection<{ name: string }>;
	}>;
	const shapes = feature(topology, topology.objects.countries).features.filter(
		(shape) => shape.id !== '010'
	);
	const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], {
		type: 'FeatureCollection',
		features: shapes
	});
	const draw = geoPath(projection);
	/* A few places the atlas draws have no ISO number - Kosovo, Northern
	   Cyprus, Somaliland - so they are keyed by name, and never match a code. */
	const OUTLINES = shapes.map((shape) => ({
		id: shape.id === undefined ? `name:${shape.properties.name}` : String(shape.id),
		name: shape.properties.name,
		d: draw(shape) ?? ''
	}));
</script>

<script lang="ts">
	/**
	 * Where visitors are, on a map. Countries come in as Plausible names them -
	 * ISO 3166 alpha-2 - and are matched to the atlas by their numeric code.
	 *
	 * Shaded in four steps rather than a smooth ramp, the way the field is
	 * quantised to its seven levels: a step reads as "more", where a gradient
	 * asks the eye to compare two greys.
	 */
	import { PALETTE, rgb } from '$lib/dither-kit/palette';
	import { ISO_NUMERIC } from '$lib/iso-numeric';

	let { visitors }: { visitors: { code: string; n: number }[] } = $props();

	const byNumeric = $derived(
		new Map(visitors.map((v) => [ISO_NUMERIC[v.code] ?? '', v] as const).filter(([id]) => id))
	);
	const most = $derived(Math.max(1, ...visitors.map((v) => v.n)));

	const STEPS = [0.3, 0.5, 0.75, 1];
	const step = (n: number) => Math.min(3, Math.ceil((n / most) * 4) - 1);
	const fill = (n: number) => rgb(PALETTE.blue.fill, 1, STEPS[step(n)]);

	let hovered = $state<string | null>(null);
	const shown = $derived.by(() => {
		if (!hovered) return null;
		const outline = OUTLINES.find((o) => o.id === hovered);
		const hit = byNumeric.get(hovered);
		return outline ? { name: outline.name, n: hit?.n ?? 0 } : null;
	});
</script>

<figure class="map">
	<!-- Pointer-only detail: the list beside the map carries the same numbers
	     for the keyboard and for a screen reader. -->
	<svg viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-label="Visitors by country, shaded by count">
		{#each OUTLINES as outline (outline.id)}
			{@const hit = byNumeric.get(outline.id)}
			<!-- Hover detail only: the list beside the map has the same numbers. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<path
				d={outline.d}
				class={['country', hit && 'is-visited', hovered === outline.id && 'is-hovered']}
				style:fill={hit ? fill(hit.n) : undefined}
				onpointerenter={() => (hovered = outline.id)}
				onpointerleave={() => (hovered = null)}
			/>
		{/each}
	</svg>
	<figcaption>
		{#if shown}
			<b>{shown.name}</b>
			{shown.n === 0 ? 'nobody yet' : `${shown.n} ${shown.n === 1 ? 'person' : 'people'}`}
		{:else}
			<span class="key">
				{#each STEPS as alpha, i (i)}<i style:background={rgb(PALETTE.blue.fill, 1, alpha)}
					></i>{/each}
				fewer to more people. Hover a country for its count.
			</span>
		{/if}
	</figcaption>
</figure>

<style>
	.map {
		margin: 0;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
	}

	.country {
		fill: var(--level-lift);
		stroke: var(--level-panel);
		stroke-width: 0.6;
	}

	.country.is-visited {
		cursor: default;
	}

	.country.is-hovered {
		stroke: var(--ink);
		stroke-width: 1.2;
	}

	figcaption {
		min-height: 1.5em;
		margin-top: 10px;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	figcaption b {
		color: var(--ink);
		font-weight: 500;
		margin-right: 6px;
	}

	.key {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.key i {
		display: inline-block;
		width: 14px;
		height: 8px;
	}

	.key i:last-of-type {
		margin-right: 8px;
	}
</style>
