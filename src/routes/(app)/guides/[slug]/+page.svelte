<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Card from '$lib/components/Card.svelte';
	import { trackEvent } from '$lib/analytics/client';
	import { markGuideRead, readGuides } from '$lib/guides/read';

	let { data }: PageProps = $props();

	const hasToc = $derived(data.guide.headings.length >= 3);

	/* Read once the end is reached: scrolled to the bottom, or a guide short
	   enough to end on the first screen. Kept in this browser only - see
	   $lib/guides/read.ts. */
	$effect(() => {
		const slug = data.guide.slug;
		/* Counted once per guide per browser - the same tick the guide list
		   shows - and once per visit where storage is blocked and nothing ticks. */
		let counted = readGuides().has(slug);
		const check = () => {
			if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80) {
				if (!counted) trackEvent('guide.finished', { guide: slug });
				counted = true;
				markGuideRead(slug);
			}
		};
		check();
		window.addEventListener('scroll', check, { passive: true });
		return () => window.removeEventListener('scroll', check);
	});

	/* The copy button the renderer puts on every code block (lib/server/
	   guides.ts). One listener for the lot; the button says so for a moment. */
	async function copyCode(event: MouseEvent) {
		const button = (event.target as Element | null)?.closest('.guide-copy');
		if (!(button instanceof HTMLButtonElement)) return;
		const code = button.parentElement?.querySelector('pre')?.innerText ?? '';
		try {
			await navigator.clipboard.writeText(code);
			button.textContent = 'copied';
			trackEvent('guide.code_copied', { guide: data.guide.slug });
		} catch {
			button.textContent = 'press ctrl+c';
		}
		setTimeout(() => (button.textContent = 'copy'), 1600);
	}

	/** The section being read: the last heading to cross a line a quarter of the way down the screen. */
	let active = $state<string | null>(null);

	$effect(() => {
		const ids = data.guide.headings.map((heading) => heading.id);
		if (ids.length < 3) return;

		let frame = 0;
		const update = () => {
			frame = 0;
			const line = window.innerHeight * 0.25;
			let current = ids[0];
			for (const id of ids) {
				const el = document.getElementById(id);
				if (!el) continue;
				if (el.getBoundingClientRect().top > line) break;
				current = id;
			}
			// A short last section never reaches the line; at the bottom of the page it is the one being read.
			const atBottom =
				window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
			active = atBottom ? ids[ids.length - 1] : current;
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};

		update();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		return () => {
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			cancelAnimationFrame(frame);
		};
	});
</script>

<svelte:head
	>
	<title>{data.guide.title} · PHANTOM</title>
</svelte:head>

<!-- Contents down the left, held in place while the guide scrolls past. Only where there is enough to jump between. -->
<div class="guide" class:has-toc={hasToc}>
	{#if hasToc}
		<nav class="panel guide-side" aria-label="On this page">
			<div class="panel-head">
				<h2 class="panel-title">on this page</h2>
			</div>
			<ol class="panel-body guide-toc">
				{#each data.guide.headings as heading, i (heading.id)}
					<li>
						<a
							class="row"
							href={`#${heading.id}`}
							onclick={() =>
								trackEvent('guide.toc_clicked', { guide: data.guide.slug, heading: heading.text })}
							aria-current={active === heading.id ? 'location' : undefined}
							><span class="guide-toc-idx" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span
							><span class="row-label">{heading.text}</span></a
						>
					</li>
				{/each}
			</ol>
		</nav>
	{/if}

	<div class="guide-main">
		<header class="page-head">
			<a class="guide-back" href={resolve('/guides')}>← all guides</a>
			<h1 class="page-title">{data.guide.title}</h1>
			{#if data.guide.description}<p class="page-lede">
					{data.guide.description}
				</p>{/if}
		</header>

		<article class="panel">
			<!-- Rendered on the server from the markdown in $lib/guides/content: files in this repository, never user input. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<!-- The click lands on the real <button>s inside; this only listens. -->
			<div class="panel-body guide-prose" onclick={copyCode}>{@html data.guide.html}</div>
		</article>

		<!-- What to read next, as a card like the index's; the one before as a
		     quiet link. -->
		{#if data.next || data.previous}
			<nav class="guide-after" aria-label="More guides">
				{#if data.next}
					<p class="guide-after-label">up next</p>
					<Card
						href={resolve('/(app)/guides/[slug]', { slug: data.next.slug })}
						name={data.next.title}
						by={`${data.next.topic} · ${data.next.minutes} min read`}
						description={data.next.description}
					/>
				{/if}
				{#if data.previous}
					<a
						class="control-btn is-quiet guide-prev"
						href={resolve('/(app)/guides/[slug]', { slug: data.previous.slug })}
						>← {data.previous.title}</a
					>
				{/if}
			</nav>
		{/if}
	</div>
</div>
