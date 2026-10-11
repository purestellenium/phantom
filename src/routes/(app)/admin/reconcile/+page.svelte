<script lang="ts">
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>reconcile · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">reconcile</h1>
	<p class="page-lede">read-only. these report; they never repair.</p>
</header>

{#if data.anything}
	<Notice
		bad
		title="{data.findings.filter((finding) => finding.count > 0).length} checks found something"
		body="fix by appending an adjustment on the person’s own page, quoting the check’s name in the reason. never by editing a balance."
	/>
{:else}
	<Notice
		title="everything agrees"
		body="every entry has a source, every source produced its entries once, and the cached balances match a replay."
	/>
{/if}

{#each data.findings as finding (finding.id)}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">{finding.title}</h2>
			<span class={['badge', finding.count > 0 ? 'is-bad' : 'is-good']}>{finding.count}</span>
		</header>

		<div class="panel-body">
			<p class="panel-prose">{finding.meaning}</p>

			{#if finding.sample.length > 0}
				<pre class="console-pre">{finding.sample.join('\n')}</pre>
			{/if}

			{#if finding.count > finding.sample.length}
				<span class="form-hint">showing {finding.sample.length} of {finding.count}.</span>
			{/if}
		</div>
	</section>
{/each}
