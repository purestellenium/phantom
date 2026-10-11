<script lang="ts">
	/**
	 * The signed-in shell.
	 *
	 * A route group rather than a path segment: everything in here is at the URL
	 * it looks like it is at - /home, /account - and (app) exists only so
	 * they can share this frame and the gates in hooks.server.ts.
	 *
	 * The frame is one column. The field is fixed behind it and the page scrolls
	 * across it, and the nav scrolls away with everything else.
	 *
	 * [2a] Moving between pages, the new page assembles top to bottom - each
	 * top-level piece a beat after the one above it, the way onboarding's
	 * steps do - while the field and the nav hold still.
	 *
	 * The old page just goes. It used to fade out and lift as a view
	 * transition, and that frozen picture of it, sliding away over the new
	 * page already building underneath, read as the old page rearranging
	 * itself before the new one arrived - most of all leaving the shop's grid
	 * for a product. One page at a time is calmer.
	 */
	import '$lib/site-styles';

	import type { LayoutProps } from './$types';

	import DangerZone from '$lib/components/DangerZone.svelte';
	import Dither from '$lib/components/Dither.svelte';
	import Field from '$lib/components/Field.svelte';
	import LinkErrorNotice from '$lib/components/LinkErrorNotice.svelte';
	import Nav from '$lib/components/Nav.svelte';
	import { installValidation } from '$lib/validation';

	let { data, children }: LayoutProps = $props();

	$effect(() => installValidation());
</script>

<svelte:head>
	<!-- Nothing behind a session belongs in a search index. The front page is
	     public; everything under this group is somebody's dashboard, balance,
	     orders or account. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<Field />
<Dither />
<!-- The page, above the field. #content is what fades in once the hole has
     opened. -->
<div id="content">
	<div class="shell">
		<Nav onboarded={data.onboarded} me={data.me} />
		<!-- A failed Hackatime link, on whichever page it came back to. Draws
		     nothing when there is none, so it takes no place in the page's
		     assembly order below. -->
		<main class="shell-main"><LinkErrorNotice />{@render children()}</main>
		<footer class="shell-foot">
			<a class="foot-flag" href="https://hackclub.com" aria-label="Hack Club">
				<img src="/hack-club-flag.png" alt="" width="522" height="181" />
			</a>
			<span>made with &lt;3 by natey and stelle</span>
		</footer>
	</div>
</div>
<DangerZone operator={data.operator} />

<style>
	/* Every page assembles in the order it reads: each top-level piece rises
	   a beat after the one before it. `backwards`, not `both`: once it has
	   arrived nothing is left holding a transform, which would otherwise make
	   every page section a containing block for anything fixed inside it.
	   Dialogs are left alone - they live in the top layer and animate
	   themselves. */
	.shell-main > :global(:not(dialog)) {
		animation: rise var(--dur-settle) var(--ease-out) backwards;
	}

	.shell-main > :global(:nth-child(2)) {
		animation-delay: calc(var(--stagger) * 1.5);
	}

	.shell-main > :global(:nth-child(3)) {
		animation-delay: calc(var(--stagger) * 3);
	}

	.shell-main > :global(:nth-child(4)) {
		animation-delay: calc(var(--stagger) * 4.5);
	}

	.shell-main > :global(:nth-child(n + 5)) {
		animation-delay: calc(var(--stagger) * 6);
	}

	@media (prefers-reduced-motion: reduce) {
		.shell-main > :global(*) {
			animation: none;
		}
	}
</style>
