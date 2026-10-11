<script lang="ts">
	/**
	 * A history: one card per entry, in the order given. See lib/log.ts for
	 * the shape; the styles are the `.log-*` rules in globals.css.
	 */
	import DitherAvatar from '$lib/components/dither/DitherAvatar.svelte';
	import type { Snippet } from 'svelte';

	import Fragments from '$lib/components/Fragments.svelte';
	import HyperChroma from '$lib/components/HyperChroma.svelte';
	import type { LogEntry } from '$lib/log';
	import { stamp } from '$lib/status';

	let {
		entries,
		tail
	}: {
		entries: LogEntry[];
		/** Anything a page hangs off an entry, drawn at its foot - the project
		 *  page's hyper-chroma control, on an approval. */
		tail?: Snippet<[LogEntry]>;
	} = $props();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="log">
	{#each entries as entry (entry.id)}
		<article class="log-entry">
			<header class="log-head">
				{#if entry.actor?.avatarUrl}
					<img class="log-face" src={entry.actor.avatarUrl} alt="" />
				{:else}
					<DitherAvatar name={entry.actor?.name ?? 'phantom'} class="log-face" />
				{/if}
				{#if entry.href}
					<a class="log-actor" href={entry.href}>{entry.actor?.name ?? 'phantom'}</a>
				{:else}
					<span class="log-actor">{entry.actor?.name ?? 'phantom'}</span>
				{/if}
				{#if entry.badge}<span class={['badge', entry.badge.tone]}>{entry.badge.label}</span>{/if}
				{#if entry.ship?.hyperChroma}<HyperChroma />{/if}
				{#if entry.summary || entry.fragments}<span class="log-summary"
						>{entry.summary ?? ''}{#if entry.summary && entry.fragments}
							·
						{/if}{#if entry.fragments}<Fragments
								seconds={entry.fragments.seconds}
								signed={entry.fragments.signed}
							/>{entry.fragments.after ? ` ${entry.fragments.after}` : ''}{/if}</span
					>{/if}
				<time class="log-when" datetime={entry.at.toISOString()}>{stamp(entry.at)}</time>
			</header>
			{#if entry.message}
				<p class="log-message">{entry.message}</p>
			{/if}
			{#if entry.internal}
				<div class="log-internal">
					<span class="log-internal-tag">{entry.internalTag ?? 'internal'}</span>
					<pre class="log-internal-text">{entry.internal}</pre>
				</div>
			{/if}
			{#if tail}{@render tail(entry)}{/if}
		</article>
	{/each}
</div>
