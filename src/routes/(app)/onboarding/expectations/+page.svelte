<script lang="ts">
	/**
	 * The bar, said plainly, before the finish line. A short numbered list rather
	 * than a wall of policy - each rule is one thing, with the reason next to it,
	 * because a rule someone understands is one they will keep and a rule they
	 * scrolled past is not.
	 *
	 * Each rule is acknowledged on its own - a press on it turns its number
	 * into a check - and "next" opens once all of them are. It replaced one
	 * "i have read these" box at the foot, which is a box people tick on the
	 * way past: four small presses, one per rule, is what it takes to have
	 * actually looked at each.
	 */
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import PixelIcon from '$lib/components/PixelIcon.svelte';

	let { data }: PageProps = $props();

	const qs = $derived(data.preview ? '?preview' : '');

	const RULES = [
		{
			title: 'make it yours, not the ai’s',
			body: "heavy use of ai is not allowed! a good rule of thumb is that your project should still be recognizable (and uniquely yours) with all of the ai-generated parts removed! if the main part of your project is completely ai-generated, it won't pass review."
		},
		{
			title: 'commit as you build',
			body: 'we read your whole git history, not just the final file. commit early and often, with messages that say what changed, so we can track your progress and see your process. one big upload of finished code at the end will not be accepted.'
		},
		{
			title: 'write your own readme',
			body: 'in your own words, tell us what you made, how you made it, and how we can use it ourselves. an ai-written readme is easy to spot and is an immediate rejection.'
		},
		{
			title: 'just have fun',
			body: "your projects don't have to be the best; they just need to matter to you. a project that you genuinely care about and put passion into is worth a hundred projects that might as well be copy-pasted from somewhere else."
		}
	];

	/* Which rules have been acknowledged, by position. Client-side:
	   acknowledging the bar is a decision about this screen, and the bar
	   itself is held at review. */
	let read = $state<boolean[]>([]);
	const readCount = $derived(read.filter(Boolean).length);
	const understood = $derived(readCount === RULES.length);

	/* A press on the rule, anywhere on it. Pressing one already read takes it
	   back - a slip is undone the same way it was made. */
	function toggle(i: number) {
		read[i] = !read[i];
	}
</script>

<svelte:head>
	<title>expectations · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">what a project needs</h1>
	<p class="page-lede">a list of expectations for phantom projects</p>
</header>

<section class="panel">
	<div class="panel-body">
		<ol class="rules">
			{#each RULES as rule, i (rule.title)}
				<!-- The whole rule takes the press, for a pointer; the chip is the
				     real button, so the keyboard and a screen reader get one control
				     per rule with its state on it. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
				<li
					class={['rule rise', read[i] && 'is-read']}
					style="--i: {i}; --rise-after: 160ms"
					onclick={(event) => {
						if (!(event.target as HTMLElement).closest('button')) toggle(i);
					}}
				>
					<button
						type="button"
						class="rule-num"
						aria-pressed={read[i] ?? false}
						aria-label={`${rule.title} - ${read[i] ? 'read' : 'mark as read'}`}
						onclick={() => toggle(i)}
					>
						{#if read[i]}
							<span class="rule-check"><PixelIcon name="check" size={12} /></span>
						{:else}
							{i + 1}
						{/if}
					</button>
					<div class="rule-text">
						<h2 class="rule-title">{rule.title}</h2>
						<p class="rule-body">{rule.body}</p>
					</div>
				</li>
			{/each}
		</ol>
	</div>

	<!-- How many are done, as a count and as a bar filling toward "next". -->
	<div class="panel-foot ack">
		<span class="ack-bar" aria-hidden="true">
			<span class="ack-fill" style="--done: {readCount / RULES.length}"></span>
		</span>
		<span class="ack-count" aria-live="polite">
			{#if understood}
				all read - you're good to go.
			{:else}
				{readCount} of {RULES.length} read. press each one once you've read it.
			{/if}
		</span>
	</div>
</section>

<div class="ob-nav">
	<!-- eslint-disable svelte/no-navigation-without-resolve -- onboarding paths from
	     resolve() with ?preview appended for the dev walkthrough. -->
	<a
		data-sveltekit-noscroll
		class="control-btn is-quiet nudge is-back"
		href={`${resolve('/(app)/onboarding/setup')}${qs}`}><ArrowLeft size={16} /> back</a
	>
	{#if understood}
		<!-- `lit`: it fades up out of the disabled material the moment the last
		     rule is read, so the unlock is seen rather than noticed later. -->
		<a
			data-sveltekit-noscroll
			class="control-btn is-large lit nudge"
			href={`${resolve('/(app)/onboarding/start')}${qs}`}>next <ArrowRight size={16} /></a
		>
	{:else}
		<span class="control-btn is-large ob-disabled nudge" aria-disabled="true"
			>next <ArrowRight size={16} /></span
		>
	{/if}
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</div>

<style>
	.rules {
		display: flex;
		flex-direction: column;
		gap: 22px;
	}

	/* A number and its rule. The number is an anchor for scanning back to one, so
	   it is a filled chip rather than plain text - the light fill the system
	   spends on "this one". */
	.rule {
		display: grid;
		grid-template-columns: 30px 1fr;
		gap: 14px;
		align-items: start;
		margin: -8px -10px;
		padding: 8px 10px;
		border-radius: var(--control-radius);
		cursor: pointer;
		transition: background-color var(--dur-quick) ease;
	}

	@media (hover: hover) {
		.rule:hover {
			background-color: rgba(255, 255, 255, 0.03);
		}
	}

	/* Unread, the number is an outline waiting to be filled; read, it takes
	   the light fill the system spends on "this one" and becomes a check. */
	.rule-num {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-size: var(--text-xs);
		font-weight: 600;
		line-height: 1;
		color: var(--ink);
		background-color: transparent;
		border: 1px solid var(--panel-line);
		border-radius: 50%;
		cursor: pointer;
		transition:
			background-color var(--dur-quick) ease,
			border-color var(--dur-quick) ease,
			color var(--dur-quick) ease;
	}

	.rule:hover .rule-num,
	.rule-num:focus-visible {
		border-color: var(--ink);
		outline: none;
	}

	.rule.is-read .rule-num {
		color: var(--on-light);
		background-color: var(--ink);
		background-image: var(--shade-raised);
		border-color: var(--ink);
	}

	/* The check draws itself in rather than appearing: uncovered left to
	   right in whole-pixel steps, the way a pixel mark would be drawn. */
	.rule-check {
		display: grid;
		place-items: center;
	}

	.rule-check :global(svg) {
		clip-path: inset(0 100% 0 0);
		animation: rule-draw 320ms steps(12) forwards;
	}

	@keyframes rule-draw {
		to {
			clip-path: inset(0 0 0 0);
		}
	}

	/* Read rules step back a shade, so what is left to read is what stands
	   out. */
	.rule-text {
		transition: opacity var(--dur-settle) var(--ease-out);
	}

	.rule.is-read .rule-text {
		opacity: 0.72;
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
	}

	.ack {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.ack-bar {
		position: relative;
		height: 2px;
		background-color: var(--line);
		overflow: hidden;
	}

	.ack-fill {
		position: absolute;
		inset: 0;
		background-color: var(--ink);
		transform: scaleX(var(--done, 0));
		transform-origin: left;
		transition: transform var(--dur-settle) var(--ease-out);
	}

	.ack-count {
		font-size: var(--text-sm);
		color: var(--ink-mid);
	}

	@media (prefers-reduced-motion: reduce) {
		.rule-check :global(svg) {
			animation: none;
			clip-path: none;
		}
	}

	.ob-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	/* Greyed and inert, the same shape as the live next. */
	.ob-disabled {
		background-color: var(--level-lift);
		border-color: var(--panel-line);
		color: var(--ink-dim);
		background-image: none;
		cursor: not-allowed;
	}
</style>
