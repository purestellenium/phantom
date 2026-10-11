<script lang="ts">
	/**
	 * A Hackatime link that did not go through, said on whatever page the
	 * callback brought you back to - see $lib/link-errors for why that can be
	 * any of several. Rendered by both frames (the signed-in shell and
	 * onboarding), so no page has to remember to.
	 *
	 * Dismissing it takes `link_error` out of the address as well, so a reload
	 * or a copied link does not bring the complaint back.
	 */
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import Notice from '$lib/components/Notice.svelte';
	import { LINK_ERRORS } from '$lib/link-errors';

	const code = $derived(page.url.searchParams.get('link_error'));
	const error = $derived(LINK_ERRORS[code ?? ''] ?? null);

	/* The frames stay mounted from page to page, so a dismissal is forgotten
	   whenever the code in the address changes - a second failed link says so
	   too. */
	let dismissed = $state(false);
	$effect(() => {
		void code;
		dismissed = false;
	});

	function dismiss() {
		dismissed = true;
		const url = new URL(page.url);
		url.searchParams.delete('link_error');
		/* The address the page is already at, less one parameter - nothing to
		   resolve, as on the home page's own replaceState. */
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		replaceState(url, page.state);
	}
</script>

{#if error && !dismissed}
	<Notice bad alert title={error.title} body={error.body} ondismiss={dismiss} />
{/if}
