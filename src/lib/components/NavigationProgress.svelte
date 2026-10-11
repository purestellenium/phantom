<script lang="ts">
	/**
	 * A thin bar across the top of the page for a navigation, or a form action,
	 * that is taking a while - the same job a browser's own tab spinner does,
	 * for the SPA transitions and plain POSTs that leave it idle.
	 *
	 * Two triggers feed the one bar:
	 *
	 * - `navigating` from `$app/state`, for client-side navigations - a link,
	 *   `goto()`.
	 * - A `submit` listener on `window`, for the "create project" and
	 *   review-decision forms (and anything else built the same way): plain
	 *   `<form method="POST">`s with no `use:enhance`, which do a genuine
	 *   document navigation that `navigating` never sees coming because
	 *   SvelteKit's router is not the thing carrying it out. There is
	 *   deliberately no matching "hide" for this trigger - a real form
	 *   submission ends in the browser unloading this very page, which clears
	 *   the bar (and everything else about this component instance) on its own.
	 *   `defaultPrevented` is the one guard: an `use:enhance`d form calls it
	 *   from a listener on the form itself, which runs before this one on the
	 *   same event, so this stays out of the way of anything that already
	 *   handles its own submission.
	 *
	 * Delayed on purpose: most navigations here resolve in well under the delay
	 * below, and a bar that flashes on and off for those reads as noise rather
	 * than information. It only appears once something has been pending long
	 * enough to be worth telling anyone about, then eases toward - never
	 * reaches - 85%, because the one thing this cannot know is how much longer
	 * the wait actually is. Snapping to 100% is reserved for the moment a
	 * navigation actually finishes; a form submission never gets there because
	 * nothing is left running to say so.
	 */
	import { untrack } from 'svelte';

	import { navigating } from '$app/state';

	const SHOW_DELAY_MS = 250;
	const FADE_MS = 200;
	const EASE_INTERVAL_MS = 120;
	const EASE_TARGET = 0.85;
	const EASE_RATE = 0.12;

	let visible = $state(false);
	let progress = $state(0);

	let showTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let ease: ReturnType<typeof setInterval> | undefined;

	function clearTimers() {
		clearTimeout(showTimer);
		clearTimeout(hideTimer);
		clearInterval(ease);
	}

	function schedule(pending: boolean) {
		if (pending) {
			/* Already on its way in or fully visible - one cause is enough, and
			   clearing timers here would cut the ease interval a second cause
			   firing mid-flight has no business stopping. */
			if (visible) return;
			clearTimers();
			showTimer = setTimeout(() => {
				visible = true;
				progress = 0.08;
				ease = setInterval(() => {
					progress += (EASE_TARGET - progress) * EASE_RATE;
				}, EASE_INTERVAL_MS);
			}, SHOW_DELAY_MS);
			return;
		}

		clearTimers();
		if (visible) {
			progress = 1;
			hideTimer = setTimeout(() => {
				visible = false;
				progress = 0;
			}, FADE_MS);
		}
	}

	$effect(() => {
		/* `navigating` is a stable object from `$app/state` - only its properties
		   are reactive. Reading `.to` here is what makes this effect re-run on
		   every navigation; reading `navigating` itself would not. */
		const pending = navigating.to;

		/* `schedule` writes `visible`/`progress`, which must not re-trigger this
		   same effect - its only real input is navigation state. */
		untrack(() => schedule(Boolean(pending)));

		/* Runs before the next navigation's pass and on unmount, so a completed
		   or cancelled phase never leaves a timer running into the next one. */
		return clearTimers;
	});

	function onSubmit(event: SubmitEvent) {
		if (event.defaultPrevented) return;
		schedule(true);
	}
</script>

<svelte:window onsubmit={onSubmit} />

{#if visible}
	<div
		class="nav-progress"
		style="transform: scaleX({progress}); opacity: {progress >= 1 ? 0 : 1};"
	></div>
{/if}

<style>
	.nav-progress {
		position: fixed;
		inset-inline: 0;
		top: 0;
		z-index: 6;
		height: 2px;
		background-color: var(--fg);
		transform-origin: left;
		transition:
			transform 200ms ease-out,
			opacity 200ms ease-out;
		pointer-events: none;
	}
</style>
