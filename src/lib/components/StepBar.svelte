<script lang="ts">
	/**
	 * A row of steps as a segmented bar, one labelled segment per step.
	 *
	 * Onboarding and the new-project flow each drew their own - thin lines with
	 * labels in one, thicker rounded segments with a "2/5" count in the other -
	 * and moving from one to the other felt like changing sites. This is the
	 * one they share now: onboarding's labelled line, at the flow's weight.
	 *
	 * The fill grows from the left rather than appearing, so each step reads as
	 * ground covered. The step just reached waits a beat before filling, so the
	 * eye lands on the new screen first and then sees the bar agree with it.
	 *
	 * An indicator, not a menu: the pages own the moving between steps.
	 *
	 * [4b] Two more uses, from the order page: `tone="bad"` draws the step it
	 * has reached in the alarm red, for an order that went wrong, and `arrive`
	 * has the segments fill in one after another once the page is on screen,
	 * for a bar that is read on arrival rather than moved through. The server
	 * renders it filled either way.
	 */
	import { onMount } from 'svelte';

	import { motionOk, whenRevealed } from '$lib/reveal';

	let {
		steps,
		current,
		label,
		tone = null,
		arrive = false
	}: {
		steps: readonly string[];
		current: number;
		/** What the bar is the progress of, for a screen reader. */
		label: string;
		/** Red on the step reached, for something that went wrong. */
		tone?: 'bad' | null;
		/** Fill in step by step on arrival - see above. */
		arrive?: boolean;
	} = $props();

	/* Held empty with no transition from mount until the page is revealed,
	   then released a couple of frames later so the empty bar is painted
	   first - the same move as the home page's meter. */
	let held = $state(false);
	onMount(() => {
		if (!arrive || !motionOk()) return;
		held = true;
		return whenRevealed(() => {
			requestAnimationFrame(() => requestAnimationFrame(() => (held = false)));
		});
	});

	const at = $derived(held ? -1 : current);
</script>

<ol
	class={['sb', held && 'is-held', arrive && 'is-arriving', tone === 'bad' && 'is-bad']}
	aria-label={label}
	style="--count: {steps.length}"
>
	{#each steps as step, i (step)}
		<li
			class={['sb-step', i < at && 'is-done', i === at && 'is-current']}
			style={arrive ? `--n: ${i}` : undefined}
			aria-current={i === current ? 'step' : undefined}
		>
			<span class="sb-track" aria-hidden="true"></span>
			<span class="sb-label">
				<span class="sb-num">{String(i + 1).padStart(2, '0')}</span>
				{step}
			</span>
		</li>
	{/each}
</ol>

<style>
	/* `sb-`, not `step`: the landing page's stylesheet has a global `.step`
	   (bands.css) - a padded grid row with a raised last child - and a
	   component's scoping keeps its own rules in, not a global class out. On
	   `.step` this drew every segment as a padded tab with no bar in it.

	   No list reset on this site, so the markers go by hand. */
	.sb {
		display: grid;
		grid-template-columns: repeat(var(--count), 1fr);
		gap: 8px;
		min-width: 0;
		list-style: none;
	}

	.sb-step {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}

	/* Onboarding's line on onboarding's track colour, at the new-project
	   flow's weight - thick enough to read as a bar, not a hairline. */
	.sb-track {
		position: relative;
		height: 3px;
		background-color: var(--line);
		border-radius: 1.5px;
		overflow: hidden;
	}

	.sb-track::after {
		content: '';
		position: absolute;
		inset: 0;
		background-color: var(--ink);
		transform: scaleX(0);
		transform-origin: left;
		transition: transform 700ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.sb-step.is-done .sb-track::after {
		transform: scaleX(1);
	}

	.sb-step.is-current .sb-track::after {
		transform: scaleX(1);
		transition-delay: 120ms;
	}

	.sb-label {
		overflow: hidden;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-size: var(--text-xs);
		color: var(--ink-dim);
		white-space: nowrap;
		text-overflow: ellipsis;
		transition: color 560ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.sb-num {
		margin-right: 6px;
		opacity: 0.6;
	}

	.sb-step.is-done .sb-label {
		color: var(--ink-mid);
	}

	.sb-step.is-current .sb-label {
		color: var(--ink);
	}

	/* Every label does not fit a phone. The numbers stay; the words only for
	   where you are. */
	@media (max-width: 560px) {
		.sb-step:not(.is-current) .sb-label {
			font-size: 0;
		}

		.sb-step:not(.is-current) .sb-num {
			font-size: var(--text-xs);
		}
	}

	/* [4b] Arriving: each segment waits for the one before it. Held, nothing
	   moves at all, so the release is the only thing that animates. */
	.sb.is-arriving .sb-step .sb-track::after {
		transition-delay: calc(var(--n, 0) * 140ms);
	}

	.sb.is-held .sb-track::after,
	.sb.is-held .sb-label {
		transition: none;
	}

	/* [4b] Gone wrong: the step it stopped at, in the alarm red the bad badge
	   wears. */
	.sb.is-bad .sb-step.is-current .sb-track::after {
		background-color: #c2414c;
	}

	.sb.is-bad .sb-step.is-current .sb-label {
		color: #f3ccd0;
	}

	@media (prefers-reduced-motion: reduce) {
		.sb-track::after,
		.sb-label {
			transition: none;
		}
	}
</style>
