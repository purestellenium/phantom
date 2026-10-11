<script lang="ts">
	/**
	 * The account page: who you are, as Hack Club reports it, and where you
	 * are signed in.
	 *
	 * Everything about you is read rather than edited. Every field belongs to
	 * Hack Club's account system and is refreshed at each sign-in; a form here
	 * that appeared to change any of them would be editing a cache of somebody
	 * else's record. So they are read out, not drawn as fields.
	 */
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import DitherAvatar from '$lib/components/dither/DitherAvatar.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import SignOutButton from '$lib/components/SignOutButton.svelte';
	import { stamp } from '$lib/status';

	let { data, form }: PageProps = $props();

	/* The "address saved" notice's ×, put back by the next save. */
	let savedDismissed = $state(false);
	$effect(() => {
		void form;
		savedDismissed = false;
	});

	/* The default, for the envelope under the picker. */
	let addressId = $state(untrack(() => data.defaultAddressId ?? ''));
	const chosenAddress = $derived(
		data.addresses.find((address) => address.id === addressId) ?? null
	);
</script>

<!-- The plain hrefs go to Hack Club's address portal, off this origin;
     in-app navigation goes through resolve(). -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->

<svelte:head>
	<title>account · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">account</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">profile</h2>
	</header>
	<div class="panel-body account">
		<!-- ── the fields, locked ─────────────────────────────────────────────── -->
		<dl class="account-facts">
			<div>
				<dt>name</dt>
				<dd>{data.user.displayName ?? '-'}</dd>
			</div>
			<div>
				<dt>email</dt>
				<dd>{data.user.email}</dd>
			</div>
			<div>
				<dt>slack</dt>
				<dd>{data.user.slackId ?? '-'}</dd>
			</div>
			<div>
				<dt>hackatime</dt>
				<dd class="account-hackatime">
					{#if data.hackatime}
						{data.hackatime.accountId}
					{:else}
						<span class="badge is-waiting">not linked</span>
					{/if}
					{#if data.hackatimeConfigured}
						{#if data.hackatime}
							<!-- A word, not a button: relinking is a rare repair, and a
							     button beside an id read as the id's own control. -->
							<a
								class="account-relink"
								href={resolve('/api/auth/hackatime/start?redirectTo=/account')}>relink</a
							>
						{:else}
							<a
								class="control-btn is-small"
								href={resolve('/api/auth/hackatime/start?redirectTo=/account')}>link hackatime</a
							>
						{/if}
					{/if}
				</dd>
			</div>
		</dl>

		<!-- ── the picture ────────────────────────────────────────────────────── -->
		<div class="account-picture">
			<span class="account-picture-label">profile picture</span>
			{#if data.user.avatarUrl}
				<img class="account-face" src={data.user.avatarUrl} alt="" />
			{:else}
				<DitherAvatar name={data.user.email} class="account-face" />
			{/if}
		</div>
	</div>
</section>

<!-- Where things ship: the one thing on this page that is chosen here rather
     than read from Hack Club, so it has a panel of its own. -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">shipping</h2>
	</header>
	<form class="panel-body form" method="POST" action="?/defaultAddress" use:enhance>
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
			<Notice bad body="we couldn't read your Hack Club addresses. try again in a moment." />
		{:else if data.addresses.length === 0}
			<!-- No addresses on the account, so there is nothing to choose between
			     and no "default" for a label to name - a field label over a single
			     button describes a control that is not there. What is left is one
			     action, so it gets the treatment the one action a section IS gets:
			     the solid fill, full width, rather than a quiet little link tucked
			     under a heading. -->
			<p class="form-hint">
				we ship to an address on your Hack Club account, and there is not one on file yet. adding it
				there keeps it in one place - phantom never holds its own copy.
			</p>
			<a class="control-btn is-wide" href={data.addressPortalUrl} target="_blank" rel="noreferrer"
				>add an address at Hack Club</a
			>
		{:else}
			<div class="form-field">
				<label class="form-label" for="address_id">default address</label>
				<div class="select-field">
					<select id="address_id" name="address_id" class="control-select" bind:value={addressId}>
						{#each data.addresses as address (address.id)}
							<option value={address.id}>{address.label}</option>
						{/each}
					</select>
					<span class="select-caret" aria-hidden="true">▼</span>
				</div>
				{#if chosenAddress}
					<address class="envelope">
						{#each chosenAddress.lines as line, i (i)}
							<span>{line}</span>
						{/each}
					</address>
				{/if}
				<span class="form-hint"
					>wrong or out of date? <a href={data.addressPortalUrl} target="_blank" rel="noreferrer"
						>edit it at Hack Club</a
					></span
				>
			</div>
			<div class="form-actions">
				<button type="submit" class="control-btn is-small">save</button>
			</div>
		{/if}
	</form>
</section>

<!-- Where you are signed in. The sessions table stores a truncated network
     prefix rather than an address - a /24 answers "somewhere else entirely",
     which is the question this panel exists for, without the table becoming a
     location history. See toIpPrefix in $lib/server/auth/session.ts. -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">sessions</h2>
		<span class="panel-note">{data.sessions.length} devices</span>
	</header>

	<div class="panel-body">
		{#each data.sessions as session (session.id)}
			<div class="row">
				<span class="row-label">
					{session.id === data.currentSessionId ? 'this device' : 'another device'}
					<span class="row-hint">
						{[session.userAgent, session.ipPrefix].filter(Boolean).join(' · ') ||
							'no details recorded'}
					</span>
				</span>
				<span class="row-value">{stamp(session.lastSeenAt)}</span>
			</div>
		{/each}
	</div>

	<div class="panel-foot">
		<SignOutButton />
		{#if data.sessions.length > 1}
			<form method="POST" action="?/signOutOthers" use:enhance>
				<button type="submit" class="control-btn is-danger">sign out everywhere else</button>
			</form>
		{/if}
	</div>
</section>

<style>
	/* Fields on the left, the picture on the right; one column on a phone. */
	.account {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 220px;
		gap: 24px;
		align-items: start;
	}

	/* Read, not edited: a label over each value, on its own rule. */
	.account-facts {
		margin: 0;
		min-width: 0;
	}

	.account-facts > div {
		padding: 8px 0;
	}

	.account-facts > div:first-child {
		padding-top: 0;
	}

	.account-facts dt,
	.account-picture-label {
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--ink-dim);
	}

	.account-facts dd {
		margin: 4px 0 0;
		font-size: var(--text-base);
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.account-picture {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* The face: the picture Hack Club reports, which is the slack one, round,
	   dithered like every photograph here, in colour when reached. */
	.account-face,
	:global(.account-face.dk-avatar) {
		display: block;
		width: 220px;
		height: 220px;
		object-fit: cover;
		overflow: hidden;
		border-radius: 50%;
		border: 1px solid var(--panel-line);
		background-color: var(--bg);
	}

	img.account-face {
		filter: url(#dither);
	}

	.account-face:hover {
		filter: none;
	}

	.account-hackatime {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.account-relink {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--ink);
		text-decoration: underline dotted;
		text-underline-offset: 3px;
	}

	.account-relink:hover,
	.account-relink:focus-visible {
		color: #ffffff;
		outline: none;
	}

	@media (max-width: 700px) {
		.account {
			grid-template-columns: 1fr;
		}

		.account-picture {
			order: -1;
		}
	}
</style>
