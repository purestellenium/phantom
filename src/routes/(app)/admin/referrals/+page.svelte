<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import DayChart from '$lib/components/dither/DayChart.svelte';
	import DitherAvatar from '$lib/components/dither/DitherAvatar.svelte';
	import { ELIGIBILITY, stamp } from '$lib/status';
	import { fragments } from '$lib/fragments';

	let { data }: PageProps = $props();

	const pending = $derived(data.glance.joined - data.glance.qualified);
	const rate = $derived(
		data.glance.joined > 0
			? `${Math.round((data.glance.qualified / data.glance.joined) * 100)}%`
			: '-'
	);

	/* Where an invitee stands: counted, or the first thing still in the way.
	   Setup before eligibility, because it is the one they can do today. */
	function standing(person: (typeof data.recent)[number]): { label: string; tone: string } {
		if (person.qualifiedAt) return { label: 'qualified', tone: 'is-good' };
		if (!person.onboarded) return { label: 'not set up', tone: 'is-waiting' };
		const eligibility = ELIGIBILITY[person.eligibility];
		return { label: eligibility.label, tone: eligibility.tone };
	}
</script>

<svelte:head>
	<title>referrals · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">referrals</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">the whole program</h2>
		<span class="panel-note">{data.glance.inviters} inviters</span>
	</header>

	<div class="panel-body">
		<div class="figures">
			<span class="figure"
				><span class="figure-value">{data.glance.joined}</span>
				<span class="figure-label">joined on a code</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.glance.qualified}</span>
				<span class="figure-label">qualified</span></span
			>
			<span class="figure"
				><span class="figure-value">{pending}</span>
				<span class="figure-label">not counting yet</span></span
			>
			<span class="figure"
				><span class="figure-value">{rate}</span>
				<span class="figure-label">of joins qualify</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.glance.joinedWeek}</span>
				<span class="figure-label">joined, past 7 days</span></span
			>
			<span class="figure"
				><span class="figure-value">{fragments(data.glance.paidSeconds)}</span>
				<span class="figure-label">paid in milestones</span></span
			>
			<span class="figure"
				><span class="figure-value">{data.glance.stickers}</span>
				<span class="figure-label">sticker orders</span></span
			>
		</div>
		<p class="panel-prose">
			Someone qualifies once they have finished setup and been found eligible. That is what the
			milestones count, and it is checked once: losing eligibility later takes nothing back.
		</p>
	</div>

	<div class="panel-body">
		<div class="referrals-plot">
			<DayChart
				days={data.glance.days}
				color="purple"
				label="People who joined on a referral code, each day for the last 90 days."
			/>
		</div>
	</div>

	<footer class="panel-foot">
		<a class="control-btn is-small is-quiet" href={resolve('/admin/funnel?source=invited')}
			>how far they get, in the funnel</a
		>
	</footer>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">milestones</h2>
		<span class="panel-note">inviters who have reached each</span>
	</header>

	<div class="panel-body">
		{#each data.milestones as milestone (milestone.count)}
			<div class="row">
				<span class="row-label">
					{milestone.count}
					{milestone.count === 1 ? 'friend' : 'friends'}
					<span class="row-hint"
						>{milestone.seconds === null
							? `custom stickers · ${data.glance.stickers} claimed`
							: `${fragments(milestone.seconds)} each`}</span
					>
				</span>
				<span class="row-value referrals-count">{milestone.reached}</span>
			</div>
		{/each}
	</div>
</section>

{#snippet inviterRow(row: (typeof data.board)[number])}
	<span class="board-rank">{row.rank}</span>
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
			><span class="board-fill" style="--share: {Math.round(row.share * 100)}%"></span></span
		>
		<span class="row-hint">
			{row.joined} joined · {row.joined - row.qualified} not counting yet · {fragments(
				row.paidSeconds
			)} paid
			{#if row.stickersClaimed}· stickers claimed{/if}
			{#if row.lastJoinedAt}· last {stamp(row.lastJoinedAt)}{/if}
		</span>
	</span>
	<span class="row-value">
		<span class="referrals-count">{row.qualified}</span>
		<span class="board-sub">qualified</span>
	</span>
{/snippet}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">the board</h2>
		<span class="panel-note">most qualified first</span>
	</header>

	<div class="panel-body">
		{#if data.board.length === 0}
			<p class="panel-prose">nobody has joined on a code yet.</p>
		{:else}
			{#each data.board as row (row.id)}
				{#if data.canOpenPeople}
					<a class="row board-row" href={resolve('/(app)/admin/users/[id]', { id: row.id })}
						>{@render inviterRow(row)}</a
					>
				{:else}
					<div class="row board-row">{@render inviterRow(row)}</div>
				{/if}
			{/each}
		{/if}
	</div>
</section>

{#snippet inviteeRow(person: (typeof data.recent)[number])}
	{@const state = standing(person)}
	<span class="row-label">
		{person.name}
		<span class="row-hint">invited by {person.inviterName} · joined {stamp(person.joinedAt)}</span>
	</span>
	<span class={['badge', state.tone]}>{state.label}</span>
{/snippet}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">recent joins</h2>
		<span class="panel-note">newest first · last {data.recent.length}</span>
	</header>

	<div class="panel-body">
		{#if data.recent.length === 0}
			<p class="panel-prose">nobody has joined on a code yet.</p>
		{:else}
			{#each data.recent as person (person.id)}
				{#if data.canOpenPeople}
					<a class="row" href={resolve('/(app)/admin/users/[id]', { id: person.id })}
						>{@render inviteeRow(person)}</a
					>
				{:else}
					<div class="row">{@render inviteeRow(person)}</div>
				{/if}
			{/each}
		{/if}
	</div>
</section>

<style>
	/* See the reviewer board: seven fixed-width tiles rather than a stretched
	   tail. */
	.figures :global(.figure) {
		flex-grow: 0;
	}

	.referrals-plot {
		height: 180px;
	}

	.referrals-count {
		font-size: var(--text-sm);
		color: var(--ink);
	}

	/* The same board as the reviewers': position, face, name, count. */
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

	.board-sub {
		display: block;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}
</style>
