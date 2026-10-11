<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';
	import { OUTBOX_STATUS, stamp } from '$lib/status';

	let { data, form }: PageProps = $props();

	const ambiguous = $derived(data.events.filter((event) => event.status === 'ambiguous'));
	const statuses = Object.entries(OUTBOX_STATUS);
</script>

<svelte:head>
	<title>outbox · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">outbox</h1>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

{#if !data.slack}
	<Notice
		title="slack is not configured"
		body="SLACK_BOT_TOKEN and SLACK_CHANNEL_ID are unset, so notification effects wait as pending rather than failing, and go out once the token arrives. that is deliberate - an integration nobody connected should not fill this page with red."
	/>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">where things stand</h2>
		<span class="panel-note">{data.effects.join(' · ')}</span>
	</header>

	<div class="panel-body">
		<div class="figures">
			{#each statuses as [status, label] (status)}
				<div class="figure">
					<span class="figure-value">{data.counts[status] ?? 0}</span>
					<span class="figure-label">{label.label}</span>
				</div>
			{/each}
		</div>
	</div>
</section>

{#if ambiguous.length > 0}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">needs a person</h2>
			<span class="panel-note">{ambiguous.length}</span>
		</header>

		<div class="panel-body">
			<p class="panel-prose">
				these went out and we do not know whether they landed. go and look at the far end. if it
				happened, record the identifier; if it did not, say what you found and it goes back in the
				queue.
			</p>

			{#each ambiguous as event (event.id)}
				<form method="POST" action="?/resolve" class="form" use:enhance>
					<input type="hidden" name="eventId" value={event.id} />

					<div class="row is-full">
						<span class="row-label">
							{event.effect}
							<span class="row-hint">
								{event.dedupeKey} · {event.attempts} attempts · {event.lastError}
							</span>
						</span>
					</div>

					<div class="form-grid">
						<div class="form-field">
							<label class="form-label" for="remote-{event.id}"
								>remote identifier, if it landed</label
							>
							<input
								id="remote-{event.id}"
								name="remoteId"
								class="control-input"
								type="text"
								maxlength="200"
							/>
						</div>
						<div class="form-field">
							<label class="form-label" for="note-{event.id}">what you found, if it did not</label>
							<input
								id="note-{event.id}"
								name="note"
								class="control-input"
								type="text"
								maxlength="200"
							/>
						</div>
					</div>

					<div class="form-actions">
						<button type="submit" name="verdict" value="delivered" class="control-btn is-small">
							it landed
						</button>
						<button
							type="submit"
							name="verdict"
							value="reopen"
							class="control-btn is-small is-quiet"
						>
							it did not - requeue
						</button>
						<!-- Neither: it cannot happen, and finding out is not worth it. The
						     note above says why. -->
						<button type="submit" formaction="?/dismiss" class="control-btn is-small is-quiet">
							cannot happen - dismiss
						</button>
					</div>
				</form>
			{/each}
		</div>
	</section>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">recent</h2>
		<span class="panel-note">{data.events.length}</span>
	</header>

	<div class="panel-body">
		{#if data.events.length === 0}
			<p class="panel-prose">nothing has been enqueued.</p>
		{:else}
			{#each data.events as event (event.id)}
				{@const label = OUTBOX_STATUS[event.status]}
				{@const requeueable =
					event.status === 'failed' || event.status === 'retryable' || event.status === 'skipped'}
				{@const dismissable = event.status === 'failed' || event.status === 'retryable'}
				<div class="row">
					<span class="row-label">
						{event.effect}
						<span class="row-hint">
							{event.dedupeKey} · {event.attempts} attempts · {stamp(
								event.updatedAt
							)}{event.remoteId ? ` · ${event.remoteId}` : ''}{event.lastError
								? ` · ${event.lastError}`
								: ''}
						</span>
					</span>

					{#if requeueable}
						<span class="row-actions">
							<span class={['badge', label.tone]}>{label.label}</span>
							<form method="POST" action="?/retry" use:enhance>
								<input type="hidden" name="eventId" value={event.id} />
								<button type="submit" class="control-btn is-small is-quiet">retry</button>
							</form>
							<!-- For a row that will never go through - a banned Slack user, a
							     deleted record. It stops counting as needing attention. -->
							{#if dismissable}
								<form method="POST" action="?/dismiss" class="outbox-dismiss" use:enhance>
									<input type="hidden" name="eventId" value={event.id} />
									<input
										name="note"
										class="control-input"
										type="text"
										maxlength="200"
										placeholder="why it cannot happen"
										aria-label="why it cannot happen"
										required
									/>
									<button type="submit" class="control-btn is-small is-quiet">dismiss</button>
								</form>
							{/if}
						</span>
					{:else}
						<span class={['badge', label.tone]}>{label.label}</span>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</section>

<style>
	.outbox-dismiss {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.outbox-dismiss .control-input {
		width: 14rem;
	}
</style>
