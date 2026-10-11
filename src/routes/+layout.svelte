<script lang="ts">
	/* Phantom's stylesheet, for every page - the root error page included,
	   which renders under this layout and nothing else. See
	   $lib/site-styles.ts. First, so it comes first in the cascade. */
	import '$lib/site-styles';

	import { onMount } from 'svelte';

	import { afterNavigate, onNavigate } from '$app/navigation';
	import { setSegment, startAnalytics, trackEvent, trackPageview } from '$lib/analytics/client';
	import Loader from '$lib/components/Loader.svelte';
	import NavigationProgress from '$lib/components/NavigationProgress.svelte';
	import { startLocalTime } from '$lib/time.svelte';

	let { data, children } = $props();

	/* Smooth scrolling is for in-page links (base.css), not for arriving on a
	   new page: with it on, the router's jump back to the top played out as a
	   visible scroll up the page just opened. Off from the moment the new
	   page renders until it has landed - afterNavigate runs once the scroll
	   is done - and only for a different page, so a link to a heading on the
	   same one still glides. */
	onNavigate(({ from, to }) => {
		if (!from || !to || from.url.pathname === to.url.pathname) return;
		document.documentElement.style.scrollBehavior = 'auto';
	});
	afterNavigate(() => {
		document.documentElement.style.scrollBehavior = '';
	});

	/* Timestamps go from UTC to the reader's own zone, once - here rather than
	   per page, because it has to happen after hydration and exactly once for
	   the whole tree. See $lib/time.svelte.ts for why it cannot simply be a
	   `browser` check at the format. */
	onMount(startLocalTime);

	/* Analytics - see $lib/analytics/client.ts. Null config means this
	   deployment sends nothing. The segment follows the session: finishing
	   onboarding reruns the root load, and later events say so. */
	$effect(() => {
		if (data.analytics) setSegment(data.analytics.segment);
	});

	/* Query parameters that are never sent, as values or as names: the invite
	   code, the landing page's email hint, OAuth's leftovers. */
	const UNSENT = new Set(['ref', 'email', 'code', 'state']);

	afterNavigate(({ from, to }) => {
		if (!data.analytics || !to) return;
		startAnalytics(data.analytics);

		/* Same page, different query: a search or a filter, not a new view. */
		if (from && from.url.pathname === to.url.pathname) {
			if (from.url.search === to.url.search) return;
			/* The console's searches can hold an email or a name, so there only
			   which filters were used is sent, not what they were set to. */
			const operator = to.route.id?.startsWith('/(app)/admin') ?? false;
			const props: Record<string, string> = {};
			for (const [key, value] of to.url.searchParams) {
				if (UNSENT.has(key) || key.startsWith('utm_')) continue;
				props[key] = operator ? 'set' : value.trim().toLowerCase().slice(0, 100);
			}
			trackEvent('filter', props);
			return;
		}
		trackPageview(to.route.id);
	});
</script>

<svelte:head>
	<!-- The wordmark's "P" (Instrument Serif italic), centred. SVG for modern
	     browsers, a PNG fallback, and the 180px apple-touch icon for iOS. -->
	<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
	<link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96" />
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
</svelte:head>

<Loader />
<NavigationProgress />

{@render children()}
