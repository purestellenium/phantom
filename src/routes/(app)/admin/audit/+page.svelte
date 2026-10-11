<script lang="ts">
	import Log from '$lib/components/Log.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>audit · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">audit</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">search</h2>
		<span class="panel-note">{data.log.length} shown</span>
	</header>

	<!-- A GET form so a result set is a URL - an operator can send somebody the
	     link to what they were looking at, and the back button works. -->
	<form class="panel-body form" method="get" data-sveltekit-reload>
		{#if data.filters.action}
			<input type="hidden" name="action" value={data.filters.action} />
		{/if}
		<div class="form-field">
			<label class="form-label" for="q"
				>action, either party's email, or anything in the metadata</label
			>
			<input id="q" name="q" class="control-input" type="search" value={data.filters.term ?? ''} />
		</div>

		<div class="form-grid">
			<div class="form-field">
				<label class="form-label" for="actor">who did it</label>
				<input
					id="actor"
					name="actor"
					class="control-input"
					type="search"
					value={data.filters.actor ?? ''}
				/>
			</div>
			<div class="form-field">
				<label class="form-label" for="subject">who it was done to</label>
				<input
					id="subject"
					name="subject"
					class="control-input"
					type="search"
					value={data.filters.subject ?? ''}
				/>
			</div>
			<div class="form-field">
				<label class="form-label" for="from">from</label>
				<input
					id="from"
					name="from"
					class="control-input"
					type="date"
					value={data.filters.from ?? ''}
				/>
			</div>
			<div class="form-field">
				<label class="form-label" for="to">to</label>
				<input id="to" name="to" class="control-input" type="date" value={data.filters.to ?? ''} />
			</div>
		</div>

		<div class="row-actions">
			<button type="submit" class="control-btn is-small">search</button>
			<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved in the load -->
			<a class="control-btn is-small is-quiet" href={data.everythingHref}>everything</a>
			{#each data.prefixes as row (row.prefix)}
				<a class={['control-btn', 'is-small', !row.active && 'is-quiet']} href={row.href}>
					{row.prefix} ({row.count})
				</a>
			{/each}
		</div>
	</form>

	<!-- A +server.ts, so the client router must not try to render it. -->
	<footer class="panel-foot">
		<a class="control-btn is-small is-quiet" href={data.exportHref} data-sveltekit-reload>
			download csv
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</footer>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">events</h2>
	</header>

	<div class="panel-body">
		{#if data.log.length === 0}
			<p class="panel-prose">nothing matches that.</p>
		{:else}
			<Log entries={data.log} />
		{/if}
	</div>
</section>
