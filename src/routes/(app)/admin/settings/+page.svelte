<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	import Notice from '$lib/components/Notice.svelte';
	import { stamp } from '$lib/status';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>settings · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">settings</h1>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">launch</h2>
		<span class={['badge', data.launched ? 'is-good' : 'is-waiting']}>
			{data.launched ? 'open' : 'closed'}
		</span>
	</header>

	<form method="POST" action="?/launch" class="panel-body form" use:enhance>
		<label class="check-field">
			<input type="checkbox" name="launched" checked={data.launched} />
			the site is open to everyone
		</label>
		<span class="form-hint">
			while this is off, only staff get past the door. it is checked before anyone is sent to hack
			club to sign in, not after they come back.
		</span>

		<div class="form-field">
			<label class="form-label" for="prelaunchMessage">what the closed page says</label>
			<textarea
				id="prelaunchMessage"
				name="prelaunchMessage"
				class="control-textarea"
				maxlength="500"
				value={data.prelaunchMessage}></textarea>
		</div>

		<div class="form-actions">
			<button type="submit" class="control-btn">save</button>
		</div>
	</form>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">shop window</h2>
		<span class={['badge', data.shopOpen ? 'is-good' : 'is-waiting']}>
			{data.shopOpen ? 'open' : 'closed'}
		</span>
	</header>

	<form method="POST" action="?/shop" class="panel-body form" use:enhance>
		<label class="check-field">
			<input type="checkbox" name="shopOpen" checked={data.shopOpen} />
			things can be bought
		</label>

		<div class="form-field">
			<label class="form-label" for="shopClosesAt">hard close (UTC)</label>
			<input
				id="shopClosesAt"
				name="shopClosesAt"
				class="control-input"
				type="datetime-local"
				value={data.shopClosesAt}
			/>
			<span class="form-hint">
				once this has passed the shop is closed whatever the switch above says. reopening means
				moving the date, which is deliberate - a deadline already promised to people should not be
				undone by forgetting to turn a switch off.
			</span>
		</div>

		<div class="form-field">
			<label class="form-label" for="shopClosedMessage">what the shop says when closed</label>
			<textarea
				id="shopClosedMessage"
				name="shopClosedMessage"
				class="control-textarea"
				maxlength="500"
				value={data.shopClosedMessage}></textarea>
		</div>

		<div class="form-actions">
			<button type="submit" class="control-btn">save</button>
		</div>
	</form>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">what this deployment is wired to</h2>
		<span class="panel-note">names, never values</span>
	</header>

	<div class="panel-body">
		{#each data.integrations as integration (integration.name)}
			<div class="row">
				<span class="row-label">
					{integration.name}
					<span class="row-hint">
						{integration.on
							? integration.note
							: `not set: ${integration.missing.join(', ')} - ${integration.note}`}
					</span>
				</span>
				<span class={['badge', integration.on ? 'is-good' : 'is-waiting']}>
					{integration.on ? 'on' : 'off'}
				</span>
			</div>
		{/each}

		{#each data.callbacks as callback (callback.name)}
			<div class="row">
				<span class="row-label">
					{callback.name} redirect uri
					<span class="row-hint">
						register this exact string on the {callback.name} client. it is derived from the host serving
						this page, not from a variable.
					</span>
				</span>
				<span class="row-value">{callback.uri}</span>
			</div>
		{/each}

		<div class="row">
			<span class="row-label">last changed</span>
			<span class="row-value">{stamp(data.updatedAt)}</span>
		</div>
	</div>
</section>
