<script lang="ts">
	/**
	 * Link Hackatime, then say where to ship. Next unlocks once Hackatime is
	 * linked AND the address is either set or explicitly skipped - the OneKey
	 * rule: you cannot glide past the address without deciding about it, but
	 * deciding "later" is allowed.
	 */
	import { untrack } from 'svelte';

	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import InfoTip from '$lib/components/InfoTip.svelte';
	import Notice from '$lib/components/Notice.svelte';

	let { data, form }: PageProps = $props();

	/* The "address saved" notice's ×, put back by the next save. */
	let savedDismissed = $state(false);
	$effect(() => {
		void form;
		savedDismissed = false;
	});

	const qs = $derived(data.preview ? '?preview' : '');

	const linked = $derived(!!data.hackatime);

	/* The address is "done" when there is a default already, or one was just
	   saved, or the person chose to deal with it later. Client-side on purpose -
	   skipping is a decision about this screen, not a thing to write down. */
	let skipped = $state(false);
	const addressDone = $derived(data.defaultAddressId !== null || !!form?.savedAddress || skipped);

	const canProceed = $derived(linked && addressDone);

	const addressState = $derived(
		data.defaultAddressId !== null || form?.savedAddress ? 'set' : skipped ? 'later' : 'optional'
	);

	/* Which address is selected in the picker. Starts on the current default;
	   untracked so it seeds once rather than snapping back on every data change,
	   the same way the account page's picker does. */
	let addressId = $state(untrack(() => data.defaultAddressId ?? ''));

	/* The selected address, written out under the picker - the same preview the
	   account page shows, so what you are choosing is legible before you save. */
	const chosenAddress = $derived(data.addresses.find((a) => a.id === addressId) ?? null);
</script>

<svelte:head>
	<title>setup · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">let's get you set up</h1>
</header>

<!-- ── hackatime ─────────────────────────────────────────────────────────── -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">hackatime</h2>
		<!-- Keyed, so a change of state is a new badge arriving rather than the
		     old one's words being swapped under it. -->
		{#key linked}
			<span class={['badge rise', linked ? 'is-done' : 'is-waiting']}
				>{linked ? 'linked' : 'required'}</span
			>
		{/key}
	</header>

	<div class="panel-body ht-body">
		<div class="ht-content">
			<p class="panel-prose">
				hackatime is the tool you'll use to track your coding time. if you want to learn more or
				need help setting up, the tutorial has you covered.
			</p>

			{#if data.hackatimeConfigured || linked}
				<div class="ob-actions">
					{#if linked}
						<span class="control-btn is-quiet" aria-disabled="true">hackatime linked</span>
					{:else}
						<!-- The hackatime OAuth start route, with a redirect back to this step;
				     a query string on our own route, not an external link. -->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							class="control-btn"
							href={`${resolve('/api/auth/hackatime/start')}?redirectTo=/onboarding/setup${data.preview ? '%3Fpreview' : ''}`}
							data-sveltekit-reload
						>
							link hackatime
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}

					<!-- The setup walkthrough, drawn from OneKey. Off origin, new tab.
				     A solid button, not is-quiet - quiet is a step DOWN the ramp, which
				     on the panel's own fill recedes into it; the raised fill stands
				     off the reading surface the way a secondary action should. -->
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a
						class="control-btn ob-tutorial"
						href="https://www.youtube.com/watch?v=grriwsX5mIo"
						target="_blank"
						rel="noreferrer"
					>
						tutorial
					</a>
				</div>
			{/if}

			{#if !data.hackatimeConfigured && !linked}
				<Notice
					bad
					title="hackatime is not configured on this instance"
					body="there is nowhere to send you, so setup cannot be finished here yet."
				/>
			{/if}
		</div>

		<!-- The hackatime icon, run through the same dither filter every photograph
		     on the site goes through (see Dither.svelte) - greyed and snapped to the
		     field's seven levels, so it is made of the same cells as the ground
		     rather than a glossy sticker.

		     Wrapped and the image absolutely positioned, so the icon takes its
		     height from the box rather than the box from the icon: the box stretches
		     to the text column beside it (align-items: stretch), and the picture
		     fills whatever height that is. A bare img would instead push the row to
		     its own 256px and never shrink. -->
		<div class="ht-logo">
			<img class="ht-logo-img" src="/hackatime-icon.png" alt="Hackatime" width="256" height="256" />
		</div>
	</div>
</section>

<!-- ── address ───────────────────────────────────────────────────────────── -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">shipping address</h2>
		<!-- Out of the title and into the head row, so the head's own gap spaces it
		     from the words the way it spaces the badge, and align-items:center puts
		     the mark and the badge on one line. -->
		<InfoTip label="why we need an address">
			for your hard work you'll get prizes and your ticket to the event - we need a real address to
			send them to. you can add it later; it is only needed to ship a project.
		</InfoTip>
		{#key addressState}
			<span class={['badge rise', addressDone ? 'is-done' : 'is-waiting']}>{addressState}</span>
		{/key}
	</header>

	<div class="panel-body">
		{#if form?.error}
			<Notice bad alert body={form.error} />
		{/if}
		<!-- Said as a notice at the top of the panel it happened in, rather
		     than as a word beside the button. -->
		{#if form?.savedAddress && !savedDismissed}
			<Notice
				title="address saved"
				body="that's where we'll send things you order from now on."
				ondismiss={() => (savedDismissed = true)}
			/>
		{/if}

		{#if data.addressError}
			<Notice
				bad
				title="we couldn't read your Hack Club addresses"
				body="you can still carry on - this is only needed to ship a project, and you can set it later on your account."
			/>
		{:else if data.addresses.length === 0}
			<p class="panel-prose">
				we ship to an address on your Hack Club account, and there is not one there yet. you only
				need it to ship a project, so it can wait.
			</p>
			<!-- hca's own address page, off this origin, built server-side from
			     the configured host (hcaAddressPortalUrl). A block disable rather
			     than the next-line kind the tutorial link above uses: that one's
			     href is a literal, so the rule reports it at the element and the
			     comment lands on it, while a bound href is reported at the
			     attribute - a line no comment can sit above once prettier has
			     wrapped the tag. -->
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				class="control-btn is-small ob-inline"
				href={data.addressPortalUrl}
				target="_blank"
				rel="noreferrer">add one at Hack Club</a
			>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{:else}
			<form method="POST" action="?/saveAddress" class="ob-address" use:enhance>
				<div class="select-field">
					<select name="address_id" class="control-select" bind:value={addressId}>
						{#each data.addresses as address (address.id)}
							<option value={address.id}>{address.label}</option>
						{/each}
					</select>
					<span class="select-caret" aria-hidden="true">▼</span>
				</div>

				{#if chosenAddress}
					<!-- Keyed on the choice, so picking another address shows the new
					     one arriving under the picker. -->
					{#key chosenAddress.id}
						<address class="envelope rise" style="--dir-x: 0; --dir-y: 1">
							{#each chosenAddress.lines as line, i (i)}
								<span>{line}</span>
							{/each}
						</address>
					{/key}
				{/if}

				<div class="ob-address-actions">
					<button type="submit" class="control-btn">save</button>

					<span class="panel-prose ob-portal">
						<!-- hca's address page, off origin; see the block above. -->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						wrong or out of date?
						<a href={data.addressPortalUrl} target="_blank" rel="noreferrer">edit it at Hack Club</a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</span>
				</div>
			</form>
		{/if}

		{#if !addressDone}
			<button type="button" class="ob-skip" onclick={() => (skipped = true)}>
				i'll do this later
			</button>
		{/if}
	</div>
</section>

<!-- ── nav ───────────────────────────────────────────────────────────────── -->
<div class="ob-nav">
	<!-- eslint-disable svelte/no-navigation-without-resolve -- onboarding paths
	     from resolve() with ?preview appended for the dev walkthrough. -->
	<a
		data-sveltekit-noscroll
		class="control-btn is-quiet nudge is-back"
		href={`${resolve('/(app)/onboarding')}${qs}`}><ArrowLeft size={16} /> back</a
	>
	{#if canProceed}
		<a
			data-sveltekit-noscroll
			class="control-btn is-large lit nudge"
			href={`${resolve('/(app)/onboarding/expectations')}${qs}`}>next <ArrowRight size={16} /></a
		>
	{:else}
		<span class="control-btn is-large ob-disabled nudge" aria-disabled="true"
			>next <ArrowRight size={16} /></span
		>
	{/if}
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</div>

<style>
	.ob-inline {
		align-self: flex-start;
	}

	/* The primary and the tutorial side by side, left-aligned. */
	.ob-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	/* Two columns: the words on the left, the icon filling the room the wide
	   panel opened on the right. The body's own column layout moves into
	   .ht-content so the prose and buttons still stack. */
	.ht-body {
		flex-direction: row;
		align-items: stretch;
		gap: 24px;
	}

	.ht-content {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	/* Wrap the description sooner than the panel's default 56ch, so it hugs the
	   left and leaves the icon its air rather than running toward it. */
	.ht-content .panel-prose {
		max-width: 46ch;
	}

	/* The box: a definite width so it always renders, its height stretched to the
	   text column beside it. */
	.ht-logo {
		flex: none;
		position: relative;
		align-self: stretch;
		width: clamp(104px, 20%, 150px);
	}

	/* The picture, absolutely filling the box so it contributes no height of its
	   own to the row - object-fit: contain keeps it square and sizes it to
	   whatever height the box was stretched to. */
	.ht-logo-img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		/* Brightened before the dither, then a dark halo from the drop-shadow that
		   traces the icon's alpha - the edge stands off the panel whatever the cells
		   inside land on, which a brightness value alone could not manage on a
		   surface this close to the icon's own grey. */
		filter: brightness(1.05) contrast(1.15) url(#dither) drop-shadow(0 1px 3px rgba(0, 0, 0, 0.65));
	}

	/* On a phone the panel is already full, and a column layout would drop the
	   icon under the text as a big square. Hidden there. */
	@media (max-width: 620px) {
		.ht-body {
			flex-direction: column;
			align-items: stretch;
		}

		.ht-logo {
			display: none;
		}
	}

	/* Stacked, not a row: the picker takes the full width - which is what makes
	   it read at full size rather than squeezed beside its button - the preview
	   sits under it, and the save button is its own row below. */
	.ob-address {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ob-address-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	/* A secondary that stands off the panel: is-quiet one rung up the ramp. Quiet
	   rests on #3a3a40, a step BELOW the panel, so on this surface it sinks in;
	   this rests on the lift level above the panel and reads as raised. Hover is
	   is-quiet's own - up to the full light fill. */
	.ob-tutorial {
		color: var(--ink);
		background-color: var(--level-lift);
		border-color: var(--panel-line);
		background-image: var(--weave-bayer), var(--shade-inset);
	}

	.ob-tutorial:hover,
	.ob-tutorial:focus-visible {
		color: var(--on-light);
		background-color: var(--ink);
		border-color: var(--ink);
		background-image: var(--weave-bayer-hard), var(--shade-raised);
	}

	/* Inline with the save button, pushed to the right end of the actions row. */
	.ob-portal {
		margin-left: auto;
		font-size: var(--text-xs);
	}

	/* A link in running text. The site-wide rule for these is scoped to `.shell`
	   (forms.css), and onboarding resets out of that layout - so the classless
	   anchor here would fall back to the browser's blue. Same treatment, stated
	   locally: the near-white ink, dotted, white on hover. */
	.ob-portal a {
		color: var(--fg);
		text-decoration: underline dotted;
		text-underline-offset: 2px;
	}

	.ob-portal a:hover,
	.ob-portal a:focus-visible {
		color: #ffffff;
		outline: none;
	}

	/* A plain, quiet "later": text, dotted underline, the ink - not a button,
	   because it is the lesser of the two ways off this step and should not look
	   like the thing to press. */
	.ob-skip {
		align-self: flex-start;
		padding: 0;
		font: inherit;
		font-size: var(--text-xs);
		color: var(--ink-mid);
		background: none;
		border: 0;
		text-decoration: underline dotted;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.ob-skip:hover,
	.ob-skip:focus-visible {
		color: var(--ink);
		outline: none;
	}

	.ob-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	/* Greyed and inert, the same shape as the live next. */
	.ob-disabled {
		background-color: var(--level-lift);
		border-color: var(--panel-line);
		color: var(--ink-dim);
		background-image: none;
		cursor: not-allowed;
	}
</style>
