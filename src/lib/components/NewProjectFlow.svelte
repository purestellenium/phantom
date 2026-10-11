<script lang="ts">
	/**
	 * The new-project flow on the projects page: ProjectSteps, fullscreen.
	 *
	 * A room of its own - the ground with a soft light drifting across it, a
	 * labelled progress bar across the top (StepBar, the one onboarding draws), the nav pinned to the foot - so that one
	 * question has the whole screen. Onboarding shows the same screens inline
	 * for somebody's first project, so the second one is made the same way.
	 *
	 * Closing keeps what was typed - the steps stay mounted - so reopening
	 * picks up where it was left.
	 */

	import ProjectSteps from '$lib/components/ProjectSteps.svelte';
	import StepBar from '$lib/components/StepBar.svelte';
	import { FLOW_STEPS, type FlowValues } from '$lib/project-flow';
	import X from '@lucide/svelte/icons/x';

	let {
		open = $bindable(false),
		error = null,
		step = null,
		values = null
	}: {
		open?: boolean;
		error?: string | null;
		step?: number | null;
		values?: FlowValues | null;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let steps: ReturnType<typeof ProjectSteps> | undefined = $state();
	let closing = $state(false);
	let current = $state(0);
	let submitting = $state(false);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			dialog.showModal();
			steps?.focusStep();
		} else if (!open && dialog.open) {
			animateClose();
		}
	});

	/* The same hold-open-then-close as modal.css describes: `close()` drops the
	   dialog from the top layer on the spot, so the out transition runs first
	   under `.is-closing` and the real close waits for it. The timeout covers
	   reduced motion, where no transition runs and none ends. */
	function animateClose() {
		if (!dialog || closing) return;
		closing = true;
		const finish = () => {
			if (!closing) return;
			closing = false;
			dialog?.close();
		};
		dialog.addEventListener('transitionend', finish, { once: true });
		setTimeout(finish, 320);
	}

	function close() {
		if (submitting) return;
		open = false;
	}

	/* Escape's own default is an instant, unanimated close. */
	function onCancel(event: Event) {
		event.preventDefault();
		close();
	}
</script>

<dialog
	class="np"
	class:is-closing={closing}
	bind:this={dialog}
	aria-labelledby="np-question"
	oncancel={onCancel}
	onclose={() => (open = false)}
>
	<div class="np-frame">
		<header class="np-top">
			<button type="button" class="np-icon-btn" aria-label="close" onclick={close}>
				<X size={20} />
			</button>
			<div class="np-bar"><StepBar steps={FLOW_STEPS} {current} label="new project" /></div>
		</header>

		<ProjectSteps
			bind:this={steps}
			bind:submitting
			fill
			onstep={(to) => (current = to)}
			action="?/create"
			active={open}
			linkReturn="/projects?new"
			{error}
			{step}
			{values}
		/>
	</div>
</dialog>

<style>
	/* ── the room ─────────────────────────────────────────────────────── */

	/* Fullscreen, in the top layer. The ground with a soft light on it that
	   drifts - the only thing moving while nobody is typing. */
	.np {
		position: fixed;
		inset: 0;
		width: 100vw;
		max-width: none;
		height: 100dvh;
		max-height: none;
		padding: 0;
		margin: 0;
		color: var(--ink);
		background-color: var(--bg);
		background-image:
			radial-gradient(
				60rem 36rem at var(--glow-x, 50%) -10%,
				rgba(233, 230, 225, 0.07),
				transparent 70%
			),
			var(--weave-bayer);
		border: 0;
		font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
		/* Clip, not hidden. A hidden box still scrolls when told to - focusing a
		   field low on a tall screen did exactly that, and slid the whole room,
		   top bar and all, up out of reach of any wheel. Only the screens'
		   own area scrolls (see ProjectSteps). */
		overflow: clip;
		/* The room's margin at its top and bottom edges, one value for both so
		   the bar above and the buttons below sit the same distance in (the
		   bottom half is ProjectSteps' .np-bottom, which reads this). */
		--np-edge: clamp(28px, 6vh, 64px);
		animation: np-drift 14s ease-in-out infinite alternate;
		transition:
			opacity 260ms ease,
			transform 260ms cubic-bezier(0.2, 0.7, 0.2, 1),
			overlay 260ms ease allow-discrete,
			display 260ms ease allow-discrete;
		opacity: 0;
		transform: scale(1.02);
	}

	.np[open] {
		opacity: 1;
		transform: none;
	}

	@starting-style {
		.np[open] {
			opacity: 0;
			transform: scale(1.02);
		}
	}

	/* Leaving, it recedes: a touch smaller as it fades, stepping back from
	   the reader. The mirror of the way in - fading out while still growing -
	   read as the room coming at you on its way out. */
	.np[open].is-closing {
		opacity: 0;
		transform: scale(0.985);
	}

	/* The dialog is the whole screen and opaque, so it does the fading; a
	   backdrop of its own would snap in a frame ahead of it. */
	.np::backdrop {
		background-color: transparent;
	}

	/* The page underneath stays put while the flow is up. */
	:global(html:has(dialog.np[open])) {
		overflow: hidden;
	}

	@property --glow-x {
		syntax: '<percentage>';
		inherits: false;
		initial-value: 50%;
	}

	@keyframes np-drift {
		from {
			--glow-x: 35%;
		}
		to {
			--glow-x: 65%;
		}
	}

	.np-frame {
		display: grid;
		grid-template-rows: auto 1fr;
		height: 100%;
	}

	/* ── the top bar ──────────────────────────────────────────────────── */

	/* Headroom on onboarding's scale - the labelled bar pressed against the
	   top edge read as cramped - and the close button's centre on the line of
	   the bar rather than halfway down its labels. */
	.np-top {
		display: flex;
		align-items: flex-start;
		gap: 16px;
		width: min(760px, 100%);
		margin: 0 auto;
		padding: var(--np-edge) 16px 16px;
	}

	.np-bar {
		flex: 1;
		min-width: 0;
	}

	.np-icon-btn {
		display: grid;
		flex: none;
		place-items: center;
		width: 38px;
		height: 38px;
		margin-top: -17.5px;
		padding: 0;
		color: var(--ink-mid);
		background: none;
		border: 0;
		cursor: pointer;
		transition: color 120ms ease;
	}

	.np-icon-btn:hover,
	.np-icon-btn:focus-visible {
		color: var(--ink);
		outline: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.np,
		.np * {
			animation: none !important;
			transition-duration: 0ms !important;
		}
	}
</style>
