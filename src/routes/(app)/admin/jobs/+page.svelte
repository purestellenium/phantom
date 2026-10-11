<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';
	import { stamp } from '$lib/status';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>jobs · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">jobs</h1>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

{#if !data.configured}
	<Notice
		bad
		title="nothing is running on a schedule"
		body="CRON_SECRET is not set, so /api/jobs/run answers 404 and no scheduler can reach it. sessions are not being swept, the outbox is not being delivered, and the integrity checks are not running. the buttons below still work by hand."
	/>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">what there is</h2>
	</header>

	<div class="panel-body">
		{#each data.jobs as job (job.name)}
			<div class="row">
				<span class="row-label">
					{job.name}
					<span class="row-hint">
						{job.description}{job.last
							? ` · last ran ${stamp(job.last.startedAt)} (${job.last.status})`
							: ' · never run'}
					</span>
				</span>
				<span class="row-actions">
					{#if job.quiet}<span class="badge is-bad">quiet</span>{/if}
					<form method="POST" action="?/run" use:enhance>
						<input type="hidden" name="job" value={job.name} />
						<button type="submit" class="control-btn is-small">run now</button>
					</form>
				</span>
			</div>
		{/each}
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">wiring the scheduler</h2>
	</header>

	<div class="panel-body">
		<p class="panel-prose">
			one entry, every fifteen minutes or so. omitting the job runs all of them; the advisory lock
			means two schedulers firing at once produce one run and one refusal.
		</p>
		<pre class="console-pre">{`curl -fsS -H "authorization: Bearer $CRON_SECRET" \\
  "https://…/api/jobs/run?job=outbox.dispatch"`}</pre>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">recent runs</h2>
		<span class="panel-note">{data.runs.length}</span>
	</header>

	<div class="panel-body">
		{#if data.runs.length === 0}
			<p class="panel-prose">nothing has ever run.</p>
		{:else}
			{#each data.runs as run (run.id)}
				<div class="row is-full">
					<span class="row-label">
						{run.name}
						<span class="row-hint">
							{run.status} · {stamp(run.startedAt)}{run.triggeredBy
								? ' · by hand'
								: ' · scheduler'}{run.error ? ` · ${run.error}` : ''}
						</span>
						{#if run.result}
							<pre class="console-pre">{JSON.stringify(run.result, null, 2)}</pre>
						{/if}
					</span>
				</div>
			{/each}
		{/if}
	</div>
</section>
