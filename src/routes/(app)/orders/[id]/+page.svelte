<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Log from '$lib/components/Log.svelte';
	import Fragments from '$lib/components/Fragments.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import StepBar from '$lib/components/StepBar.svelte';
	import { ORDER_STATE, stamp } from '$lib/status';

	let { data, form }: PageProps = $props();

	const state = $derived(ORDER_STATE[data.order.state]);

	/**
	 * [4b] Where the order is, as a track rather than a word: the steps it
	 * goes through, filled up to the one it has reached. The usual road is
	 * placed then fulfilled; a hold is a step on that road, and the ways it
	 * can go wrong are where it stopped - drawn red when something failed,
	 * plain when it was called off.
	 */
	const track = $derived.by((): { steps: string[]; current: number; bad: boolean } => {
		switch (data.order.state) {
			case 'placed':
				return { steps: ['placed', 'fulfilled'], current: 0, bad: false };
			case 'on_hold':
				return { steps: ['placed', 'on hold', 'fulfilled'], current: 1, bad: false };
			case 'fulfilled':
				return { steps: ['placed', 'fulfilled'], current: 1, bad: false };
			case 'unfulfilled':
				return { steps: ['placed', 'fulfilled', 'unfulfilled'], current: 2, bad: true };
			case 'rejected':
				return { steps: ['placed', 'rejected'], current: 1, bad: true };
			case 'cancelled':
				return { steps: ['placed', 'cancelled'], current: 1, bad: false };
		}
	});
	/* The short form of the id, for the bar. The full one is the url. */
	const shortId = $derived(data.order.id.slice(0, 8));
</script>

<svelte:head>
	<title>{data.order.productName} · PHANTOM</title>
</svelte:head>

<a class="control-btn is-quiet order-back" href={resolve('/orders')}>back to orders</a>

{#if form?.error}
	<Notice bad alert title="that did not go through" body={form.error} />
{/if}

<div class="order">
	<!-- ── the order ───────────────────────────────────────────────────────── -->
	<div class="order-main">
		<section class="panel">
			<header class="panel-head">
				<h2 class="panel-title">items</h2>
				<span class={['badge', state.tone]}>{state.label}</span>
			</header>
			<div class="panel-body order-track">
				<StepBar
					steps={track.steps}
					current={track.current}
					tone={track.bad ? 'bad' : null}
					label="order status"
					arrive
				/>
				<p class="order-track-hint">{state.hint}</p>
			</div>
			<table class="order-table">
				<thead>
					<tr>
						<th class="is-item">item</th>
						<th>price</th>
						<th>qty</th>
						<th>total</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td class="is-item">
							<span class="order-item">
								{#if data.imageUrl}
									<img class="row-thumb" src={data.imageUrl} alt="" />
								{/if}
								<span>
									{#if data.productSlug}
										<a href={resolve('/(app)/shop/[slug]', { slug: data.productSlug })}
											>{data.order.productName}</a
										>
									{:else}
										{data.order.productName}
									{/if}
									{#each data.options as option (option.label)}
										<span class="row-hint">{option.label}: {option.value}</span>
									{/each}
								</span>
							</span>
						</td>
						<td
							>{#if data.free}free{:else}<Fragments
									seconds={data.order.unitPrice}
									word={false}
								/>{/if}</td
						>
						<td>{data.order.quantity}</td>
						<td
							>{#if data.free}free{:else}<Fragments
									seconds={data.order.totalPrice}
									word={false}
								/>{/if}</td
						>
					</tr>
				</tbody>
			</table>
			{#if data.cancellable || data.replaceSlug}
				<div class="panel-foot">
					{#if data.cancellable}
						<form method="POST" action="?/cancel" class="order-cancel" use:enhance>
							<button type="submit" class="control-btn is-danger is-wide">cancel</button>
						</form>
					{/if}
					{#if data.replaceSlug}
						<a
							class="control-btn"
							href={resolve(`/shop/${data.replaceSlug}?replaces=${data.order.id}`)}
						>
							order it again
						</a>
					{/if}
				</div>
			{/if}
		</section>

		<section class="panel">
			<header class="panel-head"><h2 class="panel-title">history</h2></header>
			<div class="panel-body">
				<Log entries={data.log} />
			</div>
		</section>
	</div>

	<!-- ── order information ───────────────────────────────────────────────── -->
	<aside class="order-side">
		<section class="panel">
			<header class="panel-head"><h2 class="panel-title">order information</h2></header>
			<dl class="panel-body order-facts">
				<div>
					<dt>order id</dt>
					<dd>#{shortId}</dd>
				</div>
				<div>
					<dt>order date</dt>
					<dd>{stamp(data.order.createdAt)}</dd>
				</div>
				<div>
					<dt>email</dt>
					<dd>{data.email}</dd>
				</div>
				{#if data.order.productKind === 'physical'}
					<div>
						<dt>shipping address</dt>
						<dd>
							<span class="badge is-good">{data.order.shippingEncrypted ? 'held' : 'missing'}</span>
						</dd>
					</div>
				{/if}
				<div>
					<dt>price</dt>
					<dd>
						{#if data.free}free{:else}<Fragments seconds={data.order.unitPrice} /> each{/if}
					</dd>
				</div>
			</dl>
		</section>
	</aside>
</div>

<style>
	/* [4b] The status track, and what the state means under it. */
	.order-track {
		gap: 12px;
		border-bottom: 1px solid var(--panel-line);
	}

	.order-track-hint {
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--ink-mid);
	}
</style>
