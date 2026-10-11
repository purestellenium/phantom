<script lang="ts">
	/**
	 * Where people go next. Pick a starting point - a page, a whole section, an
	 * event - and the next column ranks what those people did straight after;
	 * pick one of those and the column after that, and so on. Turned around, it
	 * starts from an end point and walks back to how people got there.
	 *
	 * Underneath, the path picked so far as a funnel: how many made each step,
	 * and how many were lost along the way.
	 *
	 * Fetched a column at a time from ./journey (lib/server/plausible-stats.ts,
	 * `journey`), as the columns are opened.
	 */
	import { untrack } from 'svelte';

	import { resolve } from '$app/paths';
	import PixelIcon from '$lib/components/PixelIcon.svelte';
	import { PALETTE, rgb } from '$lib/dither-kit/palette';
	import type { DateRange, Journey, JourneyStep } from '$lib/server/plausible-stats';

	let { range }: { range: DateRange } = $props();

	const END = '__journey_end__';
	const MAX_STEPS = 5;

	type Column = { rows: Journey['next'] | null; failed: boolean; search: string };

	let direction = $state<'forward' | 'backward'>('forward');
	let picked = $state<JourneyStep[]>([]);
	let columns = $state<Column[]>([]);
	let funnel = $state<Journey['funnel']>([]);
	/* Answers to an older question are dropped: a quick second click must not
	   be overwritten by the first one's slower reply. */
	let asked = 0;

	async function load(index: number) {
		const ticket = ++asked;
		const steps = picked.slice(0, index);
		try {
			const response = await fetch(resolve('/admin/analytics/journey'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ range, steps, direction, search: columns[index]?.search ?? '' })
			});
			if (!response.ok) throw new Error(String(response.status));
			const answer = (await response.json()) as Journey;
			if (ticket !== asked) return;
			columns[index] = { ...columns[index], rows: answer.next, failed: false };
			if (steps.length > 0) funnel = answer.funnel;
		} catch {
			if (ticket !== asked) return;
			columns[index] = { ...columns[index], rows: [], failed: true };
		}
	}

	function restart() {
		picked = [];
		funnel = [];
		columns = [{ rows: null, failed: false, search: '' }];
		load(0);
	}

	/* A new range or a new direction is a new question from the start. Only
	   those two are tracked: restarting reads and writes the columns, and an
	   effect that tracked them would restart itself forever. */
	$effect(() => {
		void range;
		void direction;
		untrack(restart);
	});

	function pick(index: number, step: JourneyStep) {
		if (step.name === END) return;
		picked = [...picked.slice(0, index), step];
		columns = [...columns.slice(0, index + 1)];
		if (picked.length < MAX_STEPS) {
			columns.push({ rows: null, failed: false, search: '' });
			load(index + 1);
		}
	}

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function searched(index: number, value: string) {
		columns[index].search = value;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => load(index), 250);
	}

	const same = (a: JourneyStep | undefined, b: JourneyStep) =>
		!!a &&
		a.name === b.name &&
		a.pathname === b.pathname &&
		a.includes_subpaths === b.includes_subpaths;

	function label(step: JourneyStep): string {
		if (step.name === END) return direction === 'forward' ? 'left the site' : 'arrived here first';
		if (step.includes_subpaths) return `${step.pathname === '/' ? '' : step.pathname}/…`;
		return step.label;
	}

	function heading(index: number): string {
		if (index === 0) return direction === 'forward' ? 'starting point' : 'end point';
		const word = direction === 'forward' ? 'after' : 'before';
		return `${index} step${index === 1 ? '' : 's'} ${word}`;
	}

	const accent = rgb(PALETTE.blue.fill);
</script>

<div class="journeys" style:--accent={accent}>
	<div class="row-actions">
		<button
			class={['control-btn', 'is-small', direction !== 'forward' && 'is-quiet']}
			aria-pressed={direction === 'forward'}
			onclick={() => (direction = 'forward')}>from a starting point</button
		>
		<button
			class={['control-btn', 'is-small', direction !== 'backward' && 'is-quiet']}
			aria-pressed={direction === 'backward'}
			onclick={() => (direction = 'backward')}>back from an end point</button
		>
	</div>

	<div class="columns">
		{#each columns as column, index (index)}
			{@const top = Math.max(1, ...(column.rows ?? []).map((r) => r.visitors))}
			<section class="column" aria-label={heading(index)}>
				<header>
					<h3>{heading(index)}</h3>
					{#if index === columns.length - 1}
						<input
							type="search"
							placeholder="search"
							aria-label="Search {heading(index)}"
							value={column.search}
							oninput={(event) => searched(index, event.currentTarget.value)}
						/>
					{/if}
				</header>

				{#if column.rows === null}
					<p class="quiet">Loading…</p>
				{:else if column.failed}
					<p class="quiet">Plausible didn't answer. Pick the step again to retry.</p>
				{:else if column.rows.length === 0}
					<p class="quiet">
						{index === 0 ? 'Nothing in this range.' : 'Nobody went further.'}
					</p>
				{:else}
					<ol>
						{#each column.rows as row (row.step.name + row.step.pathname + row.step.includes_subpaths)}
							<li>
								<button
									class={[
										'step',
										same(picked[index], row.step) && 'is-picked',
										row.step.name === END && 'is-end'
									]}
									disabled={row.step.name === END}
									onclick={() => pick(index, row.step)}
								>
									<span class="icon" aria-hidden="true">
										<PixelIcon
											size={12}
											name={row.step.name === END
												? 'circle'
												: row.step.includes_subpaths
													? 'book'
													: row.step.name === 'pageview'
														? 'file'
														: 'check'}
										/>
									</span>
									<span class="name">
										{label(row.step)}
										{#if row.step.includes_subpaths}
											<span class="quiet">{row.step.subpaths_count} pages</span>
										{/if}
									</span>
									<span class="bar" aria-hidden="true"
										><span style:width="{(row.visitors / top) * 100}%"></span></span
									>
									<span class="n">{row.visitors}</span>
								</button>
							</li>
						{/each}
					</ol>
				{/if}
			</section>
		{/each}

		<!-- The space the next columns will open into, holding the way in until
		     there are three to read. -->
		{#if columns.length < 3 && columns.at(-1)?.rows?.length && picked.length < MAX_STEPS}
			<div class="next" style:grid-column="span {3 - columns.length}">
				<img src="/images/journey-bird.png" alt="" width="144" height="120" />
				<p>
					{#if picked.length === 0}
						Click {direction === 'forward' ? 'a starting point' : 'an end point'} to see what people did
						{direction === 'forward' ? 'next' : 'just before'}.
					{:else}
						Click a step to keep following them.
					{/if}
				</p>
			</div>
		{/if}
	</div>

	{#if funnel.length > 0}
		{@const first = Math.max(1, funnel[0].visitors)}
		<section class="funnel" aria-label="The path picked, as a funnel">
			<h3>the path you picked</h3>
			<ol>
				{#each funnel as stage, i (i)}
					<li>
						<span class="name">{label(stage.step)}</span>
						<span class="bar" aria-hidden="true"
							><span style:width="{(stage.visitors / first) * 100}%"></span></span
						>
						<span class="n">{stage.visitors}</span>
						<span class="kept">
							{#if i === 0}
								everyone here
							{:else}
								{Math.round(Number(stage.conversion_rate))}% of the start{#if stage.dropoff > 0},
									{stage.dropoff} lost{/if}
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		</section>
	{/if}
</div>

<style>
	.journeys {
		display: grid;
		gap: 18px;
	}

	.journeys > .row-actions {
		justify-content: flex-start;
	}

	.quiet {
		margin: 0;
		color: var(--ink-dim);
		font-size: var(--text-xs);
	}

	h3 {
		margin: 0;
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--ink-dim);
	}

	/* ── the columns ──────────────────────────────────────────────────── */

	/* Three across, then scrolling sideways: the newest column is the one
	   being read, and the ones before it stay a swipe away. */
	.columns {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(260px, calc((100% - 32px) / 3));
		gap: 16px;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scroll-snap-type: x proximity;
	}

	.column {
		display: grid;
		align-content: start;
		gap: 10px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--panel-line);
		border-radius: 8px;
		scroll-snap-align: end;
	}

	.column header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 30px;
	}

	.column input {
		width: 110px;
		padding: 4px 8px;
		font: inherit;
		font-size: var(--text-xs);
		color: var(--ink);
		background: var(--level-lift);
		border: 1px solid var(--panel-line);
		border-radius: 6px;
	}

	.column ol {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 420px;
		overflow-y: auto;
	}

	/* ── the way in ───────────────────────────────────────────────────── */

	.next {
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 14px;
		min-height: 240px;
		padding: 24px;
		text-align: center;
		border: 1px dashed var(--panel-line);
		border-radius: 8px;
	}

	.next img {
		width: 144px;
		height: auto;
		image-rendering: pixelated;
	}

	.next p {
		max-width: 26ch;
		margin: 0;
		font-size: 15px;
		line-height: 1.45;
		color: var(--ink-mid);
	}

	.step {
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) 56px 3ch;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 36px;
		padding: 0 8px;
		font: inherit;
		font-size: 14px;
		text-align: left;
		color: var(--ink);
		background: none;
		border: 0;
		border-radius: 6px;
		cursor: pointer;
	}

	.step:hover {
		background: color-mix(in srgb, var(--ink) 6%, transparent);
	}

	.step:focus-visible {
		outline: 2px solid var(--ink-dim);
		outline-offset: -2px;
	}

	.step.is-picked {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.step.is-end {
		cursor: default;
		color: var(--ink-dim);
	}

	.step.is-end:hover {
		background: none;
	}

	.icon {
		display: inline-flex;
		color: var(--ink-dim);
	}

	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.name .quiet {
		margin-left: 6px;
	}

	/* The same dithered bar as the page's lists. */
	.bar {
		height: 6px;
		background: color-mix(in srgb, var(--ink) 6%, transparent);
	}

	.bar > span {
		display: block;
		height: 100%;
		min-width: 2px;
		background-image: repeating-conic-gradient(var(--accent) 0 25%, transparent 0 50%);
		background-size: 4px 4px;
	}

	.n {
		text-align: right;
		color: var(--ink-mid);
		font-variant-numeric: tabular-nums;
	}

	/* ── the funnel ───────────────────────────────────────────────────── */

	.funnel {
		display: grid;
		gap: 8px;
		padding-top: 16px;
		border-top: 1px solid var(--panel-line);
	}

	.funnel ol {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.funnel li {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(80px, 1fr) 4ch minmax(0, 1.2fr);
		align-items: center;
		gap: 14px;
		min-height: 38px;
		font-size: 15px;
	}

	.funnel li + li {
		border-top: 1px solid var(--panel-line);
	}

	.funnel .bar {
		height: 8px;
	}

	.kept {
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	@media (max-width: 760px) {
		.columns {
			grid-auto-columns: 85%;
		}

		.next {
			display: none;
		}

		.funnel li {
			grid-template-columns: minmax(0, 1fr) 60px 4ch;
		}

		.kept {
			grid-column: 1 / -1;
			margin-top: -8px;
			padding-bottom: 8px;
		}
	}
</style>
