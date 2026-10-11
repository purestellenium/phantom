<script lang="ts">
	/**
	 * The fallback when a route does not exist or a render throws.
	 *
	 * One page for both, because they are the same shape - one panel, one thing
	 * to do - and they differ only in what the panel says. Neither can assume the
	 * database is reachable, which is why this is not the landing page.
	 *
	 * The error id is shown rather than hidden. hooks.server.ts replaces the
	 * message with a generic one so nothing sensitive leaks to the browser, and
	 * the id is the only string that ties what someone is looking at to the line
	 * in our logs that explains it.
	 */

	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import { startAnalytics, trackEvent } from '$lib/analytics/client';
	import Solo from '$lib/components/Solo.svelte';

	const missing = $derived(page.status === 404);
	const forbidden = $derived(page.status === 403);
	/* A body refused before it was read - see handleError. Nothing went wrong on
	   our side, so it gets the message it came with rather than the ghost. */
	const tooLarge = $derived(page.status === 413);
	const heading = $derived(
		missing
			? 'nothing here'
			: forbidden
				? 'not for you'
				: tooLarge
					? 'too big to send'
					: 'you found a ghost'
	);

	/* Broken links and thrown renders, counted. Started here as well as in the
	   root layout: on a page served as an error, this effect can run before
	   the layout's afterNavigate does. */
	$effect(() => {
		if (page.data.analytics) startAnalytics(page.data.analytics);
		if (missing) trackEvent('404', {}, { interactive: false });
		else trackEvent('error', { status: page.status }, { interactive: false });
	});
</script>

<svelte:head>
	<title>{heading} · PHANTOM</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Solo>
	<section class="panel">
		<header class="panel-head">
			<h1 class="panel-title">{heading}</h1>
			<span class="panel-note">
				{missing ? '404' : forbidden ? '403' : tooLarge ? '413' : 'error'}
			</span>
		</header>

		<div class="panel-body">
			{#if forbidden}
				<p class="panel-prose">this is not open to you.</p>
			{:else if tooLarge}
				<p class="panel-prose">{page.error?.message}</p>
			{:else if missing}
				<!-- The link points at "/" rather than at /home. This page renders for
				     signed-out visitors too, and "/" is the one route that knows which of
				     those two you are: it sends a session straight on to /home and
				     everyone else to the front door. -->
				<p class="panel-prose">this page does not exist.</p>
			{:else}
				<p class="panel-prose">
					something went wrong on our side, not yours. trying again is worth a go - a fair number of
					these are a database connection having a bad moment rather than anything permanent. if it
					keeps happening, dm natey on the slack with the log id below so we can try to fix it.
				</p>

				{#if page.error?.id}
					<!-- One column: the id is long and the hint is longer, and side by
					     side they squeezed each other into ribbons. -->
					<div class="row is-full">
						<span class="row-label">
							log id
							<code class="log-id">{page.error.id}</code>
						</span>
					</div>
				{/if}
			{/if}
		</div>

		<div class="panel-foot">
			{#if tooLarge}
				<!-- Back, not home: what they were doing is one step behind this page,
				     with everything else they had typed still in the form. -->
				<button type="button" class="control-btn" onclick={() => history.back()}>go back</button>
			{:else if missing || forbidden}
				<a class="control-btn" href={resolve('/')}>take me back</a>
			{:else}
				<!-- A full document load, on purpose: whatever just failed may well be
				     the router, and a reload is the one navigation that does not depend
				     on any of it still working. -->
				<button type="button" class="control-btn" onclick={() => location.reload()}>
					try again
				</button>
				<a class="control-btn is-quiet" href={resolve('/')}>start over</a>
			{/if}
		</div>
	</section>
</Solo>

<style>
	.log-id {
		display: block;
		margin-top: 6px;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-size: var(--text-xs);
		color: var(--ink);
		overflow-wrap: anywhere;
	}
</style>
