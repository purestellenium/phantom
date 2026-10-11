<script lang="ts">
	/**
	 * Your first project - made with the very screens every later project is
	 * made with (ProjectSteps), laid out inline in onboarding's frame instead
	 * of in the projects page's fullscreen dialog. Somebody who has done this
	 * once already knows how the next one goes.
	 *
	 * There is no skipping it - setup finishes with a project or not at all
	 * (see the finish action). Someone who leaves setup with a project of their
	 * own is far more likely to come back than someone who leaves without.
	 * Nothing on this step links out of setup, since the rest of the site sends
	 * a not-yet-onboarded account straight back here.
	 */
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	import { untrack } from 'svelte';

	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Card from '$lib/components/Card.svelte';
	import ProjectSteps from '$lib/components/ProjectSteps.svelte';
	import { FLOW_STEPS } from '$lib/project-flow';

	let { data, form }: PageProps = $props();

	/* `?preview` for a plain link (starts a fresh query), `&preview` for a form
	   action (the `?/finish` selector has already opened the query - appending
	   `?preview` there makes SvelteKit read the action name as `finish?preview`
	   and match nothing, so the form silently does nothing). */
	const qs = $derived(data.preview ? '?preview' : '');
	const actionQs = $derived(data.preview ? '&preview' : '');

	/* -1 while the intro shows (see ProjectSteps' `intro`), which a refused
	   form skips - so the trail starts hidden rather than flashing in and
	   out before the flow says where it is. */
	let current = $state(untrack(() => (form ? 0 : -1)));
</script>

<svelte:head>
	<title>your first project · PHANTOM</title>
</svelte:head>

<!-- The flow's screens as a small trail under the layout's bar: the bar says
     how far through setup, this says how far through the one step that has
     parts. Kept in place but hidden on the intro, so nothing below it moves
     when the questions begin. -->
<ol class={['ob-trail', current < 0 && 'is-waiting']} aria-label="first project">
	{#each FLOW_STEPS as label, i (label)}
		<li class={['ob-trail-item', i === current && 'is-current', i < current && 'is-done']}>
			{label}
		</li>
	{/each}
</ol>

<ProjectSteps
	onstep={(step) => (current = step)}
	action={`?/finish${actionQs}`}
	submitLabel="create my project"
	linkReturn={`/onboarding/start${qs}`}
	error={form?.error ?? null}
	step={form && 'step' in form ? (form.step ?? null) : null}
	values={form && 'values' in form ? (form.values ?? null) : null}
>
	{#snippet intro()}
		<!-- The flow's first screen: what this step is, before the first
		     question. Same frame and buttons as the questions after it. -->
		<h1 class="np-question np-rise" style="--d: 0">let's create your first project!</h1>
		<p class="np-lede np-rise" style="--d: 1">
			it only takes a minute, and you can change anything later.
		</p>
		<!-- What is about to be made: a project card like the ones on the
		     projects page, still blank - the next screens fill it in. -->
		<div class="fp-preview np-rise" style="--d: 2" aria-hidden="true">
			<Card
				name="your first project"
				by="software or hardware?"
				description="what it is, what it's called and where it lives - all up next."
			/>
		</div>
	{/snippet}
	{#snippet firstBack()}
		<!-- An onboarding path from resolve(), with ?preview appended for the dev
		     walkthrough. -->
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a
			data-sveltekit-noscroll
			class="control-btn is-quiet ob-back"
			href={`${resolve('/(app)/onboarding/expectations')}${qs}`}><ArrowLeft size={16} /> back</a
		>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/snippet}
</ProjectSteps>

<style>
	.ob-trail.is-waiting {
		visibility: hidden;
	}

	.fp-preview {
		width: min(100%, 340px);
		margin-top: 8px;
		/* A card that is a picture of one, not a control. */
		pointer-events: none;
	}

	/* No global list reset on this site, and a list item keeps its marker as a
	   flex item - so without this each label wears a "1." drawn over the gap
	   before it. */
	/* Well clear of the layout's bar above - two progress indicators stacked
	   tight read as one cluttered one - and nearer the screens below, which
	   are what it counts. */
	.ob-trail {
		display: flex;
		list-style: none;
		gap: 8px;
		margin-top: 28px;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	/* Three clearly different weights: steps ahead faint, steps done a step
	   up, the step you are on in full ink with a rule under it. The colours
	   alone sat too close together to tell apart at a glance. */
	.ob-trail-item {
		position: relative;
		color: var(--ink-dim);
		opacity: 0.5;
		transition:
			color 400ms ease,
			opacity 400ms ease;
	}

	.ob-trail-item + .ob-trail-item::before {
		content: '/';
		margin-right: 8px;
		color: var(--ink-dim);
	}

	.ob-trail-item.is-done {
		color: var(--ink-mid);
		opacity: 0.85;
	}

	.ob-trail-item.is-current {
		color: var(--ink);
		opacity: 1;
	}

	/* The rule sits under the word only, not the "/" before it: `::after`,
	   inset from the left by the separator's width. */
	.ob-trail-item::after {
		content: '';
		position: absolute;
		right: 0;
		bottom: -6px;
		left: 0;
		height: 1px;
		background-color: var(--ink);
		transform: scaleX(0);
		transform-origin: left;
		transition: transform 400ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.ob-trail-item + .ob-trail-item::after {
		left: calc(1ch + 8px);
	}

	.ob-trail-item.is-current::after {
		transform: scaleX(1);
	}

	.ob-back {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.ob-back :global(svg) {
		transition: transform 160ms ease;
	}

	.ob-back:hover :global(svg) {
		transform: translateX(-3px);
	}
</style>
