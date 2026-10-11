<script lang="ts">
	/**
	 * The ground every page sits on: a fixed canvas behind the content, drawn by
	 * the browser's 2D context (see $lib/field/field). Over the page - above the
	 * type, below the vignette - a second canvas carries the ring lifted off the
	 * field. The vignette sits over everything: its edge darkens the whole frame.
	 *
	 * The gap before the worker's first frame lands is covered by the loader
	 * (Loader.svelte), not by anything in here - see `fieldReady` for how it
	 * knows.
	 */
	import { onMount } from 'svelte';

	import { fieldReady } from '$lib/field/ready.svelte';
	import { startField } from '$lib/field/field';

	let canvas: HTMLCanvasElement | undefined;
	let ring: HTMLCanvasElement | undefined;

	onMount(() => {
		const stopField = canvas ? startField(canvas, ring, () => fieldReady.set()) : () => {};
		return () => {
			stopField();
		};
	});
</script>

<canvas bind:this={canvas} class="field" aria-hidden="true"></canvas>
<canvas bind:this={ring} class="field-ring" aria-hidden="true"></canvas>
<div class="vignette" aria-hidden="true"></div>
