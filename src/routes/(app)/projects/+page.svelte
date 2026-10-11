<script lang="ts">
	import type { PageProps } from './$types';

	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Card from '$lib/components/Card.svelte';
	import Hours from '$lib/components/Hours.svelte';
	import NewProjectFlow from '$lib/components/NewProjectFlow.svelte';
	import { PAGE_SIZE, onVisible } from '$lib/paging';
	import type { ProjectCard } from '$lib/server/projects/pages';

	let { data, form }: PageProps = $props();

	type Page = { items: ProjectCard[]; more: boolean; nextOffset: number };

	/* The grid, growing as the reader scrolls. Same shape as explore's - see the
	   longer note there, and $lib/paging.ts for why a page is eighteen. It earns
	   its keep twice on this page: creating a project reruns the load, and
	   deriving from `data` means the new project appears at the top by itself
	   rather than behind whatever had already been appended. */
	let pages = $state<Page[]>([]);
	let loading = $state(false);
	let failed = $state(false);

	const items = $derived([...data.items, ...pages.flatMap((page) => page.items)]);
	const last = $derived(pages.at(-1));
	const more = $derived(last ? last.more : data.more);
	const nextOffset = $derived(last ? last.nextOffset : data.nextOffset);

	$effect(() => {
		void data.items;
		pages = [];
		failed = false;
	});

	async function loadMore() {
		if (loading || !more || failed) return;
		loading = true;
		try {
			const response = await fetch(`/api/projects?offset=${nextOffset}`);
			if (!response.ok) throw new Error(String(response.status));
			pages = [...pages, (await response.json()) as Page];
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	function retry() {
		failed = false;
		loadMore();
	}

	/* The new-project flow. A refusal comes back as a full page render, so the
	   flow has to reopen itself to show it; and the dashboard links here with
	   ?new, where opening it is the whole point of the link. Once, on landing. */
	let creating = $state(false);

	$effect(() => {
		if (form?.error) creating = true;
	});

	$effect(() => {
		if (page.url.searchParams.has('new')) creating = true;
	});
</script>

<svelte:head>
	<title>projects · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<div class="page-head-row">
		<h1 class="page-title">projects</h1>
		<!-- Only once there is something archived: a link to an empty page is
		     a dead end. -->
		{#if data.archived > 0}
			<a class="control-btn is-quiet" href={resolve('/(app)/projects/archived')}
				>archived · {data.archived}</a
			>
		{/if}
	</div>
</header>

<div class="cards">
	{#each items as project, i (project.number)}
		<Card
			index={i % PAGE_SIZE}
			href={resolve('/(app)/projects/[number]', { number: String(project.number) })}
			image={project.screenshotUrl}
			name={project.name}
			hyperChroma={project.hyperChroma}
			description={project.description}
		>
			<!-- The time tracked, where the submission state used to be: how far
			     along a project is reads better as hours than as a pill. Nothing
			     when Hackatime cannot be asked - an unlinked account is not zero. -->
			{#snippet aside()}
				{#if project.trackedSeconds !== null}<Hours seconds={project.trackedSeconds} />{/if}
			{/snippet}
		</Card>
	{/each}
	<!-- The new-project tile stays with the cards rather than moving below the
	     "show more" control: it is how you start one, not the end of the list,
	     and a reader who has paged twice should not have to page back to find it. -->
	<button
		type="button"
		class="card card-new"
		aria-label="new project"
		onclick={() => (creating = true)}
	>
		+
	</button>
</div>

{#if more}
	<div class="page-more" use:onVisible={loadMore}>
		{#if failed}
			<button type="button" class="control-btn is-quiet" onclick={retry}>
				that did not load - try again
			</button>
		{:else}
			<button type="button" class="control-btn is-quiet" onclick={loadMore} disabled={loading}>
				{loading ? 'loading…' : 'show more'}
			</button>
		{/if}
	</div>
{/if}

<NewProjectFlow
	bind:open={creating}
	error={form?.error ?? null}
	step={form?.step ?? null}
	values={form?.values ?? null}
/>
