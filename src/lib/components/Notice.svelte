<script lang="ts">
	/**
	 * A message about the page rather than about a field.
	 *
	 * Two tones, not three: the plain notice and the alarm one. Only red survives
	 * the seven-level quantiser as a hue (see globals.css), so `bad` is spent on
	 * things that are actually wrong and everything else is the quiet surface.
	 *
	 * `role="alert"` for a refusal that just came back from a form, so it is
	 * announced the moment it lands; `role="status"` for everything that was
	 * already true when the page rendered.
	 */
	import type { Snippet } from 'svelte';

	let {
		title,
		body,
		bad = false,
		alert = false,
		ondismiss,
		children
	}: {
		title?: string;
		body?: string | null;
		bad?: boolean;
		alert?: boolean;
		/**
		 * Makes the notice closable, and says what closing it does.
		 *
		 * Opt-in, and deliberately not a boolean. A notice about something that
		 * happened - you signed out, that sign-in was refused - is news, and news
		 * can be read and put down. A notice about the STATE of an account, like
		 * the one on the dashboard saying Hack Club has not verified you, is not
		 * news and has no business being dismissible: it goes away by being
		 * resolved. Passing a handler rather than setting a flag means the caller
		 * has to have somewhere for the dismissal to go, which is the same thing
		 * as having thought about which of the two this is.
		 */
		ondismiss?: () => void;
		children?: Snippet;
	} = $props();
</script>

<div
	class={['notice', bad && 'is-bad', ondismiss && 'is-closable']}
	role={alert ? 'alert' : 'status'}
>
	{#if title}<span class="notice-title">{title}</span>{/if}
	{#if body}<span class="notice-body">{body}</span>{/if}
	{#if children}{@render children()}{/if}
	{#if ondismiss}
		<!-- A real button with a real label: the glyph is a multiplication sign
		     rather than the letter x, and on its own it is not a word anything can
		     announce. -->
		<button type="button" class="notice-close" aria-label="dismiss" onclick={ondismiss}>×</button>
	{/if}
</div>

<style>
	/* [4c] Arriving, a notice drops in from just above rather than popping
	   into place: a refusal after a press, a warning that appears, is news,
	   and news that appears in one frame is easy to miss. `backwards`, so
	   nothing keeps a transform once it has settled. */
	.notice {
		animation: notice-in 320ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
	}

	@keyframes notice-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.notice {
			animation: none;
		}
	}
</style>
