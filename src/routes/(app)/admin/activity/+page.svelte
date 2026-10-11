<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import DayChart from '$lib/components/dither/DayChart.svelte';
	import DitherAvatar from '$lib/components/dither/DitherAvatar.svelte';
	import { hours } from '$lib/status';

	let { data }: PageProps = $props();

	const RANGES = [
		{ key: '30', label: '30 days' },
		{ key: '90', label: '90 days' },
		{ key: 'all', label: 'since it started' }
	] as const;

	function query(range: string, day: string | null): string {
		const base = `range=${encodeURIComponent(range)}`;
		return day ? `${base}&day=${encodeURIComponent(day)}` : base;
	}

	function open(day: string) {
		void goto(resolve(`/admin/activity?${query(data.range, day)}`), {
			noScroll: true,
			keepFocus: true,
			replaceState: true
		});
	}

	function long(day: string): string {
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}

	function signed(n: number): string {
		return n > 0 ? `+${n}` : `${n}`;
	}

	const days = $derived(data.series.days);
	/* The series runs through today, so its last day is today by the server's
	   clock - not the browser's, which can be either side of midnight UTC. */
	const today = $derived(days.at(-1)?.day ?? null);

	/* Trailing seven-day mean, over however many days the range has before
	   each one, so the line starts with the chart rather than a week in. */
	const trend = $derived(
		days.map((_, i) => {
			const window = days.slice(Math.max(0, i - 6), i + 1);
			return window.reduce((sum, d) => sum + d.active, 0) / window.length;
		})
	);

	const chartDays = $derived(
		days.map((d) => ({
			day: d.day,
			n: d.active,
			hint: `${d.fresh} new · ${hours(d.seconds)}`
		}))
	);

	const peak = $derived(
		days.reduce<(typeof days)[number] | null>(
			(best, d) => (best === null || d.active > best.active ? d : best),
			null
		)
	);
	const mean = $derived(
		days.length === 0 ? 0 : days.reduce((sum, d) => sum + d.active, 0) / days.length
	);
	const busiest = $derived(Math.max(1, ...days.map((d) => d.active)));

	const at = $derived(data.day === null ? -1 : days.findIndex((d) => d.day === data.day));
	const current = $derived(at >= 0 ? days[at] : null);
	const before = $derived(at > 0 ? days[at - 1] : null);
	const after = $derived(at >= 0 && at < days.length - 1 ? days[at + 1] : null);
	const weekAgo = $derived(at >= 7 ? days[at - 7] : null);

	/* Newest first for reading down, which is the order someone checking on
	   the program wants. */
	const newestFirst = $derived([...days].reverse());
</script>

<svelte:head>
	<title>daily active · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">daily active</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">at a glance</h2>
		<span class="panel-note">UTC days</span>
	</header>

	<div class="panel-body">
		<div class="figures">
			<span class="figure"
				><span class="figure-value">{data.glance.today}</span>
				<span class="figure-label">today so far</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.glance.yesterday}</span>
				<span class="figure-label">yesterday</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.glance.week}</span>
				<span class="figure-label">past 7 days</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.glance.month}</span>
				<span class="figure-label">past 30 days</span></span
			>
		</div>
		<p class="panel-prose">
			Active means a Hackatime heartbeat that day in a project linked to Phantom. The 7- and 30-day
			figures count distinct people, not a sum of days.
		</p>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">day by day</h2>
		<span class="panel-note"
			>{data.series.distinct} people · peak {peak?.active ?? 0} · {mean.toFixed(1)} a day</span
		>
	</header>

	<div class="panel-body">
		<div class="row-actions activity-ranges">
			{#each RANGES as r (r.key)}
				<a
					class={['control-btn', 'is-small', data.range !== r.key && 'is-quiet']}
					href={resolve(`/admin/activity?${query(r.key, data.day)}`)}
					data-sveltekit-noscroll>{r.label}</a
				>
			{/each}
		</div>

		<div class="activity-plot">
			<DayChart
				days={chartDays}
				{trend}
				selected={data.day}
				color="blue"
				label="Daily active users. Arrow keys move between days."
				onpick={open}
			/>
		</div>
		<p class="activity-key">
			<span class="activity-swatch is-bars"></span>active that day
			<span class="activity-swatch is-line"></span>7-day average
			<span class="activity-tip">hover for a day, click or use the arrow keys to open it</span>
		</p>
	</div>
</section>

{#if current}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">{long(current.day)}</h2>
			<span class="panel-note activity-step">
				{#if before}
					<a
						class="control-btn is-small is-quiet"
						href={resolve(`/admin/activity?${query(data.range, before.day)}`)}
						data-sveltekit-noscroll
						data-sveltekit-replacestate>← day before</a
					>
				{/if}
				{#if after}
					<a
						class="control-btn is-small is-quiet"
						href={resolve(`/admin/activity?${query(data.range, after.day)}`)}
						data-sveltekit-noscroll
						data-sveltekit-replacestate>day after →</a
					>
				{/if}
			</span>
		</header>

		<div class="panel-body">
			<div class="figures">
				<span class="figure"
					><span class="figure-value">{current.active}</span>
					<span class="figure-label"
						>active{#if current.day === today}, so far{/if}</span
					></span
				>
				<span class="figure"
					><span class="figure-value">{current.fresh}</span>
					<span class="figure-label">first active day</span></span
				>
				<span class="figure"
					><span class="figure-value">{current.active - current.fresh}</span>
					<span class="figure-label">returning</span></span
				>
				<span class="figure"
					><span class="figure-value">{hours(current.seconds)}</span>
					<span class="figure-label">logged</span></span
				>
				<span class="figure"
					><span class="figure-value"
						>{current.active > 0 ? hours(current.seconds / current.active) : '-'}</span
					>
					<span class="figure-label">per active person</span></span
				>
			</div>

			<div class="activity-compare">
				<div class="row is-full">
					<span class="row-label">
						against the day before
						<span class="row-hint"
							>{before
								? `${before.active} then, ${signed(current.active - before.active)}`
								: '-'}</span
						>
					</span>
				</div>
				<div class="row is-full">
					<span class="row-label">
						against a week earlier
						<span class="row-hint"
							>{weekAgo
								? `${weekAgo.active} on ${long(weekAgo.day)}, ${signed(current.active - weekAgo.active)}`
								: '-'}</span
						>
					</span>
				</div>
				<div class="row is-full">
					<span class="row-label">
						against the 7-day average
						<span class="row-hint"
							>{trend[at].toFixed(1)} a day, {signed(
								Math.round((current.active - trend[at]) * 10) / 10
							)}</span
						>
					</span>
				</div>
			</div>

			<p class="panel-prose">
				{current.checked}
				{current.checked === 1 ? 'person' : 'people'} checked for this day.{#if current.day === today}
					The day is not over, and heartbeats sent late still land in it, so this only rises.{/if}
			</p>
		</div>
	</section>

	{#if data.people}
		<section class="panel">
			<header class="panel-head">
				<h2 class="panel-title">who</h2>
				<span class="panel-note">most time first</span>
			</header>

			<div class="panel-body">
				{#if data.people.length === 0}
					<p class="panel-prose">nobody was active on this day.</p>
				{:else}
					{#each data.people as person (person.id)}
						<a class="row person-row" href={resolve('/(app)/admin/users/[id]', { id: person.id })}>
							<span class="person-face">
								{#if person.avatarUrl}
									<img class="person-img" src={person.avatarUrl} alt="" />
								{:else}
									<DitherAvatar name={person.name} class="person-img" />
								{/if}
							</span>
							<span class="row-label">
								{person.name}
								{#if person.fresh}<span class="badge is-good person-badge">first day</span>{/if}
							</span>
							<span class="row-value">{hours(person.seconds)}</span>
						</a>
					{/each}
				{/if}
			</div>
		</section>
	{/if}
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">every day</h2>
		<span class="panel-note">newest first</span>
	</header>

	<div class="panel-body activity-list">
		{#each newestFirst as d (d.day)}
			<a
				class="row"
				href={resolve(`/admin/activity?${query(data.range, d.day)}`)}
				aria-current={d.day === data.day ? 'true' : undefined}
				data-sveltekit-replacestate
			>
				<span class="row-label">
					{long(d.day)}
					<span class="activity-bar"
						><span class="activity-fill" style="--share: {Math.round((d.active / busiest) * 100)}%"
						></span></span
					>
					<span class="row-hint"
						>{d.fresh} new · {hours(d.seconds)} logged · {d.checked} checked</span
					>
				</span>
				<span class="row-value activity-count">{d.active}</span>
			</a>
		{/each}
	</div>
</section>

<style>
	.activity-ranges {
		justify-content: flex-start;
	}

	.activity-plot {
		height: 260px;
	}

	.activity-key {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	.activity-swatch {
		display: inline-block;
		width: 12px;
	}

	.activity-swatch.is-bars {
		height: 10px;
		background-color: rgb(53 143 243 / 0.75);
	}

	.activity-swatch.is-line {
		height: 2px;
		background-color: rgb(150 200 255);
	}

	.activity-tip {
		margin-left: auto;
	}

	.activity-step {
		display: flex;
		gap: 8px;
	}

	.activity-compare {
		display: flex;
		flex-direction: column;
	}

	.person-row {
		grid-template-columns: auto 1fr auto;
	}

	.person-face {
		display: flex;
		flex: none;
		align-items: center;
	}

	.person-face :global(.person-img) {
		width: 28px;
		height: 28px;
	}

	.person-badge {
		margin-left: 8px;
	}

	.activity-list {
		gap: 2px;
	}

	.activity-list .row[aria-current='true'] {
		background-color: var(--level-raise);
		border-color: var(--panel-line);
		background-image: var(--weave-bayer-hard), var(--shade-raised);
	}

	/* The same track-and-fill as the reviewer board: the empty part is what
	   makes a short bar read as a proportion. */
	.activity-bar {
		display: block;
		width: 100%;
		max-width: 320px;
		height: 6px;
		margin: 6px 0 2px;
		background-color: var(--level-surface);
	}

	.activity-fill {
		display: block;
		width: var(--share, 0%);
		height: 100%;
		background-color: var(--level-raise);
		background-image: var(--weave-bayer-hard);
	}

	.activity-count {
		font-size: var(--text-sm);
		color: var(--ink);
	}
</style>
