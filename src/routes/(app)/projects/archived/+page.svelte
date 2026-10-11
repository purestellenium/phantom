<script lang="ts">
	import type { PageProps } from './$types';

	import { resolve } from '$app/paths';
	import Card from '$lib/components/Card.svelte';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>archived projects · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<div class="page-head-row">
		<div class="page-head-text">
			<h1 class="page-title">archived</h1>
			<p class="page-lede">projects you've put away. open one to bring it back.</p>
		</div>
		<a class="control-btn is-quiet" href={resolve('/projects')}>your projects</a>
	</div>
</header>

{#if data.items.length === 0}
	<p class="panel-prose">nothing archived.</p>
{:else}
	<div class="cards">
		{#each data.items as project (project.number)}
			<Card
				href={resolve('/(app)/projects/[number]', { number: String(project.number) })}
				image={project.screenshotUrl}
				name={project.name}
				description={project.description}
				badge={{ label: 'archived' }}
			/>
		{/each}
	</div>
{/if}
