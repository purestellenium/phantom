<script lang="ts">
	/**
	 * The operator doors, bottom right of every signed-in page.
	 *
	 * Red on purpose, in a frame that keeps red for errors: nobody but an
	 * operator ever sees these, and for them the joke is the point - a big
	 * hazard-striped button that says you are about to leave the participant's
	 * world. Presentation only: every console page re-checks its capability
	 * server-side. (Review is on Ari now, so there is no review door here.)
	 */
	import { resolve } from '$app/paths';

	let { operator }: { operator: boolean } = $props();
</script>

{#if operator}
	<aside class="danger-zone" aria-label="Operator">
		<a class="danger-btn" href={resolve('/admin')}>admin</a>
	</aside>
{/if}
