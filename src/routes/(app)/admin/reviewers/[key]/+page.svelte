<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import DitherAvatar from '$lib/components/dither/DitherAvatar.svelte';
	import { OUTBOX_STATUS, SUBMISSION_STATE, hours, stamp } from '$lib/status';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.person.name} · reviewers · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">{data.person.name}</h1>
</header>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">first passes sent to airtable</h2>
		<span class="panel-note">
			{#if data.person.userId && data.canOpenPeople}
				<a href={resolve('/(app)/admin/users/[id]', { id: data.person.userId })}>their account</a>
			{:else if data.person.slackId}
				slack {data.person.slackId}
			{/if}
		</span>
	</header>

	<div class="panel-body">
		<div class="person">
			<span class="person-face">
				{#if data.person.avatarUrl}
					<img class="person-img" src={data.person.avatarUrl} alt="" />
				{:else}
					<DitherAvatar name={data.person.name} class="person-img" />
				{/if}
			</span>
			<div class="figures">
				<span class="figure"
					><span class="figure-value">{data.person.credited}</span>
					<span class="figure-label">credited</span></span
				>
				<span class="figure"
					><span class="figure-value">{data.person.week}</span>
					<span class="figure-label">past 7 days</span></span
				>
				<span class="figure"
					><span class="figure-value">{data.person.month}</span>
					<span class="figure-label">past 30 days</span></span
				>
				<span class="figure"
					><span class="figure-value">{hours(data.person.creditedSeconds)}</span>
					<span class="figure-label">hours filed</span></span
				>
			</div>
		</div>
	</div>
</section>

{#snippet creditRow(credit: (typeof data.credits)[number])}
	{@const state = SUBMISSION_STATE[credit.submissionState]}
	{@const status = OUTBOX_STATUS[credit.status]}
	<a
		class="row"
		href={resolve('/(app)/projects/[number]', { number: String(credit.projectNumber) })}
	>
		<span class="row-label">
			{credit.submissionName}
			<span class="row-hint">
				by {credit.ownerName} · {hours(credit.awardedSeconds)} · {credit.source === 'ari'
					? 'on ari'
					: 'on the old desk'} · {stamp(credit.at)}
			</span>
		</span>
		<span class="row-value credit-badges">
			{#if credit.status !== 'delivered'}
				<span class={['badge', status.tone]} title={status.hint}>airtable {status.label}</span>
			{/if}
			{#if credit.submissionState !== 'approved'}
				<span class={['badge', state.tone]}>{state.label}</span>
			{/if}
		</span>
	</a>
{/snippet}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">credited ships</h2>
		<span class="panel-note">newest first</span>
	</header>

	<div class="panel-body">
		{#each data.credits as credit (credit.outboxId)}
			{@render creditRow(credit)}
		{:else}
			<p class="panel-prose">nothing credited yet.</p>
		{/each}
	</div>
</section>

{#if data.unfiled.length > 0}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">not filed</h2>
			<span class="panel-note">failed or skipped at airtable · not counted</span>
		</header>

		<div class="panel-body">
			{#each data.unfiled as credit (credit.outboxId)}
				{@render creditRow(credit)}
			{/each}
		</div>
	</section>
{/if}

<style>
	.figures :global(.figure) {
		flex-grow: 0;
	}

	.person {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		align-items: center;
	}

	.person-face :global(.person-img) {
		width: 48px;
		height: 48px;
	}

	.credit-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		justify-content: flex-end;
	}
</style>
