<script lang="ts">
	import type { PageProps } from './$types';

	import { onMount } from 'svelte';

	import { resolve } from '$app/paths';
	import { readGuides } from '$lib/guides/read';
	import type { GuideGroup, GuideSummary } from '$lib/server/guides';
	import type { PixelIconName } from '$lib/pixel-icons';
	import PixelIcon from '$lib/components/PixelIcon.svelte';

	let { data }: PageProps = $props();

	/* The two guides that decide how a review goes come first: a README a
	   reviewer can follow and commits that show the work are what most change
	   requests are about. Then the starter tutorials, then the rest. */
	const GROUPS: { key: GuideGroup; title: string; note: string }[] = [
		{
			key: 'ship',
			title: 'before you ship',
			note: 'what reviewers look for - read these before your first ship'
		},
		{ key: 'build', title: 'build something', note: 'start a project from nothing' },
		{ key: 'more', title: 'more', note: 'everything else worth knowing' }
	];

	const grouped = $derived(
		GROUPS.map((group) => ({
			...group,
			guides: data.guides.filter((guide) => guide.group === group.key)
		})).filter((group) => group.guides.length > 0)
	);

	/* What this reader has finished - from their own browser, so only known
	   once the page is running there. Empty until then, which draws the page
	   exactly as the server did. */
	let read = $state<Set<string>>(new Set());
	onMount(() => {
		read = readGuides();
	});

	/* A guide's face is its topic's icon rather than a picture: there are no
	   pictures worth showing for these, and a generated cover says nothing
	   about what is inside. */
	const ICONS: Record<string, PixelIconName> = {
		docs: 'file',
		git: 'branch',
		web: 'globe',
		python: 'flask',
		'game dev': 'gamepad',
		links: 'link'
	};

	function byline(guide: GuideSummary): string {
		return [
			guide.topic,
			`${guide.minutes} min read`,
			guide.sections > 1 ? `${guide.sections} sections` : null
		]
			.filter(Boolean)
			.join(' · ');
	}
</script>

<svelte:head>
	<title>guides · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">guides</h1>
	<p class="page-lede">make a project that you're proud of.</p>
</header>

{#each grouped as group, g (group.key)}
	<section class="gd-group" aria-labelledby="gd-{group.key}">
		<header class="gd-group-head">
			<h2 class="gd-group-title" id="gd-{group.key}">{group.title}</h2>
			<p class="gd-group-note">{group.note}</p>
		</header>
		<div class="cards">
			{#each group.guides as guide, i (guide.slug)}
				<!-- The site's card, with the topic's icon where a picture would go. -->
				<a
					class="card card-link is-listed gd-card"
					style="--i: {g * 4 + i}"
					href={resolve('/(app)/guides/[slug]', { slug: guide.slug })}
				>
					<span class="gd-icon" aria-hidden="true"
						><PixelIcon name={ICONS[guide.topic] ?? 'book'} size={24} /></span
					>
					<span class="card-head">
						<h3>{guide.title}</h3>
						{#if read.has(guide.slug)}
							<span class="badge is-approved">read</span>
						{/if}
					</span>
					<p class="card-by">{byline(guide)}</p>
					{#if guide.description}<p class="card-desc">{guide.description}</p>{/if}
				</a>
			{/each}
		</div>
	</section>
{/each}

<section class="panel">
	<div class="panel-body">
		<p class="panel-prose">
			want to contribute? email <a class="link" href="mailto:phantom@hackclub.com"
				>phantom@hackclub.com</a
			>.
		</p>
	</div>
</section>

<style>
	/* Prefixed: src/styles has generic global classes that would otherwise
	   reach in here. */
	.gd-group {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.gd-group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 12px;
	}

	.gd-group-title {
		margin: 0;
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-weight: 400;
		font-size: 30px;
		line-height: 1.1;
		color: var(--fg);
	}

	.gd-group-note {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--ink-dim);
	}

	.gd-icon {
		display: inline-grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-bottom: 4px;
		color: var(--ink);
		background-color: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--control-radius);
		background-image: var(--weave-bayer), var(--shade-raised);
	}

	.gd-card:hover .gd-icon,
	.gd-card:focus-visible .gd-icon {
		color: #ffffff;
		border-color: var(--panel-line);
	}
</style>
