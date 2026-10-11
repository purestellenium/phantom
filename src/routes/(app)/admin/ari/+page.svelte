<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';
	import { stamp } from '$lib/status';

	let { data, form }: PageProps = $props();

	const EVENT_LABELS: Record<string, string> = {
		'review.approved': 'approval',
		'review.rejected': 'rejection',
		'review.changes': 'change request',
		'review.requeued': 'requeue',
		'review.reverted': 'revert',
		'ship.updated': 'correction'
	};

	/* The figures, in the order a reader wants them. */
	const FIGURES = [
		{ key: 'applied', label: 'applied this week' },
		{ key: 'waiting', label: 'held for second pass' },
		{ key: 'ignored', label: 'did not apply' }
	];

	const reconcile = $derived(data.lastReconcile);
	const drift = $derived(
		reconcile?.result && Array.isArray(reconcile.result.driftDetail)
			? (reconcile.result.driftDetail as string[])
			: []
	);
</script>

<svelte:head>
	<title>ari · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">ari</h1>
	<p class="page-lede">where Phantom and Ari stand with each other, and what needs a person.</p>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{:else if form && 'ran' in form}
	<Notice body={`${form.ran} ran: ${form.status}.`} />
{:else if form && 'retried' in form}
	<Notice
		bad={form.retryOutcome === 'ignored'}
		body={form.retryOutcome === 'applied'
			? 'retried: it applied.'
			: form.retryOutcome === 'waiting'
				? "retried: Ari hasn't finished deciding it, so it's held - ari.reconcile applies it when Ari has."
				: `retried, and it still didn't apply: ${form.retryDetail ?? 'no reason given'}`}
	/>
{/if}

{#if !data.configured.ingest || !data.configured.webhook}
	<Notice
		bad
		title="ari is not fully configured"
		body={[
			!data.configured.ingest &&
				'ARI_PROGRAM / ARI_INGEST_SECRET are unset, so ships wait in the outbox instead of reaching Ari.',
			!data.configured.webhook &&
				"ARI_WEBHOOK_SECRET is unset, so Ari's deliveries are refused with a 503 (Ari retries for about eight hours)."
		]
			.filter(Boolean)
			.join(' ')}
	/>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">where things stand</h2>
		<span class="panel-note">{data.counts.ships} ships sent · {data.counts.open} open</span>
	</header>
	<div class="panel-body">
		<div class="figures">
			{#each FIGURES as figure (figure.key)}
				<div class="figure">
					<span class="figure-value">{data.counts.recent[figure.key] ?? 0}</span>
					<span class="figure-label">{figure.label}</span>
				</div>
			{/each}
			<div class="figure">
				<span class="figure-value">{data.stuck.length}</span>
				<span class="figure-label">not sent to ari</span>
			</div>
		</div>
	</div>
</section>

<!-- ── deliveries that did not apply, and approvals still held ──────────── -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">needs a person</h2>
		<span class="panel-note">{data.attention.length}</span>
	</header>
	<div class="panel-body">
		{#if data.attention.length === 0}
			<p class="panel-prose">every decision from Ari has been applied.</p>
		{:else}
			<p class="panel-prose">
				a held approval applies itself once Ari's second pass finishes - nothing to do. a delivery
				that did not apply says why: fix that, then retry it, or mark it seen if it needs nothing.
			</p>
			{#each data.attention as delivery (delivery.deliveryId)}
				<div class="row">
					<span class="row-label">
						{EVENT_LABELS[delivery.event] ?? delivery.event}
						{#if delivery.projectNumber !== null}
							· <a
								class="link"
								href={resolve('/(app)/projects/[number]', {
									number: String(delivery.projectNumber)
								})}>#{delivery.projectNumber} {delivery.projectName}</a
							>
						{/if}
						<span class="row-hint">
							{stamp(delivery.receivedAt)}{delivery.detail ? ` · ${delivery.detail}` : ''}
						</span>
					</span>
					<span class="row-actions">
						{#if delivery.outcome === 'waiting'}
							<span class="badge is-waiting">held</span>
						{:else}
							<span class="badge is-bad">did not apply</span>
						{/if}
						{#if delivery.ariUrl}
							<!-- eslint-disable svelte/no-navigation-without-resolve -- Ari's own review page -->
							<a
								class="control-btn is-small is-quiet"
								href={delivery.ariUrl}
								target="_blank"
								rel="noopener noreferrer">open in ari</a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
						{#if delivery.outcome === 'ignored'}
							<!-- Run it again, now that whatever stopped it may be fixed. -->
							<form method="POST" action="?/retry" use:enhance>
								<input type="hidden" name="deliveryId" value={delivery.deliveryId} />
								<button type="submit" class="control-btn is-small">retry</button>
							</form>
							<form method="POST" action="?/acknowledge" use:enhance>
								<input type="hidden" name="deliveryId" value={delivery.deliveryId} />
								<button type="submit" class="control-btn is-small is-quiet">mark seen</button>
							</form>
						{/if}
					</span>
				</div>
			{/each}
		{/if}
	</div>
</section>

<!-- ── ships that never reached Ari ──────────────────────────────────────── -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">not sent to ari</h2>
		<span class="panel-note">{data.stuck.length}</span>
	</header>
	<div class="panel-body">
		{#if data.stuck.length === 0}
			<p class="panel-prose">every waiting ship has reached Ari.</p>
		{:else}
			<p class="panel-prose">
				shipped over half an hour ago and still not on Ari. the send's last word is on each. one
				that was never queued is sent by the backfill.
			</p>
			{#each data.stuck as ship (ship.projectNumber)}
				<div class="row">
					<span class="row-label">
						<a
							class="link"
							href={resolve('/(app)/projects/[number]', { number: String(ship.projectNumber) })}
							>#{ship.projectNumber} {ship.projectName}</a
						>
						<span class="row-hint">
							shipped {stamp(ship.shippedAt)} · {ship.sendStatus
								? `send ${ship.sendStatus}, ${ship.sendAttempts} attempts${ship.sendError ? ` - ${ship.sendError}` : ''}`
								: 'never queued'}
						</span>
					</span>
				</div>
			{/each}
		{/if}
		<form method="POST" action="?/run" class="form-actions" use:enhance>
			<input type="hidden" name="job" value="ari.backfill" />
			<button type="submit" class="control-btn is-small is-quiet"
				>send waiting ships (backfill)</button
			>
		</form>
	</div>
</section>

<!-- ── the last reconcile ────────────────────────────────────────────────── -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">last check against ari</h2>
		{#if reconcile}<span class="panel-note">{stamp(reconcile.finishedAt)}</span>{/if}
	</header>
	<div class="panel-body">
		{#if !reconcile}
			<p class="panel-prose">ari.reconcile has not run yet.</p>
		{:else}
			<p class="panel-prose">
				{reconcile.status === 'succeeded' ? 'nothing out of step.' : 'something needs a look.'}
				{#if reconcile.result?.unreachable}
					ari did not answer for {reconcile.result.unreachable} ships.
				{/if}
			</p>
			{#if drift.length > 0}
				<p class="panel-prose">
					decided on Ari without Phantom hearing - resend the delivery from Ari's review screen:
				</p>
				<ul class="ari-drift">
					{#each drift as line (line)}<li>{line}</li>{/each}
				</ul>
			{/if}
		{/if}
		<form method="POST" action="?/run" class="form-actions" use:enhance>
			<input type="hidden" name="job" value="ari.reconcile" />
			<button type="submit" class="control-btn is-small is-quiet">check again now</button>
		</form>
	</div>
</section>

<style>
	.ari-drift {
		margin: 0;
		padding-left: 18px;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-size: var(--text-xs);
		color: var(--ink-mid);
	}
</style>
