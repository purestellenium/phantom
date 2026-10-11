<script lang="ts">
	/**
	 * "Hours are now fragments", once, for somebody who already has a balance.
	 *
	 * The shop used to price in hours, so a balance of 120.8h is now shown as
	 * 1,208 fragments - a number ten times what it was, which reads as a bug
	 * unless something says why. This says it, with their own figures, on home
	 * and the shop, until it is dismissed on either.
	 *
	 * Remembered in this browser only (localStorage, like guides read): it is
	 * a welcome, not a record, and seeing it again on another device costs one
	 * click. Off by itself after INTRO_UNTIL, by when everyone who was going to
	 * be surprised has been.
	 */
	import { onMount } from 'svelte';

	import Fragments from '$lib/components/Fragments.svelte';
	import Notice from '$lib/components/Notice.svelte';

	let { balance }: { balance: number } = $props();

	const KEY = 'phantom:fragments-intro';
	const INTRO_UNTIL = new Date('2026-11-15T00:00:00Z');

	/* Hidden until the browser has said whether it was dismissed, so it never
	   flashes up for somebody who already closed it. */
	let show = $state(false);

	onMount(() => {
		if (balance <= 0 || Date.now() >= INTRO_UNTIL.getTime()) return;
		try {
			show = localStorage.getItem(KEY) === null;
		} catch {
			show = true;
		}
	});

	function dismiss() {
		show = false;
		try {
			localStorage.setItem(KEY, '1');
		} catch {
			/* A private window: it comes back next time, which is fine. */
		}
	}

	const hours = $derived((balance / 3600).toFixed(1));
</script>

{#if show}
	<Notice title="hours are now fragments" ondismiss={dismiss}>
		<span class="notice-body">
			the shop prices in fragments now. every hour of approved work earns 10, so your {hours}h is
			<Fragments seconds={balance} />. nothing was lost - it is the same balance, counted in smaller
			pieces.
		</span>
	</Notice>
{/if}
