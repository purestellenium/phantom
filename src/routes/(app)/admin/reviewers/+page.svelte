<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import DitherAvatar from '$lib/components/dither/DitherAvatar.svelte';
	import { hours, stamp } from '$lib/status';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>reviewers · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">reviewers</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">the whole program</h2>
		<span class="panel-note">{data.totals.active} credited</span>
	</header>

	<div class="panel-body">
		<div class="figures">
			<span class="figure"
				><span class="figure-value">{data.totals.credited}</span>
				<span class="figure-label">sent to airtable</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.totals.week}</span>
				<span class="figure-label">past 7 days</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.totals.month}</span>
				<span class="figure-label">past 30 days</span></span
			>
			<span class="figure"
				><span class="figure-value">{hours(data.totals.creditedSeconds)}</span>
				<span class="figure-label">hours filed</span></span
			>
		</div>
		<p class="panel-prose">
			A reviewer is credited for every ship they first-passed that was sent to Airtable. Second
			passes are not counted, and neither is a ship that never reached Airtable.
			{#if data.totals.uncredited > 0}
				{data.totals.uncredited}
				{data.totals.uncredited === 1 ? 'filing has' : 'filings have'} no first pass on record and credit
				nobody.
			{/if}
		</p>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">the board</h2>
		<span class="panel-note">most credited first</span>
	</header>

	<div class="panel-body">
		{#if data.reviewers.length === 0}
			<p class="panel-prose">nothing has been sent to airtable yet.</p>
		{:else}
			{#each data.reviewers as row (row.key)}
				<a class="row board-row" href={resolve('/(app)/admin/reviewers/[key]', { key: row.key })}>
					<span class="board-rank">{row.rank ?? '-'}</span>
					<span class="board-face">
						{#if row.avatarUrl}
							<img class="board-img" src={row.avatarUrl} alt="" />
						{:else}
							<DitherAvatar name={row.name} class="board-img" />
						{/if}
					</span>
					<span class="row-label">
						{row.name}
						<span class="board-bar"
							><span class="board-fill" style="--share: {Math.round(row.share * 100)}%"
							></span></span
						>
						<span class="row-hint">
							{row.role ?? 'no phantom account'} · {row.week} past 7 days · {row.month} past 30 days ·
							{hours(row.creditedSeconds)} filed
							{#if row.unfiled > 0}· {row.unfiled} not filed{/if}
							{#if row.lastAt}· last {stamp(row.lastAt)}{/if}
						</span>
					</span>
					<span class="row-value">
						<span class="board-count">{row.credited}</span>
						<span class="board-sub">credited</span>
					</span>
				</a>
			{/each}
		{/if}
	</div>
</section>

<style>
	.figures :global(.figure) {
		flex-grow: 0;
	}

	/* `.row` is a two-column grid, label then value. These rows carry a position
	   and a face as well, so the tracks have to be declared or the extra children
	   take the label's and push the count onto a second line. */
	.board-row {
		grid-template-columns: 2ch auto 1fr auto;
	}

	.board-rank {
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		font-size: var(--text-xs);
		color: var(--ink-dim);
		text-align: right;
	}

	.board-face {
		display: flex;
		flex: none;
		align-items: center;
	}

	.board-face :global(.board-img) {
		width: 28px;
		height: 28px;
	}

	/* Volume as a length, with the track visible so a short bar reads as a
	   proportion rather than a stray underline. */
	.board-bar {
		display: block;
		width: 100%;
		max-width: 320px;
		height: 6px;
		margin: 6px 0 2px;
		background-color: var(--level-surface);
	}

	.board-fill {
		display: block;
		width: var(--share, 0%);
		min-width: 2px;
		height: 100%;
		background-color: var(--level-raise);
		background-image: var(--weave-bayer-hard);
	}

	.board-count {
		font-size: var(--text-sm);
		color: var(--ink);
	}

	.board-sub {
		display: block;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}
</style>
