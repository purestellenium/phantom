<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import type { Area, LinkedItem } from './+page.server';

	import WorldMap from '$lib/components/WorldMap.svelte';
	import Journeys from './Journeys.svelte';
	import DayChart from '$lib/components/dither/DayChart.svelte';
	import { PALETTE, rgb, type DitherColor } from '$lib/dither-kit/palette';

	let { data }: PageProps = $props();

	const RANGES = [
		{ key: '7d', label: '7 days', phrase: 'in the last 7 days' },
		{ key: '30d', label: '30 days', phrase: 'in the last 30 days' },
		{ key: 'all', label: 'all time', phrase: 'since tracking began' }
	] as const;

	const phrase = $derived(RANGES.find((r) => r.key === data.range)?.phrase ?? '');

	type Row = { label: string; n: number; href?: string | null };

	/* Seconds as a person says them: 4m 01s. */
	function duration(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
	}

	/* What share of the step before it a step kept - the drop-off along the path. */
	function kept(n: number | null, before: number | null): string | null {
		if (n === null || before === null || before === 0) return null;
		return `${Math.round((n / before) * 100)}%`;
	}

	/* The segments of one stacked bar, in palette order. */
	const SEGMENT: DitherColor[] = ['purple', 'blue', 'green', 'orange', 'pink', 'grey'];
	const colour = (color: DitherColor, a = 1) => rgb(PALETTE[color].fill, 1, a);

	const total = (rows: Row[]) => rows.reduce((sum, row) => sum + row.n, 0);
	const widest = (rows: Row[]) => Math.max(1, ...rows.map((row) => row.n));
</script>

<svelte:head>
	<title>analytics · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">analytics</h1>
	{#if data.configured}
		<nav class="row-actions" aria-label="date range">
			{#each RANGES as r (r.key)}
				<a
					class={['control-btn', 'is-small', data.range !== r.key && 'is-quiet']}
					aria-current={data.range === r.key ? 'page' : undefined}
					href={resolve(`/admin/analytics?range=${r.key}`)}
					data-sveltekit-noscroll>{r.label}</a
				>
			{/each}
		</nav>
	{/if}
</header>

<!-- One row of a ranked list: the name, a bar for its share of the top row
     in its own column so every bar starts at the same edge, and the count. -->
{#snippet row(item: LinkedItem | Row, top: number)}
	{#if item.href}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the live site, in a new tab -->
		<a class="name" href={item.href} target="_blank" rel="noopener noreferrer">{item.label}</a>
	{:else}
		<span class="name">{item.label}</span>
	{/if}
	<span class="bar" aria-hidden="true"><span style:width="{(item.n / top) * 100}%"></span></span>
	<span class="n">{item.n}</span>
{/snippet}

{#snippet ranked(rows: LinkedItem[] | Row[] | null, color: DitherColor, empty: string)}
	{#if rows === null}
		<p class="quiet">Plausible didn't answer. Reload to try again.</p>
	{:else if rows.length === 0}
		<p class="quiet">{empty}</p>
	{:else}
		{@const top = widest(rows)}
		<ol class="ranked" style:--accent={colour(color)}>
			{#each rows as item (item.label)}
				<li>{@render row(item, top)}</li>
			{/each}
		</ol>
	{/if}
{/snippet}

<!-- Pages by area. The areas rank against each other; opening one ranks its
     own pages against its busiest. -->
{#snippet areaList(areas: Area[] | null)}
	{#if areas === null}
		<p class="quiet">Plausible didn't answer. Reload to try again.</p>
	{:else if areas.length === 0}
		<p class="quiet">No pages viewed yet.</p>
	{:else}
		{@const top = widest(areas)}
		<div class="ranked areas" style:--accent={colour('green')}>
			<p class="overall">
				<span class="name">all pages</span>
				<span class="n">{total(areas)}</span>
			</p>
			{#each areas as area (area.key)}
				<details class="area">
					<summary>{@render row(area, top)}</summary>
					<ol class="ranked inside">
						{#each area.pages as page (page.label)}
							<li>{@render row(page, widest(area.pages))}</li>
						{/each}
					</ol>
				</details>
			{/each}
		</div>
	{/if}
{/snippet}

{#if !data.configured}
	<section class="panel">
		<div class="panel-body">
			<p>
				Set <code>PLAUSIBLE_API_KEY</code> to a Plausible Stats API key (Plausible → account settings
				→ API keys), and this page fills in.
			</p>
		</div>
	</section>
{:else}
	<!-- ── how many ─────────────────────────────────────────────────────── -->
	<section class="panel">
		<div class="panel-body headline">
			<p class="people">
				{#if data.summary}
					<span class="people-n">{data.summary.visitors}</span>
					{data.summary.visitors === 1 ? 'person' : 'people'}
					<span class="people-when">{phrase}</span>
				{:else}
					<span class="quiet">Plausible didn't answer. Reload to try again.</span>
				{/if}
			</p>

			{#if data.days && data.days.length > 0}
				<div class="chart">
					<DayChart
						days={data.days}
						color="green"
						label="Visitors per {data.range === 'all'
							? 'week'
							: 'day'}. Arrow keys move between them."
					/>
				</div>
			{/if}

			{#if data.summary}
				<dl class="figures">
					<div>
						<dt>visits</dt>
						<dd>{data.summary.visits}</dd>
					</div>
					<div>
						<dt>pages viewed</dt>
						<dd>{data.summary.pageviews}</dd>
					</div>
					<div>
						<dt>left after one page</dt>
						<dd>{Math.round(data.summary.bounceRate)}%</dd>
					</div>
					<div>
						<dt>average visit</dt>
						<dd>{duration(data.summary.visitDuration)}</dd>
					</div>
				</dl>
			{/if}
		</div>
	</section>

	<!-- ── the way through ──────────────────────────────────────────────── -->
	{@const missing = data.path.filter((step) => step.n === null)}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">the way through</h2>
		</header>
		<div class="panel-body">
			<ol class="path">
				<li>
					<span class="step-n">{data.summary?.visitors ?? '–'}</span>
					<span class="step-label">visited</span>
				</li>
				{#each data.path as step, i (step.goal)}
					{@const before = i === 0 ? (data.summary?.visitors ?? null) : data.path[i - 1].n}
					{@const share = kept(step.n, before)}
					<li class={[step.n === null && 'is-uncounted']}>
						{#if share}<span class="step-kept">{share}</span>{/if}
						<span class="step-n">{step.n ?? '–'}</span>
						<span class="step-label">{step.label}</span>
					</li>
				{/each}
			</ol>

			{#if missing.length > 0}
				<p class="quiet setup">
					Steps showing – aren't counted yet. In Plausible, add each as a custom event goal (site
					settings → goals):
					{#each missing as step, i (step.goal)}<code>{step.goal}</code>{i < missing.length - 1
							? ', '
							: '.'}{/each}
				</p>
			{/if}

			{#if data.otherEvents && data.otherEvents.length > 0}
				<h3 class="sub">everything else people did</h3>
				{@render ranked(data.otherEvents, 'green', '')}
			{/if}
		</div>
	</section>

	<!-- ── what they looked at ──────────────────────────────────────────── -->
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">pages</h2>
			<span class="panel-note">views</span>
		</header>
		<div class="panel-body">
			{@render areaList(data.areas)}
		</div>
	</section>

	<!-- ── who ──────────────────────────────────────────────────────────── -->
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">who</h2>
			<span class="panel-note">people</span>
		</header>
		<div class="panel-body">
			<dl class="who">
				{#each data.who as row (row.question)}
					<div class="who-row">
						<dt>{row.question}</dt>
						<dd>
							{#if row.items && row.items.length > 0}
								{@const sum = total(row.items)}
								<span class="split" aria-hidden="true">
									{#each row.items as item, i (item.label)}
										<span
											style:flex-grow={item.n}
											style:background={colour(SEGMENT[i % SEGMENT.length], 0.8)}
										></span>
									{/each}
								</span>
								<span class="legend">
									{#each row.items as item, i (item.label)}
										<span
											><i style:background={colour(SEGMENT[i % SEGMENT.length])}></i>{item.label}
											<b>{item.n}</b>
											<span class="quiet">{Math.round((item.n / sum) * 100)}%</span></span
										>
									{/each}
								</span>
							{:else}
								<span class="quiet">Nobody yet.</span>
							{/if}
						</dd>
					</div>
				{/each}
			</dl>

			{#if data.cohorts && data.cohorts.length > 0}
				<h3 class="sub">by the week they signed up</h3>
				{@render ranked(data.cohorts, 'purple', '')}
			{/if}
		</div>
	</section>

	<!-- ── where they came from ─────────────────────────────────────────── -->
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">where they came from</h2>
			<span class="panel-note">people</span>
		</header>
		<div class="panel-body world">
			{#if data.countries === null}
				<p class="quiet">Plausible didn't answer. Reload to try again.</p>
			{:else}
				<WorldMap visitors={data.countries} />
			{/if}
			<div class="trio">
				<div>
					<h3 class="sub">countries</h3>
					{@render ranked(data.countries?.slice(0, 6) ?? null, 'blue', 'No visits yet.')}
				</div>
				<div>
					<h3 class="sub">sites and apps</h3>
					{@render ranked(data.sources, 'blue', 'No visits yet.')}
				</div>
				{#if data.campaigns && data.campaigns.length > 0}
					<div>
						<h3 class="sub">invite and partner links</h3>
						{@render ranked(data.campaigns, 'blue', '')}
					</div>
				{/if}
			</div>
		</div>
	</section>

	<!-- ── guides ─────────────────────────────────────────────────────────── -->
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">guides</h2>
			<span class="panel-note">people</span>
		</header>
		<div class="panel-body">
			{#if data.guides === null}
				<p class="quiet">Plausible didn't answer. Reload to try again.</p>
			{:else}
				{@const counted = data.guides.some((g) => g.finished !== null)}
				<table class="guides">
					<thead>
						<tr>
							<th scope="col">guide</th>
							<th scope="col" class="num">opened</th>
							<th scope="col" class="num">read to the end</th>
							<th scope="col" class="done"><span class="sr">share who finished</span></th>
						</tr>
					</thead>
					<tbody>
						{#each data.guides as guide (guide.slug)}
							{@const share =
								guide.finished !== null && guide.opened > 0 ? guide.finished / guide.opened : null}
							<tr class={[guide.opened === 0 && 'is-unread']}>
								<th scope="row">
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the live site, in a new tab -->
									<a href={guide.href} target="_blank" rel="noopener noreferrer">{guide.title}</a>
								</th>
								<td class="num">{guide.opened}</td>
								<td class="num">{guide.finished ?? '–'}</td>
								<td class="done">
									{#if share !== null}
										<span class="bar" style:--accent={colour('orange')} aria-hidden="true"
											><span style:width="{Math.min(1, share) * 100}%"></span></span
										>
										<span class="pct">{Math.round(Math.min(1, share) * 100)}%</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if !counted}
					<p class="quiet note">
						"Read to the end" fills in once <code>guide.finished</code> is a goal in Plausible.
					</p>
				{/if}
			{/if}
		</div>
	</section>

	<!-- ── searches ───────────────────────────────────────────────────────── -->
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">searched for</h2>
			<span class="panel-note">times</span>
		</header>
		<div class="panel-body">
			{@render ranked(
				data.searches,
				'orange',
				'Nothing yet. Searches on explore and the shop show here once filter is a goal in Plausible.'
			)}
		</div>
	</section>

	<!-- ── journeys ─────────────────────────────────────────────────────── -->
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">journeys</h2>
			<span class="panel-note">people</span>
		</header>
		<div class="panel-body">
			<Journeys range={data.range} />
		</div>
	</section>
{/if}

<style>
	.quiet {
		margin: 0;
		color: var(--ink-dim);
		font-size: var(--text-xs);
		line-height: 1.5;
	}

	.sub {
		margin: 0 0 8px;
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--ink-dim);
	}

	code {
		font-size: 0.92em;
		color: var(--ink-mid);
	}

	/* ── how many ─────────────────────────────────────────────────────── */

	.headline {
		display: grid;
		gap: 20px;
	}

	.people {
		margin: 0;
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-size: 34px;
		line-height: 1;
	}

	.people-n {
		font-size: 88px;
		letter-spacing: -0.02em;
		margin-right: 0.08em;
	}

	.people-when {
		color: var(--ink-dim);
	}

	.chart {
		height: 180px;
	}

	.figures {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 16px;
		margin: 0;
		padding-top: 16px;
		border-top: 1px solid var(--panel-line);
	}

	.figures dt {
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	.figures dd {
		margin: 4px 0 0;
		font-size: var(--text-lg);
		font-variant-numeric: tabular-nums;
	}

	/* ── the way through ──────────────────────────────────────────────── */

	.path {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.path li {
		position: relative;
		display: grid;
		align-content: end;
		gap: 6px;
		padding: 28px 12px 4px;
		border-left: 1px solid var(--panel-line);
	}

	.path li:first-child {
		border-left: 0;
		padding-left: 0;
	}

	.step-n {
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-size: 56px;
		line-height: 0.9;
		font-variant-numeric: lining-nums;
	}

	.step-label {
		font-size: var(--text-xs);
		color: var(--ink-mid);
	}

	/* The share of the step before that made it here, on the rule between them. */
	.step-kept {
		position: absolute;
		top: 4px;
		left: 12px;
		font-size: var(--text-xs);
		color: rgb(150, 255, 180);
		font-variant-numeric: tabular-nums;
	}

	.path li.is-uncounted .step-n,
	.path li.is-uncounted .step-label {
		color: var(--ink-dim);
		opacity: 0.6;
	}

	.setup {
		margin-top: 16px;
	}

	.path + .setup + .sub,
	.path + .sub {
		margin-top: 24px;
	}

	/* ── ranked lists ─────────────────────────────────────────────────── */

	/* Rows as a table: name, bar, count, each in its own column, so the bars
	   all start at one edge and the counts line up on the right. */
	.ranked {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ranked li,
	.ranked summary,
	.overall {
		display: grid;
		grid-template-columns: minmax(0, 1fr) clamp(64px, 22%, 140px) 4ch;
		align-items: center;
		gap: 14px;
		min-height: 38px;
		font-size: 15px;
	}

	.ranked li + li,
	.area + .area,
	.overall + .area {
		border-top: 1px solid var(--panel-line);
	}

	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--ink);
	}

	a.name {
		text-decoration: none;
	}

	a.name:hover,
	a.name:focus-visible {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	/* The bar in the site's own material: a two-pixel checker of the accent
	   over a faint track, the way the field is dithered rather than filled. */
	.bar {
		height: 8px;
		background: color-mix(in srgb, var(--ink) 6%, transparent);
	}

	.bar > span {
		display: block;
		height: 100%;
		min-width: 2px;
		background-image: repeating-conic-gradient(var(--accent) 0 25%, transparent 0 50%);
		background-size: 4px 4px;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
	}

	.n {
		text-align: right;
		color: var(--ink-mid);
		font-variant-numeric: tabular-nums;
	}

	/* ── pages by area ────────────────────────────────────────────────── */

	.overall {
		margin: 0;
		font-weight: 500;
	}

	.overall .n {
		grid-column: 3;
		color: var(--ink);
	}

	.area summary {
		cursor: pointer;
		list-style: none;
		padding-left: 18px;
		position: relative;
	}

	.area summary::-webkit-details-marker {
		display: none;
	}

	/* A caret that turns as the area opens. */
	.area summary::before {
		content: '';
		position: absolute;
		left: 2px;
		top: 50%;
		width: 6px;
		height: 6px;
		border-right: 1.5px solid var(--ink-dim);
		border-bottom: 1.5px solid var(--ink-dim);
		transform: translateY(-70%) rotate(-45deg);
		transition: transform var(--dur-settle, 160ms) ease;
	}

	.area[open] summary::before {
		transform: translateY(-70%) rotate(45deg);
	}

	.area summary:focus-visible {
		outline: 2px solid var(--ink-dim);
		outline-offset: 2px;
	}

	.inside {
		margin: 0 0 8px 18px;
		padding-left: 12px;
		border-left: 1px solid var(--panel-line);
		font-size: 14px;
	}

	.inside li {
		min-height: 32px;
		font-size: 14px;
	}

	@media (prefers-reduced-motion: reduce) {
		.area summary::before {
			transition: none;
		}
	}

	/* ── where in the world ───────────────────────────────────────────── */

	/* The map across the whole panel, the lists in a row beneath it: a world
	   map is twice as wide as it is tall, so beside the lists it could only
	   ever be half their height. */
	.world {
		display: grid;
		gap: 28px;
	}

	/* ── guides ───────────────────────────────────────────────────────── */

	.guides {
		width: 100%;
		border-collapse: collapse;
		font-size: 15px;
	}

	.guides th,
	.guides td {
		height: 40px;
		padding: 0 12px 0 0;
		text-align: left;
		font-weight: 400;
		border-top: 1px solid var(--panel-line);
	}

	.guides thead th {
		height: 32px;
		border-top: 0;
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--ink-dim);
	}

	.guides th[scope='row'] {
		max-width: 0;
		width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.guides a {
		color: var(--ink);
		text-decoration: none;
	}

	.guides a:hover,
	.guides a:focus-visible {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.guides .num {
		white-space: nowrap;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--ink-mid);
	}

	.guides .done {
		width: 180px;
		padding-right: 0;
		white-space: nowrap;
	}

	.guides .done .bar {
		display: inline-block;
		width: 120px;
		vertical-align: middle;
	}

	.pct {
		display: inline-block;
		width: 4.5ch;
		margin-left: 8px;
		text-align: right;
		font-size: var(--text-xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
	}

	/* A guide nobody opened, dimmed rather than hidden: that is the finding. */
	.guides tr.is-unread a,
	.guides tr.is-unread .num {
		color: var(--ink-dim);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	.note {
		margin-top: 12px;
	}

	@media (max-width: 760px) {
		.guides .done {
			display: none;
		}
	}

	/* ── layout ───────────────────────────────────────────────────────── */

	.trio {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 28px;
	}

	/* ── who ──────────────────────────────────────────────────────────── */

	.who {
		display: grid;
		gap: 18px;
		margin: 0;
	}

	.who-row {
		display: grid;
		grid-template-columns: 110px 1fr;
		gap: 16px;
		align-items: start;
	}

	.who dt {
		padding-top: 1px;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	.who dd {
		display: grid;
		gap: 8px;
		margin: 0;
	}

	.split {
		display: flex;
		gap: 2px;
		height: 10px;
		border-radius: 2px;
		overflow: hidden;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 18px;
		font-size: 14px;
	}

	.legend i {
		display: inline-block;
		width: 8px;
		height: 8px;
		margin-right: 6px;
		border-radius: 1px;
	}

	.legend b {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.who + .sub {
		margin-top: 28px;
	}

	/* ── narrow ───────────────────────────────────────────────────────── */

	@media (max-width: 760px) {
		.trio {
			grid-template-columns: 1fr;
		}

		.path {
			grid-template-columns: repeat(3, 1fr);
			row-gap: 20px;
		}

		.path li:nth-child(3n + 1) {
			border-left: 0;
			padding-left: 0;
		}

		.step-n {
			font-size: 44px;
		}

		.people-n {
			font-size: 64px;
		}

		.figures {
			grid-template-columns: repeat(2, 1fr);
		}

		.who-row {
			grid-template-columns: 1fr;
			gap: 6px;
		}
	}
</style>
