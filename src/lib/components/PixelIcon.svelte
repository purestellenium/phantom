<script lang="ts">
	/**
	 * One of the site's pixel icons ($lib/pixel-icons.ts): a 12x12 grid drawn as
	 * crisp squares in the current text colour, like the console's section
	 * icons. Decorative unless given a `label`.
	 */
	import { pixelCells, type PixelIconName } from '$lib/pixel-icons';

	let {
		name,
		size = 24,
		label = null
	}: {
		name: PixelIconName;
		/** In CSS pixels. A multiple of 12 keeps every cell the same size. */
		size?: number;
		/** For an icon that is the only thing saying what it means. */
		label?: string | null;
	} = $props();

	const cells = $derived(pixelCells(name));
</script>

<svg
	class="pixel-icon"
	width={size}
	height={size}
	viewBox="0 0 12 12"
	shape-rendering="crispEdges"
	fill="currentColor"
	role={label ? 'img' : undefined}
	aria-label={label ?? undefined}
	aria-hidden={label ? undefined : 'true'}
	>{#each cells as cell (`${cell.x}:${cell.y}`)}<rect
			x={cell.x}
			y={cell.y}
			width="1"
			height="1"
		/>{/each}</svg
>

<style>
	.pixel-icon {
		display: inline-block;
		flex: none;
		vertical-align: middle;
	}
</style>
