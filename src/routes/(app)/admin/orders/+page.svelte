<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';
	import { ORDER_STATE, stamp } from '$lib/status';
	import { fragments } from '$lib/fragments';

	let { data, form }: PageProps = $props();

	/* The selection, mirrored so the bar can say how many and offer "all".
	   The checkboxes are the truth; this is a count of them. */
	let picked = $state<string[]>([]);
	function toggleAll(event: Event) {
		picked = (event.currentTarget as HTMLInputElement).checked
			? data.rows.map(({ order }) => order.id)
			: [];
	}
</script>

<svelte:head>
	<title>orders · console · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">orders</h1>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

{#if form?.bulk}
	<!-- What the batch did, refusals named. -->
	<Notice
		bad={form.bulk.failed.length > 0}
		alert
		title="{form.bulk.transition}: {form.bulk.done} done{form.bulk.failed.length
			? `, ${form.bulk.failed.length} refused`
			: ''}"
	>
		{#if form.bulk.failed.length > 0}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved below -->
			{#each form.bulk.failed as failure (failure.id)}
				<span class="bulk-failure"
					><a href={resolve('/(app)/admin/orders/[id]', { id: failure.id })}
						>{failure.id.slice(0, 8)}</a
					>
					{failure.error}</span
				>
			{/each}
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
	</Notice>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">by state</h2>
	</header>

	<div class="panel-body">
		<div class="row-actions">
			<a class="control-btn is-small is-quiet" href={resolve('/(app)/admin/orders')}>
				open ({data.openCount})
			</a>
			{#each data.states as state (state.value)}
				<a
					class="control-btn is-small is-quiet"
					href={resolve(`/admin/orders?state=${state.value}`)}
				>
					{state.label} ({state.count})
				</a>
			{/each}
		</div>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">{data.heading}</h2>
		<span class="panel-note">{data.rows.length}</span>
	</header>

	{#if data.rows.length === 0}
		<div class="panel-body">
			<p class="panel-prose">nothing here.</p>
		</div>
	{:else}
		<!-- The rows are inside the form so a tick is a field. Each row
		     stays a link to its own page; the box beside it is the selection. -->
		<form class="panel-body" method="POST" action="?/bulk">
			<div class="bulk-bar">
				<label class="bulk-all">
					<input
						type="checkbox"
						checked={picked.length === data.rows.length}
						indeterminate={picked.length > 0 && picked.length < data.rows.length}
						onchange={toggleAll}
					/>
					{picked.length} picked
				</label>
				<select name="transition" class="control-input bulk-move" required>
					{#each data.moves as move (move.name)}
						<option value={move.name}>{move.label}</option>
					{/each}
				</select>
				<input name="reason" class="control-input bulk-reason" type="text" placeholder="reason" />
				<label class="bulk-restock"><input type="checkbox" name="restock" /> restock</label>
				<button type="submit" class="control-btn is-small" disabled={picked.length === 0}
					>apply to picked</button
				>
			</div>

			{#each data.rows as { order, displayName, email } (order.id)}
				{@const label = ORDER_STATE[order.state]}
				<div class="bulk-row">
					<input type="checkbox" name="id" value={order.id} bind:group={picked} aria-label="pick" />
					<a class="row" href={resolve('/(app)/admin/orders/[id]', { id: order.id })}>
						<span class="row-label">
							{order.quantity} × {order.productName}
							<span class="row-hint">
								{displayName ?? email} · {fragments(order.totalPrice)} · {stamp(
									order.stateAt
								)}{order.productKind === 'physical' ? ' · ships' : ''}
							</span>
						</span>
						<span class={['badge', label.tone]}>{label.label}</span>
					</a>
				</div>
			{/each}
		</form>
	{/if}
</section>

<style>
	.bulk-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.bulk-all,
	.bulk-restock {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.bulk-move {
		width: auto;
	}

	.bulk-reason {
		flex: 1 1 160px;
		min-width: 0;
	}

	.bulk-row {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		gap: 8px;
	}

	.bulk-failure {
		display: block;
		font-size: var(--text-xs);
	}
</style>
