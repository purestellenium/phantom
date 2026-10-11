<script lang="ts">
	import Log from '$lib/components/Log.svelte';
	import Sparkline from '$lib/components/dither/Sparkline.svelte';
	import type { PageProps } from './$types';

	import { ENTRY_TYPE } from '$lib/status';
	import { fragments, signedFragments } from '$lib/fragments';

	let { data }: PageProps = $props();

	const monthAwarded = $derived(data.chart.awarded.reduce((a, b) => a + b, 0));
	const monthSpent = $derived(data.chart.spent.reduce((a, b) => a + b, 0));
</script>

<svelte:head>
	<title>ledger · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">ledger</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">the whole program</h2>
	</header>

	<div class="panel-body">
		<div class="figures">
			<div class="figure">
				<span class="figure-value">{fragments(data.outstanding)}</span>
				<span class="figure-label">outstanding</span>
			</div>
			<div class="figure">
				<span class="figure-value">{fragments(data.awarded)}</span>
				<span class="figure-label">awarded</span>
			</div>
			<div class="figure">
				<span class="figure-value">{fragments(data.spent)}</span>
				<span class="figure-label">spent</span>
			</div>
			<div class="figure">
				<span class="figure-value">{fragments(data.refunded)}</span>
				<span class="figure-label">refunded</span>
			</div>
			<div class="figure">
				<span class="figure-value">{signedFragments(data.adjusted)}</span>
				<span class="figure-label">adjusted by hand</span>
			</div>
		</div>

		<!-- The last thirty days, minted and spent. -->
		<div class="ledger-charts">
			<div class="ledger-chart">
				<span class="ledger-spark"><Sparkline data={data.chart.awarded} color="green" /></span>
				<span class="ledger-caption">{fragments(monthAwarded)} awarded · 30d</span>
			</div>
			<div class="ledger-chart">
				<span class="ledger-spark"><Sparkline data={data.chart.spent} color="orange" /></span>
				<span class="ledger-caption">{fragments(monthSpent)} spent · 30d</span>
			</div>
		</div>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">entries</h2>
		<span class="panel-note">{data.log.length} shown</span>
	</header>

	<!-- A GET form, so a result set is a URL. -->
	<form class="panel-body form" method="get" data-sveltekit-reload>
		<div class="form-grid">
			<div class="form-field">
				<label class="form-label" for="person">whose</label>
				<input
					id="person"
					name="person"
					class="control-input"
					type="search"
					value={data.person ?? ''}
				/>
			</div>
			<div class="form-field">
				<label class="form-label" for="q">reason</label>
				<input id="q" name="q" class="control-input" type="search" value={data.term ?? ''} />
			</div>
		</div>
		<div class="row-actions">
			<button type="submit" class="control-btn is-small">search</button>
			<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved in the load -->
			<a class="control-btn is-small is-quiet" href={data.allHref}>all</a>
			{#each data.types as type (type.value)}
				<a class="control-btn is-small is-quiet" href={type.href}>
					{ENTRY_TYPE[type.value]} ({type.count})
				</a>
			{/each}
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
	</form>

	<div class="panel-body">
		<Log entries={data.log} />
	</div>
</section>

<style>
	.ledger-charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 16px;
		margin-top: 16px;
	}

	.ledger-chart {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ledger-spark {
		display: block;
		width: 100%;
		height: 56px;
	}

	.ledger-caption {
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}
</style>
