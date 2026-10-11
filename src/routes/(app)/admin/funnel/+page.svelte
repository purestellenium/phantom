<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Bars from '$lib/components/dither/Bars.svelte';

	let { data }: PageProps = $props();

	function pct(rate: number | null): string {
		return rate === null ? '-' : `${Math.round(rate * 100)}%`;
	}

	const WINDOWS = [
		{ key: 'all', label: 'everyone' },
		{ key: 'month', label: 'signed up in 30 days' },
		{ key: 'week', label: 'signed up in 7 days' }
	] as const;

	/* The query for a window and a source, dropping the source when it is
	   everyone so the plain URL stays plain. */
	function query(window: string, source: string | null): string {
		const base = `window=${encodeURIComponent(window)}`;
		return source ? `${base}&source=${encodeURIComponent(source)}` : base;
	}
</script>

<svelte:head>
	<title>funnel · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">funnel</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">
			{WINDOWS.find((w) => w.key === data.window)?.label ?? 'everyone'}{#if data.source}
				· from {data.sources.find((source) => source.key === data.source)?.label}{/if}
		</h2>
		<span class="panel-note">{data.steps[0]?.n ?? 0} people</span>
	</header>

	<div class="panel-body">
		<div class="row-actions">
			{#each WINDOWS as w (w.key)}
				<a
					class={['control-btn', 'is-small', data.window !== w.key && 'is-quiet']}
					href={resolve(`/admin/funnel?${query(w.key, data.source)}`)}>{w.label}</a
				>
			{/each}
		</div>
		<!-- Who sent them: everyone, or the people a partner's ?utm_source= link brought
		     in (lib/referral.ts). Each keeps the window chosen above. -->
		<div class="row-actions">
			<a
				class={['control-btn', 'is-small', data.source !== null && 'is-quiet']}
				href={resolve(`/admin/funnel?${query(data.window, null)}`)}>any source</a
			>
			{#each data.sources as source (source.key)}
				<a
					class={['control-btn', 'is-small', data.source !== source.key && 'is-quiet']}
					href={resolve(`/admin/funnel?${query(data.window, source.key)}`)}>from {source.label}</a
				>
			{/each}
		</div>

		<div class="funnel-plot">
			<Bars items={data.steps.map((step) => ({ label: step.label, n: step.n }))} color="green" />
		</div>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">step by step</h2>
	</header>

	<div class="panel-body">
		{#each data.steps as step (step.key)}
			<div class="row">
				<span class="row-label">
					{step.label}
					<span class="row-hint"
						>{pct(step.ofTop)} of everyone · {pct(step.ofPrevious)} of the step before</span
					>
				</span>
				<span class="row-value">{step.n}</span>
			</div>
		{/each}
	</div>
</section>

<!-- Time logged, of the people who linked Hackatime, from the daily totals the
     hackatime.activity job keeps (lib/server/activity.ts). Same window and
     source as above. -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">hours logged</h2>
		<span class="panel-note">{data.hours.linked} linked hackatime</span>
	</header>

	<div class="panel-body">
		<div class="funnel-plot">
			<Bars
				items={data.hours.steps.map((step) => ({ label: step.label, n: step.n }))}
				color="blue"
			/>
		</div>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">hours, step by step</h2>
	</header>

	<div class="panel-body">
		{#each data.hours.steps as step (step.key)}
			<div class="row">
				<span class="row-label">
					{step.label}
					<span class="row-hint"
						>{pct(step.ofTop)} of linked{#if step.ofPrevious !== null}
							· {pct(step.ofPrevious)} of the step before{/if}</span
					>
				</span>
				<span class="row-value">{step.n}</span>
			</div>
		{/each}
	</div>
</section>

<style>
	.funnel-plot {
		height: 160px;
		margin-top: 16px;
	}
</style>
