<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Log from '$lib/components/Log.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { ORDER_STATE, stamp } from '$lib/status';
	import { fragments } from '$lib/fragments';

	let { data, form }: PageProps = $props();

	const state = $derived(ORDER_STATE[data.order.state]);
</script>

<svelte:head>
	<title>{data.order.productName} · console · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">{data.order.productName}</h1>
	<p class="page-lede">
		{#if data.buyer}
			<a class="link" href={resolve('/(app)/admin/users/[id]', { id: data.buyer.id })}>
				{data.buyer.displayName ?? data.buyer.email}
			</a>
		{:else}
			unknown buyer
		{/if}
	</p>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">the order</h2>
		<span class={['badge', state.tone]}>{state.label}</span>
	</header>

	<div class="panel-body">
		<div class="row">
			<span class="row-label">
				frozen at purchase
				<span class="row-hint">
					{data.order.quantity} × {fragments(data.order.unitPrice)} · product v{data.order
						.productVersion}
				</span>
			</span>
			<span class="row-value">{fragments(data.order.totalPrice)}</span>
		</div>

		{#each data.options as option (option.label)}
			<div class="row">
				<span class="row-label">{option.label}</span>
				<span class="row-value">{option.value}</span>
			</div>
		{/each}

		<div class="row">
			<span class="row-label">placed</span>
			<span class="row-value">{stamp(data.order.createdAt)}</span>
		</div>

		<div class="row">
			<span class="row-label">state since</span>
			<span class="row-value">{stamp(data.order.stateAt)}</span>
		</div>

		{#if data.order.replacesOrderId}
			<a class="row" href={resolve('/(app)/admin/orders/[id]', { id: data.order.replacesOrderId })}>
				<span class="row-label">
					replaces an earlier order
					<span class="row-hint">
						a new entitlement that re-checked affordability, stock and quota - not a reopening.
					</span>
				</span>
			</a>
		{/if}
	</div>

	{#if data.moves.length > 0}
		<form method="POST" action="?/move" class="panel-foot form" use:enhance>
			<div class="form-field">
				<label class="form-label" for="reason">reason</label>
				<input id="reason" name="reason" class="control-input" type="text" maxlength="200" />
				<span class="form-hint">stored on the transition and visible to the participant.</span>
			</div>

			<label class="check-field">
				<input type="checkbox" name="restock" />
				put the {data.order.quantity === 1 ? 'unit' : 'units'} back in stock
			</label>
			<span class="form-hint">
				no default on purpose. something already picked and packed should not go back on the shelf;
				something rejected the same afternoon should.
			</span>

			<div class="form-actions">
				{#each data.moves as move (move.name)}
					<button
						type="submit"
						name="transition"
						value={move.name}
						class={[
							'control-btn',
							(move.name === 'reject' || move.name === 'cancel') && 'is-danger',
							move.quiet && move.name !== 'reject' && move.name !== 'cancel' && 'is-quiet'
						]}
					>
						{move.label}
					</button>
				{/each}
			</div>
		</form>
	{/if}
</section>

{#if data.order.productKind === 'physical'}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">where it goes</h2>
			<span class="panel-note">audited on read</span>
		</header>

		<div class="panel-body">
			{#if data.revealed?.ok}
				<pre class="console-pre">{data.revealed.lines.join('\n')}</pre>
				<p class="panel-prose">
					captured {data.revealed.capturedAt}. this is the address as it was when the order was
					placed - it is a snapshot on this order, not a lookup of anything current.
				</p>
			{:else if data.revealed}
				<Notice bad alert body={data.revealed.error} />
			{:else}
				<p class="panel-prose">
					held encrypted against this order. reading it records your name, this order and the time.
				</p>
			{/if}
		</div>

		{#if !data.revealed}
			<div class="panel-foot">
				{#if data.canViewPii}
					<form method="POST" action="?/reveal" use:enhance>
						<button type="submit" class="control-btn is-quiet">reveal the address</button>
					</form>
				{:else}
					<span class="form-hint">
						you do not hold view_pii. managing an order and reading its address are separate
						permissions.
					</span>
				{/if}
			</div>
		{/if}
	</section>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">history</h2>
	</header>
	<div class="panel-body">
		<Log entries={data.log} />
	</div>
</section>
