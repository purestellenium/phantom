<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Fragments from '$lib/components/Fragments.svelte';
	import { ORDER_STATE, day } from '$lib/status';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>orders · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<div class="page-head-row">
		<div class="page-head-text">
			<h1 class="page-title">orders</h1>
		</div>
		<a class="control-btn is-quiet is-large" href={resolve('/shop')}>back to shop</a>
	</div>
</header>

<section class="panel">
	<div class="panel-body">
		{#if data.orders.length === 0}
			<p class="panel-prose">
				nothing yet. <a href={resolve('/shop')}>buy something from the shop!</a>
			</p>
		{:else}
			{#each data.orders as order (order.id)}
				{@const state = ORDER_STATE[order.state]}
				<a class="row" href={resolve('/(app)/orders/[id]', { id: order.id })}>
					<span class={['row-label', order.imageUrl && 'has-thumb']}>
						{#if order.imageUrl}<img class="row-thumb" src={order.imageUrl} alt="" />{/if}
						<span>
							{order.quantity > 1 ? `${order.quantity} × ${order.productName}` : order.productName}
							<span class="row-hint"
								>{day(order.createdAt)} · {#if order.free}free{:else}<Fragments
										seconds={order.totalPrice}
									/>{/if}</span
							>
						</span>
					</span>
					<span class={['badge', state.tone]}>{state.label}</span>
				</a>
			{/each}
		{/if}
	</div>
</section>
