<script lang="ts">
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';

	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Hours from '$lib/components/Hours.svelte';
	import HyperChroma from '$lib/components/HyperChroma.svelte';
	import HyperChromaIntro from '$lib/components/HyperChromaIntro.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { thumbField } from '$lib/field/thumb';
	import { day } from '$lib/status';
	import ArrowUp from '@lucide/svelte/icons/arrow-big-up';
	import PixelIcon from '$lib/components/PixelIcon.svelte';

	let { data, form }: PageProps = $props();

	const project = $derived(data.project);

	/* The vote is drawn from what the server said, moved ahead the moment it is
	   pressed and put back if the server refuses - a button that waits on a
	   round trip before it lights feels broken. */
	let pending = $state<boolean | null>(null);
	const upvoted = $derived(pending ?? data.upvoted);
	const upvotes = $derived(
		project.upvotes + (pending === null ? 0 : (pending ? 1 : 0) - (data.upvoted ? 1 : 0))
	);

	const vote: SubmitFunction = () => {
		pending = !data.upvoted;
		return async ({ update }) => {
			await update({ reset: false, invalidateAll: true });
			pending = null;
		};
	};
</script>

<!-- The demo and repository links are the project's own, external. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->

<svelte:head>
	<title>{project.name} · explore · PHANTOM</title>
</svelte:head>

<a class="xp-back" href={resolve('/explore')}><ArrowLeft size={16} aria-hidden="true" /> explore</a>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

{#if project.hyperChroma && data.isOwner}
	<HyperChromaIntro number={project.number} name={project.name} where="explore" />
{/if}

<article class="xp-project">
	<!-- ── the picture ─────────────────────────────────────────────────────── -->
	<div class="xp-shot">
		{#if project.screenshotUrl}
			<img src={project.screenshotUrl} alt="{project.name}, running" />
		{:else}
			<canvas use:thumbField={project.name} aria-hidden="true"></canvas>
		{/if}
	</div>

	<!-- ── the details ─────────────────────────────────────────────────────── -->
	<div class="xp-details">
		<header class="xp-head">
			<span class="xp-kind">
				{#if project.kind === 'hardware'}
					<PixelIcon name="cpu" size={12} /> hardware
				{:else if project.kind === 'software'}
					<PixelIcon name="code" size={12} /> software
				{:else}
					project
				{/if}
				<span class="xp-number">#{project.number}</span>
			</span>
			<h1 class="xp-name">{project.name}</h1>
			{#if project.hyperChroma}<span class="xp-hc"><HyperChroma /></span>{/if}
			{#if project.authorUsername}<p class="xp-by">by @{project.authorUsername}</p>{/if}
		</header>

		<dl class="xp-stats">
			<div>
				<dt>approved</dt>
				<dd><Hours seconds={project.totalApprovedSeconds} /></dd>
			</div>
			<!-- How many times it has been approved - the original and each
			     update since - which says whether it has grown. -->
			<div>
				<dt>{project.ships === 1 ? 'ship' : 'ships'}</dt>
				<dd>{project.ships}</dd>
			</div>
			<div>
				<dt>last approved</dt>
				<dd>{day(project.approvedAt)}</dd>
			</div>
		</dl>

		{#if project.description}<p class="xp-desc">{project.description}</p>{/if}

		<!-- The upvote on a line of its own, just the arrow and the count; the
		     project's links under it. -->
		<div class="xp-vote-row">
			{#if data.isOwner}
				<span
					class="control-btn is-quiet xp-vote is-mine"
					aria-disabled="true"
					title="your project"
					aria-label="{upvotes} upvotes on your project"
				>
					<ArrowUp size={18} aria-hidden="true" />
					<span class="xp-count">{upvotes}</span>
				</span>
			{:else}
				<form method="POST" action="?/upvote" use:enhance={vote}>
					<input type="hidden" name="up" value={upvoted ? '0' : '1'} />
					<button
						type="submit"
						class={['control-btn', upvoted ? 'is-on' : 'is-quiet', 'xp-vote']}
						aria-pressed={upvoted}
						aria-label="{upvoted ? 'remove your upvote' : 'upvote'} ({upvotes})"
					>
						<ArrowUp size={18} aria-hidden="true" />
						<span class="xp-count">{upvotes}</span>
					</button>
				</form>
			{/if}
		</div>

		{#if project.demoUrl || project.repoUrl || data.canOpenProject}
			<div class="xp-actions">
				{#if project.demoUrl}
					<a class="control-btn" href={project.demoUrl} target="_blank" rel="noopener noreferrer">
						<PixelIcon name="external" size={12} /> demo
					</a>
				{/if}
				{#if project.repoUrl}
					<a
						class="control-btn is-quiet"
						href={project.repoUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						<PixelIcon name="branch" size={12} /> code
					</a>
				{/if}
				{#if data.canOpenProject}
					<a class="control-btn is-quiet" href={resolve(`/projects/${project.number}`)}>
						<PixelIcon name="file" size={12} /> project page
					</a>
				{/if}
			</div>
		{/if}
	</div>
</article>

<style>
	/* Prefixed throughout: src/styles has generic global classes (.step and
	   friends) that would otherwise reach in here. The layout is the shop's
	   product page - picture beside details, stacking on a phone - with a
	   screenshot's proportions instead of a product photo's. */
	:global(.shell-main:has(> .xp-project)) {
		max-width: 1180px;
	}

	.xp-back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 18px;
		font-size: var(--text-sm);
		color: var(--ink-dim);
		text-decoration: none;
	}

	.xp-back:hover,
	.xp-back:focus-visible {
		color: var(--ink);
	}

	.xp-project {
		display: grid;
		grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
		gap: 40px;
		align-items: start;
	}

	.xp-shot {
		position: sticky;
		top: 24px;
		aspect-ratio: 16 / 10;
		overflow: hidden;
		border: 1px solid var(--panel-line);
		border-radius: var(--control-radius);
		background-color: var(--bg);
	}

	.xp-shot img,
	.xp-shot canvas {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.xp-details {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.xp-head {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.xp-hc {
		display: flex;
	}

	.xp-kind {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-xs);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}

	.xp-number {
		margin-inline-start: 4px;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		color: var(--ink-dim);
	}

	.xp-name {
		margin: 0;
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-weight: 400;
		font-size: clamp(34px, 5vw, 52px);
		line-height: 1;
		color: var(--fg);
	}

	.xp-by {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-mid);
	}

	/* The three figures, as tiles on the raised surface. */
	.xp-stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin: 0;
	}

	.xp-stats > div {
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--control-radius);
		background-color: var(--surface);
		background-image: var(--weave-bayer), var(--shade-raised);
	}

	.xp-stats dt {
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	.xp-stats dd {
		margin: 4px 0 0;
		font-size: var(--text-md);
		font-weight: 700;
		color: var(--fg);
		font-family: var(--font-geist-mono), ui-monospace, monospace;
	}

	.xp-desc {
		margin: 0;
		max-width: 56ch;
		font-size: var(--text-base);
		line-height: 1.6;
		color: #cfcac2;
		white-space: pre-line;
	}

	.xp-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
	}

	.xp-vote-row {
		display: flex;
	}

	/* A fixed width, in every state: the count changing, or the fill and
	   edge changing with the vote, never moves the button under the
	   pointer. */
	.xp-vote-row :global(.xp-vote) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 80px;
		min-width: 0;
		padding-inline: 0;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
	}

	.xp-actions :global(.control-btn) {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		text-decoration: none;
	}

	/* Reached and upvoted are one look: the light hover fill under the
	   softer weave, so the squares sit back. */
	.xp-vote.is-on,
	button.xp-vote:hover,
	button.xp-vote:focus-visible {
		color: var(--on-light);
		background-color: var(--ink);
		border-color: var(--ink);
		background-image: var(--weave-bayer), var(--shade-raised);
	}

	.xp-count {
		display: inline-block;
		min-width: 3ch;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.xp-vote.is-mine {
		cursor: not-allowed;
		opacity: 0.75;
	}

	@media (max-width: 760px) {
		.xp-project {
			grid-template-columns: 1fr;
			gap: 22px;
		}

		.xp-shot {
			position: static;
		}

		.xp-stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
