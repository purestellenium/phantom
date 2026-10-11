<script lang="ts">
	/**
	 * The onboarding frame.
	 *
	 * `+layout@.svelte` - the `@` resets this subtree to the ROOT layout, so the
	 * signed-in shell's nav, footer and operator doors do not draw here. Setup is
	 * the one place in the app that is not the app yet: no tabs to a dashboard
	 * you have not unlocked, no shop you cannot buy from. What it keeps is the
	 * ground everything else stands on - the field and the dither - so it reads
	 * as Phantom with the furniture removed rather than as a different site.
	 *
	 * The session and launch gates are unaffected by the reset: they live in
	 * hooks.server.ts, keyed on the `/(app)` route group these files still sit
	 * in, not on which layout renders them.
	 *
	 * Motion, per styles/motion.css. The progress bar (StepBar, the one the
	 * new-project flow draws too) belongs to this layout and
	 * so survives every step change - its fill slides along rather than being
	 * redrawn. Going between steps, the old page steps out the way you are
	 * leaving it (a view transition, where the browser has them) and the new
	 * one assembles from the side you are heading toward, piece by piece. On
	 * arrival from anywhere else it assembles upward instead: there is no
	 * sideways to come from.
	 */
	import '$lib/site-styles';

	import { onNavigate } from '$app/navigation';
	import { page } from '$app/state';

	import Dither from '$lib/components/Dither.svelte';
	import Field from '$lib/components/Field.svelte';
	import LinkErrorNotice from '$lib/components/LinkErrorNotice.svelte';
	import StepBar from '$lib/components/StepBar.svelte';

	let { children } = $props();

	/* The steps, in order. The bar is an indicator, not a menu - it shows the
	   whole shape and where you are, and the pages own the moving between
	   them. Trailing slash trimmed so `/onboarding/` and `/onboarding` land on
	   the same step. */
	const STEPS = [
		{ path: '/onboarding', label: 'welcome' },
		{ path: '/onboarding/setup', label: 'setup' },
		{ path: '/onboarding/expectations', label: 'expectations' },
		{ path: '/onboarding/start', label: 'first project' }
	];

	const stepOf = (pathname: string | undefined) =>
		STEPS.findIndex((step) => step.path === (pathname?.replace(/\/$/, '') || '/onboarding'));

	const current = $derived(stepOf(page.url.pathname));

	/* The axis the next page arrives along: up on a fresh load, sideways once
	   a step has been taken. */
	let axis = $state({ x: 0, y: 1 });

	onNavigate((navigation) => {
		const from = stepOf(navigation.from?.url.pathname);
		const to = stepOf(navigation.to?.url.pathname);
		if (from < 0 || to < 0 || from === to) return;

		const dir = to > from ? 1 : -1;
		axis = { x: dir, y: 0 };

		if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
			return;
		}
		/* Read by the ::view-transition-old rule below, which lives on the root
		   and so cannot see a variable set on anything inside it. */
		document.documentElement.style.setProperty('--ob-dir', String(dir));
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<Field />
<Dither />

<div id="content">
	<div class="onboard">
		<main class="onboard-column">
			<StepBar steps={STEPS.map((step) => step.label)} {current} label="setup progress" />

			<!-- No shared footer: sign-out lives only on the welcome step, which
			     owns its own bottom row (see that page). The later steps are pure
			     flow - a back/next row and nothing else. -->
			<div class="ob-page" style="--dir-x: {axis.x}; --dir-y: {axis.y}">
				<!-- A failed Hackatime link - setup is where most of them start. -->
				<LinkErrorNotice />
				{@render children()}
			</div>
		</main>
	</div>
</div>

<style>
	/* Centred, and bounded to a reading width - narrower than the shell's 880,
	   because a wizard is one thing at a time and a wide column makes a short
	   step look lost in it. */
	.onboard {
		min-height: 100dvh;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding: clamp(32px, 8vh, 96px) 24px 64px;
		box-sizing: border-box;
	}

	/* The shell's own reading width. Wide enough that the start step's three
	   cards are a real size rather than three slivers, and the same measure the
	   rest of the signed-in app uses so the wizard does not read as a narrower
	   place than what it opens into. */
	.onboard-column {
		width: 100%;
		max-width: 880px;
		display: flex;
		flex-direction: column;
		gap: 28px;
	}

	/* ── the page ─────────────────────────────────────────────────────── */

	.ob-page {
		display: flex;
		flex-direction: column;
		gap: 24px;
		view-transition-name: ob-page;
	}

	/* Every step assembles in the order it reads: each top-level piece -
	   heading, panels, the nav row - a beat after the one before it. Done
	   here, once, rather than by marking up every page. */
	.ob-page > :global(:not(dialog)) {
		animation: rise var(--dur-settle) var(--ease-out) both;
	}

	.ob-page > :global(:nth-child(2)) {
		animation-delay: calc(var(--stagger) * 1.5);
	}

	.ob-page > :global(:nth-child(3)) {
		animation-delay: calc(var(--stagger) * 3);
	}

	.ob-page > :global(:nth-child(4)) {
		animation-delay: calc(var(--stagger) * 4.5);
	}

	.ob-page > :global(:nth-child(n + 5)) {
		animation-delay: calc(var(--stagger) * 6);
	}

	/* The view transition between steps. Only the page takes part: the field
	   behind keeps drawing and the progress bar keeps its own animation, so
	   the root is told to hold still. The old page steps out toward the side
	   being left; the new one needs nothing from here, because its pieces are
	   already rising in on their own. */
	:global(::view-transition-old(root)),
	:global(::view-transition-new(root)) {
		animation: none;
	}

	:global(::view-transition-group(ob-page)) {
		animation-duration: 0ms;
	}

	:global(::view-transition-new(ob-page)) {
		animation: none;
	}

	:global(::view-transition-old(ob-page)) {
		animation: ob-leave 200ms var(--ease-out) both;
	}

	@keyframes -global-ob-leave {
		to {
			opacity: 0;
			transform: translateX(calc(var(--ob-dir, 1) * -16px));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ob-page > :global(:not(dialog)) {
			animation: none;
		}
	}
</style>
