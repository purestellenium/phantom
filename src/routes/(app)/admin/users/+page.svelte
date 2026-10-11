<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import { day } from '$lib/status';
	import { fragments } from '$lib/fragments';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>people · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">people</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">find someone</h2>
		<span class="panel-note">{data.rows.length} shown</span>
	</header>

	<form class="panel-body form" method="get" data-sveltekit-reload>
		<div class="form-field">
			<label class="form-label" for="q">name, email, slack username, slack id or Hack Club id</label
			>
			<input id="q" name="q" class="control-input" type="search" value={data.term ?? ''} />
		</div>
		<div class="form-actions">
			<button type="submit" class="control-btn">search</button>
			{#if data.term}
				<a class="control-btn is-quiet" href={resolve('/(app)/admin/users')}>clear</a>
			{/if}
		</div>
	</form>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">{data.term ? 'matches' : 'newest first'}</h2>
	</header>

	<div class="panel-body">
		{#if data.rows.length === 0}
			<p class="panel-prose">nobody matches that.</p>
		{:else}
			{#each data.rows as row (row.id)}
				<a class="row" href={resolve('/(app)/admin/users/[id]', { id: row.id })}>
					<span class="row-label">
						{row.displayName ?? row.email}
						<span class="row-hint">
							{row.slackUsername ? `@${row.slackUsername} · ` : ''}{row.email} · {row.role}{row
								.capabilities.length > 0
								? ` +${row.capabilities.length}`
								: ''} · joined {day(row.createdAt)}
						</span>
					</span>
					<span class="row-value">{fragments(row.balance ?? 0)}</span>
				</a>
			{/each}
		{/if}
	</div>
</section>
