<script lang="ts">
	/**
	 * Real, native controls.
	 *
	 * These are ordinary form elements rather than anything reconstructed: they
	 * focus, tab, type, autofill and announce because the browser owns them. Only
	 * the submit is intercepted, so the page does not navigate away.
	 */

	// how long the field stays rejected before it settles back
	const REJECT_MS = 2200;

	import type { Snippet } from 'svelte';

	/* An optional second action beside the submit - the landing page puts the
	   staff log-in there while the site is closed. Rendered inside the form so
	   the two sit on one row at one size. `email` fills the field to start
	   with - the landing page's `?email=`. */
	let { children, email: initial = null }: { children?: Snippet; email?: string | null } = $props();

	// svelte-ignore state_referenced_locally
	let email = $state(initial ?? '');
	let signedUp = $state<string | null>(null);
	let rejected = $state(false);
	let serverError = $state(false);
	let submitting = false;
	let field: HTMLInputElement | undefined;
	let timer: number | undefined;

	$effect(() => () => window.clearTimeout(timer));

	/* The browser's validation bubble is a native popup painted over the page. It
	   cannot be dithered, it ignores the palette, and it is anchored to a field
	   that from its point of view is blank - every glyph in it is transparent.
	   Turning it off (novalidate) and answering in the field itself is the only
	   way the rejection can be made of the same material as everything else.
	   checkValidity() below is still the browser's own email parsing; only the
	   reporting is ours. */
	async function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		const input = field;
		if (!input || submitting) return;

		if (!input.checkValidity()) {
			signedUp = null;
			rejected = true;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => (rejected = false), REJECT_MS);
			input.focus();
			return;
		}

		window.clearTimeout(timer);
		rejected = false;
		serverError = false;

		const value = email.trim();
		submitting = true;
		try {
			const res = await fetch('/api/signup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: value })
			});
			if (!res.ok) throw new Error('signup request failed');
			signedUp = value;
		} catch {
			serverError = true;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => (serverError = false), REJECT_MS);
			input.focus();
		} finally {
			submitting = false;
		}
	}

	function onInput(e: Event) {
		email = (e.currentTarget as HTMLInputElement).value;
		if (rejected || serverError) {
			window.clearTimeout(timer);
			rejected = false;
			serverError = false;
		}
	}
</script>

<form class={['controls', !children && 'is-solo']} novalidate onsubmit={onSubmit}>
	<label class="sr-only" for="email">Email address</label>
	<!-- type="email" so the browser validates and offers the right keyboard;
	     autocomplete lets it fill from the user's own saved address. -->
	<input
		bind:this={field}
		id="email"
		name="email"
		type="email"
		class={['control-input', email ? 'has-value' : '', rejected || serverError ? 'is-invalid' : '']
			.filter(Boolean)
			.join(' ')}
		placeholder="your@email.com"
		value={email}
		oninput={onInput}
		autocomplete="email"
		spellcheck="false"
		autocorrect="off"
		autocapitalize="off"
		required
		aria-invalid={rejected || serverError || undefined}
		aria-describedby="signup-status"
	/>
	<button type="submit" class="control-btn">sign up</button>
	{#if children}{@render children()}{/if}

	<!-- Announced to screen readers as it changes, not just drawn - and it is
	     what carries the rejection for anyone who cannot see the field go red,
	     which is the job the native bubble used to do. -->
	<p
		id="signup-status"
		class={rejected || serverError ? 'control-status is-invalid' : 'control-status'}
		role="status"
		aria-live="polite"
	>
		{rejected
			? 'that address does not look right.'
			: serverError
				? 'something went wrong. try again.'
				: signedUp
					? `${signedUp} is on the list.`
					: ' '}
	</p>
</form>
