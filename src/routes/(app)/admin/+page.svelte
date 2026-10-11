<script lang="ts">
	import type { PageProps } from './$types';
	import type { SectionKey } from './+page.server';

	import Bars from '$lib/components/dither/Bars.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import Sparkline from '$lib/components/dither/Sparkline.svelte';
	import { stamp } from '$lib/status';
	import { fragments } from '$lib/fragments';

	let { data }: PageProps = $props();

	/* Pixel icons: twelve by twelve cells, drawn as rects, so they are made of
	   the same material as everything else on the page rather than a crisp
	   vector sitting on top of it. */
	const ICONS: Record<SectionKey, string[]> = {
		users: [
			'....####....',
			'...######...',
			'...######...',
			'...######...',
			'....####....',
			'............',
			'..########..',
			'.##########.',
			'############',
			'############',
			'############',
			'############'
		],
		activity: [
			'............',
			'..........#.',
			'..........#.',
			'.....#....#.',
			'.....#...##.',
			'....##...#..',
			'#...#.#..#..',
			'##..#.#.#...',
			'.#.#..#.#...',
			'.#.#...##...',
			'..##...#....',
			'............'
		],
		catalog: [
			'............',
			'.#########..',
			'.#.......#..',
			'.#.......##.',
			'.#........#.',
			'.#........#.',
			'.#........#.',
			'.#........#.',
			'.#........#.',
			'.#........#.',
			'.##########.',
			'............'
		],
		orders: [
			'............',
			'.##########.',
			'.#........#.',
			'.#..####..#.',
			'.#........#.',
			'.#........#.',
			'.#..####..#.',
			'.#........#.',
			'.#..##....#.',
			'.#........#.',
			'.##########.',
			'............'
		],
		projects: [
			'............',
			'.####.......',
			'.#..#.......',
			'.####.......',
			'............',
			'.####.####..',
			'.#..#.#..#..',
			'.####.####..',
			'............',
			'.####.####.#',
			'.#..#.#..#.#',
			'.####.####.#'
		],
		referrals: [
			'............',
			'..##....##..',
			'.####..####.',
			'.####..####.',
			'..##....##..',
			'............',
			'.####..####.',
			'######.#####',
			'######.#####',
			'######.#####',
			'............',
			'............'
		],
		funnel: [
			'############',
			'#..........#',
			'.#........#.',
			'.#........#.',
			'..#......#..',
			'..#......#..',
			'...#....#...',
			'...#....#...',
			'....#..#....',
			'....#..#....',
			'....#..#....',
			'....####....'
		],
		analytics: [
			'............',
			'..........#.',
			'.........#..',
			'........#...',
			'..#....#....',
			'.#.#..#.....',
			'#...##......',
			'............',
			'#.#.#.#.#.#.',
			'#.#.#.#.#.#.',
			'#.#.#.#.#.#.',
			'############'
		],
		reviewers: [
			'............',
			'..######....',
			'..#....#....',
			'..#.##.#....',
			'..#....#....',
			'..#.##.#..#.',
			'..#......##.',
			'..#....###..',
			'..######.#..',
			'.........#..',
			'............',
			'............'
		],
		ledger: [
			'............',
			'............',
			'..........#.',
			'........###.',
			'......#####.',
			'....#######.',
			'..#########.',
			'############',
			'............',
			'############',
			'............',
			'............'
		],
		reconcile: [
			'............',
			'....####....',
			'...#....#...',
			'..#......#..',
			'..#..##..#..',
			'..#..##..#..',
			'..#......#..',
			'...#....#...',
			'....####....',
			'.......##...',
			'........##..',
			'.........##.'
		],
		outbox: [
			'............',
			'.##########.',
			'.##......##.',
			'.#.#....#.#.',
			'.#..#..#..#.',
			'.#...##...#.',
			'.#........#.',
			'.#........#.',
			'.#........#.',
			'.##########.',
			'............',
			'............'
		],
		ari: [
			'............',
			'....####....',
			'...#....#...',
			'..#......#..',
			'..#......#..',
			'..########..',
			'..#......#..',
			'..#......#..',
			'..#......#..',
			'..#......#..',
			'............',
			'............'
		],
		jobs: [
			'....####....',
			'..##....##..',
			'.#........#.',
			'.#....#...#.',
			'#.....#....#',
			'#.....#....#',
			'#.....###..#',
			'#..........#',
			'.#........#.',
			'.#........#.',
			'..##....##..',
			'....####....'
		],
		audit: [
			'............',
			'..########..',
			'..#......#..',
			'..#.####.#..',
			'..#......#..',
			'..#.####.#..',
			'..#......#..',
			'..#.####.#..',
			'..#......#..',
			'..#.##...#..',
			'..########..',
			'............'
		],
		settings: [
			'....####....',
			'...#....#...',
			'.###....###.',
			'#..........#',
			'#...####...#',
			'.#..#..#..#.',
			'.#..#..#..#.',
			'#...####...#',
			'#..........#',
			'.###....###.',
			'...#....#...',
			'....####....'
		]
	};

	const orderBars = $derived([
		{ label: 'placed', n: data.orders.placed },
		{ label: 'on hold', n: data.orders.on_hold },
		{ label: 'fulfilled', n: data.orders.fulfilled },
		{ label: 'unfulfilled', n: data.orders.unfulfilled },
		{ label: 'rejected', n: data.orders.rejected },
		{ label: 'cancelled', n: data.orders.cancelled }
	]);
	/* Drafts first, because they are the reason the page exists: nothing else in
	   the application can see a project that has never been shipped. */
	const projectBars = $derived([
		{ label: 'draft', n: data.projects.draft },
		{ label: 'in review', n: data.projects.review },
		{ label: 'approved', n: data.projects.approved },
		{ label: 'rejected', n: data.projects.rejected }
	]);
	const outboxBars = $derived([
		{ label: 'pending', n: data.outbox.pending },
		{ label: 'delivered', n: data.outbox.delivered },
		{ label: 'retryable', n: data.outbox.retryable },
		{ label: 'failed', n: data.outbox.failed },
		{ label: 'ambiguous', n: data.outbox.ambiguous }
	]);
	const openOrders = $derived(data.orders.placed + data.orders.on_hold);
	/* Four of the seven steps, the ones a card has room for. */
	const funnelBars = $derived(
		data.funnel
			.filter((step) => ['signed_up', 'onboarded', 'shipped', 'approved'].includes(step.key))
			.map((step) => ({ label: step.label, n: step.n }))
	);
	/* Of everyone who came in on a code, the share who went on to count. */
	const referralRate = $derived(
		data.referrals.joined > 0
			? `${Math.round((data.referrals.qualified / data.referrals.joined) * 100)}%`
			: '-'
	);
</script>

<svelte:head>
	<title>console · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">console</h1>
</header>

{#if !data.launched}
	<Notice title="the site is closed to participants" body="the switch is in settings." />
{/if}

{#if data.stuck > 0 && data.canRunJobs}
	<Notice
		bad
		title="{data.stuck} outbox {data.stuck === 1 ? 'row needs' : 'rows need'} attention"
	/>
{/if}

{#snippet icon(key: SectionKey)}
	<svg class="dash-icon" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">
		{#each ICONS[key] as row, y (y)}
			{#each row.split('') as cell, x (x)}
				{#if cell === '#'}<rect {x} {y} width="1" height="1" />{/if}
			{/each}
		{/each}
	</svg>
{/snippet}

<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved in the load, see SECTIONS there -->
<div class="cards dash">
	{#each data.sections as section (section.key)}
		<svelte:element
			this={section.href ? 'a' : 'div'}
			class={['card', section.href && 'card-link', 'dash-card']}
			href={section.href}
		>
			<span class="dash-head">
				{@render icon(section.key)}
				<h3>{section.label}</h3>
				<span class="dash-figure">
					{#if section.key === 'users'}{data.people}
					{:else if section.key === 'activity'}{data.activity.today} today
					{:else if section.key === 'catalog'}{data.catalog.active}
					{:else if section.key === 'orders'}{openOrders} open
					{:else if section.key === 'projects'}{data.projects.all}
					{:else if section.key === 'referrals'}{data.referrals.joined} joined
					{:else if section.key === 'funnel'}{data.funnel.find((s) => s.key === 'approved')?.n ?? 0} approved
					{:else if section.key === 'analytics'}plausible
					{:else if section.key === 'reviewers'}{data.reviewers.week} / 7d
					{:else if section.key === 'ledger'}{fragments(data.ledger.outstanding)}
					{:else if section.key === 'outbox'}{data.stuck} stuck
					{:else if section.key === 'ari'}{data.ariAttention} to look at
					{:else if section.key === 'jobs'}{data.quiet} quiet
					{:else if section.key === 'audit'}{data.audit.days.reduce((a, b) => a + b, 0)} / 14d
					{:else if section.key === 'settings'}{data.launched ? 'open' : 'closed'}
					{/if}
				</span>
			</span>

			<span class="dash-preview">
				{#if section.key === 'users'}
					<span class="dash-spark"><Sparkline data={data.weekly} color="green" /></span>
					<span class="dash-caption">signups, last 8 weeks</span>
				{:else if section.key === 'activity'}
					<span class="dash-spark"><Sparkline data={data.activity.days} color="blue" /></span>
					<span class="dash-caption"
						>{data.activity.yesterday} yesterday · {data.activity.week} / 7d · {data.activity.month} /
						30d</span
					>
				{:else if section.key === 'catalog'}
					<span class="dash-list">
						{#each data.catalog.names as name, i (i)}<span>{name}</span>{/each}
					</span>
					<span class="dash-caption"
						>{data.catalog.active} of {data.catalog.total} listed · {data.catalog.soldOut} sold out</span
					>
				{:else if section.key === 'orders'}
					<Bars items={orderBars} color="blue" />
				{:else if section.key === 'projects'}
					<Bars items={projectBars} color="green" />
					<span class="dash-caption">{data.projects.draft} never shipped</span>
				{:else if section.key === 'referrals'}
					<span class="dash-spark"
						><Sparkline data={data.referrals.days.map((d) => d.n)} color="purple" /></span
					>
					<span class="dash-caption">joins on a code, last 30 days</span>
					<span class="dash-caption"
						>{data.referrals.qualified} qualified · {referralRate} of joins · {data.referrals
							.joinedWeek} / 7d</span
					>
					<span class="dash-caption"
						>{fragments(data.referrals.paidSeconds)} paid · {data.referrals.stickers} stickers · {data
							.referrals.inviters} inviters</span
					>
				{:else if section.key === 'funnel'}
					<Bars items={funnelBars} color="green" />
				{:else if section.key === 'analytics'}
					<span class="dash-caption">visitors, pages, sources and every tracked event</span>
				{:else if section.key === 'reviewers'}
					<span class="dash-list">
						{#each data.reviewers.top as person (person.name)}
							<span
								><span class="dash-run">{person.name}</span>
								<span class="dash-muted">{person.n}</span></span
							>
						{:else}
							<span class="dash-muted">nothing sent to airtable yet</span>
						{/each}
					</span>
				{:else if section.key === 'ledger'}
					<span class="dash-spark"><Sparkline data={data.ledger.days} color="orange" /></span>
					<span class="dash-caption"
						>{fragments(data.ledger.awarded)} awarded · {fragments(data.ledger.spent)} spent</span
					>
				{:else if section.key === 'reconcile'}
					<span class="dash-caption">integrity queries; reports, never repairs</span>
				{:else if section.key === 'outbox'}
					<Bars items={outboxBars} color="purple" />
				{:else if section.key === 'jobs'}
					<span class="dash-list">
						{#each data.runs.slice(0, 4) as run (run.id)}
							<span
								><span class="dash-run">{run.name}</span>
								<span class="dash-muted">{run.status} · {stamp(run.startedAt)}</span></span
							>
						{:else}
							<span class="dash-muted">nothing has ever run</span>
						{/each}
					</span>
				{:else if section.key === 'audit'}
					<span class="dash-spark"><Sparkline data={data.audit.days} color="pink" /></span>
					<span class="dash-list">
						{#each data.audit.recent as event (event.id)}
							<span
								><span class="dash-run">{event.action}</span>
								<span class="dash-muted">{stamp(event.createdAt)}</span></span
							>
						{/each}
					</span>
				{:else if section.key === 'settings'}
					<span class="dash-badges">
						<span class={['badge', data.launched ? 'is-good' : 'is-bad']}
							>{data.launched ? 'launched' : 'closed'}</span
						>
						<span class={['badge', data.shopOpen ? 'is-good' : 'is-waiting']}
							>shop {data.shopOpen ? 'open' : 'closed'}</span
						>
					</span>
				{/if}
			</span>
		</svelte:element>
	{/each}
</div>

<style>
	.dash {
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	}

	.dash-card {
		gap: 12px;
		min-height: 168px;
	}

	.dash-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.dash-head h3 {
		flex: 1 1 auto;
		min-width: 0;
	}

	.dash-icon {
		width: 24px;
		height: 24px;
		flex: none;
		fill: var(--ink);
	}

	.dash-figure {
		flex: none;
		font-size: var(--text-xs);
		color: var(--ink);
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		white-space: nowrap;
	}

	.dash-preview {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: auto;
	}

	/* The series: the kit's sparkline in a box. */
	.dash-spark {
		display: block;
		width: 100%;
		height: 44px;
	}

	.dash-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: var(--text-xs);
		color: var(--ink);
	}

	.dash-list > span {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.dash-run {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dash-muted,
	.dash-caption {
		font-size: var(--text-xs);
		color: var(--ink-dim);
		white-space: nowrap;
	}

	.dash-badges {
		display: flex;
		gap: 8px;
	}
</style>
