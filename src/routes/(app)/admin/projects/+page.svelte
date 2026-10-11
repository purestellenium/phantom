<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import { PROJECT_STATUS, day, hours } from '$lib/status';
	import HyperChroma from '$lib/components/HyperChroma.svelte';

	let { data }: PageProps = $props();

	/* An unrecognised `status` shows everything - see the load - so `all` is what
	   is marked in that case too, rather than nothing being marked at all. */
	const KNOWN = ['draft', 'review', 'approved', 'rejected'];
	const current = $derived(KNOWN.includes(data.status ?? '') ? (data.status as string) : '');

	/**
	 * This page, with a search term and a status filter on it.
	 *
	 * A tab's link keeps whatever is in the search box and the clear button keeps
	 * whichever tab you are on: they are separate questions about the same list,
	 * and changing one should not throw the other away.
	 *
	 * The ROUTE goes through `resolve` and the query string is appended after,
	 * because a query string is not part of a route id - `resolve` is typed
	 * against the route table and a template with a `string` in it is not one of
	 * its members. The orders page gets away with interpolating because its
	 * values are a literal union; these are a free-text search term.
	 */
	const BASE = resolve('/(app)/admin/projects');
	function href(term: string | null, status: string, page = 1): string {
		const parts = [
			term ? `q=${encodeURIComponent(term)}` : null,
			status ? `status=${encodeURIComponent(status)}` : null,
			/* Page one is the absence of the parameter, not `page=1`. Two URLs for
			   one list is two things to share and one of them looks stale. */
			page > 1 ? `page=${page}` : null
		].filter(Boolean);
		return parts.length > 0 ? `${BASE}?${parts.join('&')}` : BASE;
	}

	/* Which slice of the matches is on screen, for the panel note. */
	const first = $derived(data.rows.length > 0 ? data.offset + 1 : 0);
	const last = $derived(data.offset + data.rows.length);
</script>

<!-- Every link below is this page with a different query string on it, and the
     path half of each one came out of `resolve` in `href` above - which the
     rule cannot see through. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->

<svelte:head>
	<title>projects · console · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">projects</h1>
	<p class="page-lede">every project, drafts included.</p>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">find a project</h2>
	</header>

	<form class="panel-body form" method="get" data-sveltekit-reload>
		<div class="form-field">
			<label class="form-label" for="q">project name, hackatime project, or the owner</label>
			<input id="q" name="q" class="control-input" type="search" value={data.term ?? ''} />
			<span class="form-hint">
				an owner matches on name, email, slack username, slack id or Hack Club id - the same as on
				the people page.
			</span>
		</div>
		<!-- The filter rides along with the search rather than being a second
		     form, so submitting the box keeps the tab you were on. `page` does
		     NOT ride along, and neither does it on a tab link: a new search or a
		     new filter is a different result set, and page four of it is a page
		     of something else - which lands empty and reads as "no matches" for
		     a search that has plenty. -->
		{#if current}
			<input type="hidden" name="status" value={current} />
		{/if}
		<div class="form-actions">
			<button type="submit" class="control-btn">search</button>
			{#if data.term}
				<a class="control-btn is-quiet" href={href(null, current)}>clear</a>
			{/if}
		</div>
	</form>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">by status</h2>
	</header>
	<div class="panel-body">
		<div class="row-actions">
			{#each data.tabs as tab (tab.value)}
				<a
					class={['control-btn', 'is-small', tab.value !== current && 'is-quiet']}
					href={href(data.term, tab.value)}
					aria-current={tab.value === current ? 'page' : undefined}
				>
					{tab.label} ({tab.count})
				</a>
			{/each}
		</div>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">{data.term ? 'matches' : 'newest first'}</h2>
		<!-- The range rather than the count, because the count of what is on
		     screen stopped being the count of what matched the moment this was
		     paged. The tab above carries the total. -->
		<span class="panel-note">{first === 0 ? 'none' : `${first}-${last}`}</span>
	</header>

	<div class="panel-body">
		{#if data.rows.length === 0 && data.page > 1}
			<!-- Past the end. Usually a bookmark to a page that has since got
			     shorter, so say so rather than showing the same empty box a search
			     with no matches gets. -->
			<p class="panel-prose">nothing on page {data.page}.</p>
			<div class="row-actions">
				<a class="control-btn is-small" href={href(data.term, current)}>back to the first page</a>
			</div>
		{:else if data.rows.length === 0}
			<p class="panel-prose">nothing matches that.</p>
		{:else}
			{#each data.rows as row (row.id)}
				{@const status = PROJECT_STATUS[row.status]}
				<a class="row" href={resolve('/(app)/projects/[number]', { number: String(row.number) })}>
					<span class="row-label">
						#{row.number}
						{row.name}
						<span class="row-hint">
							{row.owner?.name ?? row.owner?.email ?? 'unknown'} · started {day(row.createdAt)}
							{#if row.ships > 0}· {row.ships}
								{row.ships === 1 ? 'ship' : 'ships'} · {hours(row.approvedSeconds)} approved{/if}
							{#if row.hackatimeProjects}· {row.hackatimeProjects}{/if}
						</span>
					</span>
					<span class="row-badges">
						{#if row.hyperChroma}<HyperChroma />{/if}
						{#if row.fraudHold}<span class="badge is-bad">hold</span>{/if}
						{#if row.archived}<span class="badge is-done">archived</span>{/if}
						<span class={['badge', status.tone]}>{status.label}</span>
					</span>
				</a>
			{/each}
		{/if}

		{#if data.page > 1 || data.more}
			<div class="pager">
				{#if data.page > 1}
					<a class="control-btn is-small" href={href(data.term, current, data.page - 1)}>previous</a
					>
				{:else}
					<span class="control-btn is-small is-quiet" aria-disabled="true">previous</span>
				{/if}
				<span class="pager-note">page {data.page}</span>
				{#if data.more}
					<a class="control-btn is-small" href={href(data.term, current, data.page + 1)}>next</a>
				{:else}
					<span class="control-btn is-small is-quiet" aria-disabled="true">next</span>
				{/if}
			</div>
		{/if}
	</div>
</section>

<style>
	/* Two badges where the other list pages have one, so they need a box of
	   their own rather than each trying to be the row's value. */
	.row-badges {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}

	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-top: 12px;
	}

	.pager-note {
		font-size: var(--text-xs);
		color: var(--ink-dim);
		font-family: var(--font-geist-mono), ui-monospace, monospace;
	}
</style>
