<script lang="ts">
	/**
	 * The frame for a page that is one panel and nothing else: an error, a 404.
	 *
	 * These sit outside the signed-in shell - some of them are what you get
	 * instead of a session - so each would otherwise have to mount the field for
	 * itself, and the first one to forget would render over a flat black
	 * rectangle. There is no nav here on purpose: on
	 * every one of these pages there is exactly one thing to do, and a nav would
	 * be offering routes that are either unreachable or the thing that just
	 * failed.
	 */
	import type { Snippet } from 'svelte';

	import Field from './Field.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<Field />
<main id="content">
	<div class="solo">
		<div class="solo-inner">
			{@render children()}

			<footer class="shell-foot">
				<a class="foot-flag" href="https://hackclub.com" aria-label="Hack Club">
					<img src="/hack-club-flag.png" alt="" width="522" height="181" />
				</a>
				<span>made with &lt;3 by natey and stelle</span>
			</footer>
		</div>
	</div>
</main>
