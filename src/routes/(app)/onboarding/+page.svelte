<script lang="ts">
	/**
	 * Welcome - what Phantom is and how the whole thing works, before a single
	 * field. OneKey opens on the idea rather than on a form, and the current
	 * task-list skipped straight to the chores; this is the missing first beat.
	 */
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import SignOutButton from '$lib/components/SignOutButton.svelte';

	let { data }: PageProps = $props();

	/* Carried onto the next step so a dev preview does not fall out of preview at
	   the first click - the setup load would then bounce an onboarded account
	   straight to /home. Empty for a real run. */
	const qs = $derived(data.preview ? '?preview' : '');

	const STEPS = [
		{ t: 'get an idea', d: 'anything you want to make.' },
		{
			t: 'start building and logging time',
			d: "work on your projects with hackatime running to log your hours. logged hours aren't fragments yet - they count once your project is shipped and approved."
		},
		{
			t: 'ship it for review',
			d: "once you're happy with your creation, submit it. a reviewer checks it and approves the hours you put in."
		},
		{
			t: 'get fragments, become a phantom',
			d: 'every hour that gets approved earns 10 fragments.\nan invite to the in-person event costs 500 - or spend them on prizes in the shop instead.'
		}
	];
</script>

<svelte:head>
	<title>welcome · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">welcome to phantom</h1>
	<p class="page-lede">
		build creative projects for fifty hours to earn an invite to a three-day escape-room hackathon
		in philadelphia.
	</p>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">how it works</h2>
	</header>

	<div class="panel-body">
		<ol class="rules">
			{#each STEPS as step, i (step.t)}
				<!-- One line at a time, once the panel holding them has begun to
				     arrive - see styles/motion.css. -->
				<li class="rule rise" style="--i: {i}; --rise-after: 160ms">
					<span class="rule-num">{i + 1}</span>
					<div class="rule-text">
						<h3 class="rule-title">{step.t}</h3>
						<p class="rule-body">{step.d}</p>
					</div>
				</li>
			{/each}
		</ol>
	</div>
</section>

<!-- Sign-out flush to the box's left edge, "let's go" flush to its right. There
     is no "back" from the first step, so sign-out takes the slot a back button
     would, and this is the only step that carries it inline (see the layout). -->
<div class="ob-firstnav">
	<SignOutButton />
	<!-- resolve() gives the onboarding path; `qs` appends ?preview for the dev
	     walkthrough, a query string on our own route rather than an external link. -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		data-sveltekit-noscroll
		class="control-btn is-large nudge"
		href={`${resolve('/(app)/onboarding/setup')}${qs}`}
	>
		let's go <ArrowRight size={16} />
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</div>

<style>
	/* The same numbered list as the expectations step, so the two panels of "here
	   is the shape of it" read as one material. */
	.rules {
		display: flex;
		flex-direction: column;
		gap: 22px;
	}

	.rule {
		position: relative;
		display: grid;
		grid-template-columns: 30px 1fr;
		gap: 14px;
		align-items: start;
	}

	/* The steps joined into one path: a line from each number down to the
	   next, drawn downward once both ends have arrived - so the list reads as
	   a route from an idea to the event, not four separate facts. */
	.rule:not(:last-child)::before {
		content: '';
		position: absolute;
		top: 32px;
		bottom: -18px;
		left: 14px;
		width: 1px;
		background-color: var(--panel-line);
		transform-origin: top;
		animation: rule-path 520ms var(--ease-out) both;
		animation-delay: calc(var(--i, 0) * var(--stagger) + 360ms);
	}

	@keyframes rule-path {
		from {
			transform: scaleY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.rule:not(:last-child)::before {
			animation: none;
		}
	}

	/* A filled chip rather than plain text - the light fill the system spends on
	   "this one". */
	.rule-num {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-size: var(--text-xs);
		font-weight: 600;
		line-height: 1;
		color: var(--on-light);
		background-color: var(--ink);
		border-radius: 50%;
		background-image: var(--shade-raised);
	}

	.rule-title {
		font-size: var(--text-md);
		font-weight: 600;
		line-height: 1.3;
		color: var(--ink);
	}

	.rule-body {
		margin-top: 5px;
		font-size: var(--text-sm);
		line-height: 1.6;
		color: var(--ink-mid);
		/* A step can run to two lines, split with \n in its text. */
		white-space: pre-line;
	}

	.ob-firstnav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
</style>
