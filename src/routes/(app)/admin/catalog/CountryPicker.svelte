<script lang="ts">
	/**
	 * Which countries a product is hidden in: a searchable dropdown of every
	 * country, tick as many as you like.
	 *
	 * What the form submits is one hidden `blockedCountries` field per picked
	 * code, rendered on the server as well - so a product saved without
	 * JavaScript keeps the countries it already had rather than losing them.
	 */
	import { COUNTRIES, countryName } from '$lib/countries';

	let { selected: initial = [] }: { selected?: readonly string[] } = $props();

	// svelte-ignore state_referenced_locally
	let selected = $state<string[]>([...initial]);
	let open = $state(false);
	let query = $state('');
	let root: HTMLDivElement | undefined;
	let search = $state<HTMLInputElement>();

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return COUNTRIES;
		return COUNTRIES.filter(
			(country) => country.name.toLowerCase().includes(q) || country.code.toLowerCase() === q
		);
	});

	function toggle(code: string) {
		selected = selected.includes(code)
			? selected.filter((picked) => picked !== code)
			: [...selected, code].sort((a, b) => countryName(a).localeCompare(countryName(b)));
	}

	function openPanel() {
		open = !open;
		if (open) queueMicrotask(() => search?.focus());
	}

	/* Closes on a click anywhere outside it, and on Escape, like any menu. */
	function onWindowClick(event: MouseEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			open = false;
		}
		/* Enter in the search box ticks the only match rather than submitting
		   the whole product form. */
		if (event.key === 'Enter' && event.target === search) {
			event.preventDefault();
			if (shown.length === 1) toggle(shown[0].code);
		}
	}
</script>

<svelte:window onclick={onWindowClick} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="country-picker" bind:this={root} onkeydown={onKeydown}>
	{#each selected as code (code)}
		<input type="hidden" name="blockedCountries" value={code} />
	{/each}

	<div class="picked">
		{#each selected as code (code)}
			<span class="badge picked-chip">
				{countryName(code)}
				<button
					type="button"
					class="chip-remove"
					aria-label={`unblock ${countryName(code)}`}
					onclick={() => toggle(code)}>×</button
				>
			</span>
		{:else}
			<span class="form-hint">none - shown everywhere.</span>
		{/each}
	</div>

	<button
		type="button"
		class="control-btn is-quiet picker-toggle"
		aria-expanded={open}
		aria-controls="country-panel"
		onclick={openPanel}
	>
		{selected.length ? 'change countries' : 'block countries'}
		<span class="select-caret" aria-hidden="true">▼</span>
	</button>

	{#if open}
		<div class="picker-panel" id="country-panel">
			<input
				bind:this={search}
				bind:value={query}
				class="control-input picker-search"
				type="search"
				placeholder="search countries"
				aria-label="search countries"
				autocomplete="off"
			/>
			<ul class="picker-list" aria-label="countries">
				{#each shown as country (country.code)}
					<li>
						<label class="check-field">
							<input
								type="checkbox"
								checked={selected.includes(country.code)}
								onchange={() => toggle(country.code)}
							/>
							{country.name}
						</label>
					</li>
				{:else}
					<li class="form-hint">no country matches "{query}".</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.country-picker {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
	}

	.picked {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.picked-chip {
		display: inline-flex;
		gap: 6px;
		padding-right: 6px;
	}

	.chip-remove {
		padding: 0 2px;
		border: 0;
		font: inherit;
		line-height: 1;
		color: var(--ink-dim);
		background: none;
		cursor: pointer;
	}

	.chip-remove:hover,
	.chip-remove:focus-visible {
		color: var(--ink);
		outline: none;
	}

	.picker-toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.picker-toggle .select-caret {
		position: static;
		font-size: 0.7em;
	}

	.picker-panel {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 20;
		width: min(320px, 100%);
		margin-top: 6px;
		padding: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid var(--panel-line);
		border-radius: 10px;
		background-color: var(--panel);
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
	}

	.picker-search {
		flex: none;
		width: 100%;
	}

	.picker-list {
		max-height: 280px;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	.picker-list li {
		padding: 3px 2px;
	}
</style>
