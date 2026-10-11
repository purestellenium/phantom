<script lang="ts">
	/**
	 * The project screenshot, as a control.
	 *
	 * The banner IS the button: press it to pick a file, and the picked file
	 * previews at once as an object URL - nothing is uploaded until the form it
	 * sits in is submitted. "remove" clears it client-side and, where the page
	 * has something to remove, sends the clear flag along with the form so the
	 * server drops the stored picture.
	 *
	 * One component because the new-project modal and the project page ask for
	 * the same thing: the modal has nothing to remove yet and passes no clear
	 * field, the project page passes both its current picture and the field.
	 */
	import { untrack } from 'svelte';

	import {
		ALLOWED_IMAGE_TYPES,
		IMAGE_TOO_LARGE,
		MAX_IMAGE_BYTES,
		NOT_STILL_IMAGE
	} from '$lib/images';

	let {
		url = null,
		disabled = false,
		name = 'screenshot1',
		clearName = null,
		onpicture
	}: {
		/** The picture the working copy already has, if any. */
		url?: string | null;
		disabled?: boolean;
		/** The file field's name. */
		name?: string;
		/** The hidden field that carries a removal; omitted when there is
		 *  nothing stored to remove. */
		clearName?: string | null;
		/** Told the picture showing - stored, or picked and not yet uploaded -
		 *  whenever it changes; null when there is none. For the project page,
		 *  whose ship checklist reads it and whose autosave follows it. */
		onpicture?: (url: string | null) => void;
	} = $props();

	let input: HTMLInputElement | undefined = $state();
	let previewUrl: string | null = $state(null);
	let cleared = $state(false);
	let refused: string | null = $state(null);

	const banner = $derived(previewUrl ?? (cleared ? null : url));

	$effect(() => {
		onpicture?.(banner);
	});

	/* A save that went through changes the stored picture, and this is then
	   showing a local preview of a file that is now that picture. The page's
	   form saves in the background, so nothing reloads to clear it: without
	   this the file stays in the input and the next save uploads it again.
	   Only on a change - a refused save keeps the file for another try. */
	let lastUrl = untrack(() => url);
	$effect(() => {
		if (url === lastUrl) return;
		lastUrl = url;
		if (input) input.value = '';
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = null;
		cleared = false;
		refused = null;
	});

	function pick() {
		input?.click();
	}

	function handleFilePick(e: Event) {
		const el = e.currentTarget as HTMLInputElement;
		const file = el.files?.[0] ?? null;
		/* Too big is caught here, not at the far end. A body over the server's
		   limit is refused while it is still being read - before any action runs,
		   so nothing can put the refusal back on this form. Dropping the file now
		   keeps the rest of what they typed, and says why. */
		/* A still image only - see $lib/images. The input's `accept` already
		   asks for these, but a file dragged onto it or picked through "all
		   files" is whatever it is. */
		if (file && !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
			el.value = '';
			refused = NOT_STILL_IMAGE;
			return;
		}
		if (file && file.size > MAX_IMAGE_BYTES) {
			el.value = '';
			refused = IMAGE_TOO_LARGE;
			return;
		}
		refused = null;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = file ? URL.createObjectURL(file) : null;
		if (file) cleared = false;
	}

	function clear() {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = null;
		cleared = true;
		refused = null;
		if (input) input.value = '';
	}
</script>

<div class="screenshot-drop" class:has-image={!!banner}>
	<button
		type="button"
		class="screenshot-pick"
		{disabled}
		aria-label={banner ? 'change screenshot' : 'add a screenshot'}
		onclick={pick}
	>
		{#if banner}
			<img class="project-banner" src={banner} alt="" />
			<span class="screenshot-overlay">click to change</span>
		{:else}
			<span class="screenshot-empty">click to add a screenshot</span>
		{/if}
	</button>
	{#if banner}
		<button type="button" class="screenshot-remove" {disabled} onclick={clear}>remove</button>
	{/if}
</div>
{#if refused}
	<p class="form-error" role="alert">{refused}</p>
{/if}
<input
	bind:this={input}
	{name}
	type="file"
	class="sr-only"
	tabindex="-1"
	accept={ALLOWED_IMAGE_TYPES.join(',')}
	onchange={handleFilePick}
/>
{#if clearName}
	<input type="hidden" name={clearName} value={cleared ? '1' : ''} />
{/if}
