<script lang="ts">
	import { fragments } from '$lib/fragments';
	import HyperChroma from '$lib/components/HyperChroma.svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Log from '$lib/components/Log.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import {
		ELIGIBILITY,
		ORDER_STATE,
		PROJECT_STATUS,
		VERIFICATION,
		day,
		hours,
		stamp
	} from '$lib/status';

	let { data, form }: PageProps = $props();

	const verification = $derived(VERIFICATION[data.subject.verificationStatus]);
	const eligibility = $derived(ELIGIBILITY[data.subject.eligibility]);
	const drift = $derived(data.cached !== data.replayed);

	/* The projects panel is capped; this is where the rest of them live. */
	const allProjectsHref = $derived(
		`${resolve('/(app)/admin/projects')}?q=${encodeURIComponent(data.subject.email)}`
	);
</script>

<svelte:head>
	<title>{data.subject.displayName ?? data.subject.email} · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">{data.subject.displayName ?? data.subject.email}</h1>
	<p class="page-lede">{data.subject.email}</p>
</header>

{#if form?.error}
	<Notice bad alert body={form.error} />
{/if}
{#if form?.notice}
	<Notice alert body={form.notice} />
{/if}

{#if !data.acting.ok}
	<Notice title="read only" body={data.acting.reason} />
{/if}

{#if drift}
	<Notice
		bad
		title="this balance does not add up"
		body="the cached number is {fragments(data.cached)} and replaying the entries gives {fragments(
			data.replayed
		)}. the entries are the authority. something wrote to the ledger outside the ledger module."
	/>
{/if}

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">who they are</h2>
		<span class="panel-note">{data.subject.role}</span>
	</header>

	<div class="panel-body">
		<div class="row">
			<span class="row-label">
				identity verification
				<span class="row-hint">{verification.hint}</span>
			</span>
			<span class={['badge', verification.tone]}>{verification.label}</span>
		</div>

		<div class="row">
			<span class="row-label">
				eligibility
				<span class="row-hint">
					{data.subject.eligibilityRule
						? `rule ${data.subject.eligibilityRule}, decided ${day(data.subject.eligibilityAt)}`
						: 'never derived'}
				</span>
			</span>
			<span class={['badge', eligibility.tone]}>{eligibility.label}</span>
		</div>

		<div class="row">
			<span class="row-label">
				Hack Club id
				<span class="row-hint">
					the `sub` claim. the only identifier upstream promises is stable, and what this account is
					keyed on.
				</span>
			</span>
			<span class="row-value">{data.subject.hcaSubject}</span>
		</div>

		<div class="row">
			<span class="row-label">
				slack
				{#if data.subject.slackId}<span class="row-hint">{data.subject.slackId}</span>{/if}
			</span>
			<span class="row-value"
				>{data.subject.slackUsername
					? `@${data.subject.slackUsername}`
					: (data.subject.slackId ?? '-')}</span
			>
		</div>

		<div class="row">
			<span class="row-label">joined</span>
			<span class="row-value">{day(data.subject.createdAt)}</span>
		</div>

		<div class="row">
			<span class="row-label">last seen</span>
			<span class="row-value">{stamp(data.subject.lastSeenAt)}</span>
		</div>
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">balance</h2>
		<span class="panel-note">{fragments(data.replayed)}</span>
	</header>

	<div class="panel-body">
		<div class="figures">
			<div class="figure">
				<span class="figure-value">{fragments(data.replayed)}</span>
				<span class="figure-label">replayed from entries</span>
			</div>
			<div class="figure">
				<span class="figure-value">{fragments(data.cached)}</span>
				<span class="figure-label">cached projection</span>
			</div>
		</div>

		<Log entries={data.log} />
	</div>

	{#if data.canAdjust}
		<form method="POST" action="?/adjust" class="panel-foot form" use:enhance>
			<div class="form-grid">
				<div class="form-field">
					<label class="form-label" for="minutes">minutes (negative to take away)</label>
					<input
						id="minutes"
						name="minutes"
						class="control-input"
						type="number"
						step="1"
						required
					/>
				</div>
				<div class="form-field">
					<label class="form-label" for="reason">why</label>
					<input
						id="reason"
						name="reason"
						class="control-input"
						type="text"
						maxlength="200"
						required
					/>
				</div>
			</div>
			<span class="form-hint">
				this creates value out of nothing and is recorded with your name on it. an adjustment can
				take a balance negative, which blocks every purchase and shows as a debt rather than as a
				hole.
			</span>
			<div class="form-actions">
				<button type="submit" class="control-btn">adjust</button>
			</div>
		</form>
	{/if}
</section>

{#if data.acting.ok}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">role</h2>
		</header>

		<form method="POST" action="?/role" class="panel-body form" use:enhance>
			<div class="form-field">
				<label class="form-label" for="role">rank</label>
				<div class="select-field">
					<select id="role" name="role" class="control-select" value={data.selectedRole}>
						{#each data.roles as role (role)}
							<option value={role}>{role}</option>
						{/each}
					</select>
					<span class="select-caret" aria-hidden="true">▼</span>
				</div>
				<span class="form-hint">
					you cannot promote anyone to your own rank or above, and you cannot change your own.
				</span>
			</div>
			<div class="form-actions">
				<button type="submit" class="control-btn">set role</button>
			</div>
		</form>
	</section>

	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">capabilities</h2>
			<span class="panel-note">{data.subject.capabilityCount} granted</span>
		</header>

		<form method="POST" action="?/capabilities" class="panel-body form" use:enhance>
			{#each data.capabilities as capability (capability.name)}
				<!-- Disabled inputs are not submitted, which is exactly right here:
				     the action preserves anything the actor cannot touch, so a
				     capability they lack is neither granted nor stripped by a form they
				     could not fill in. -->
				<label class="check-field">
					<input
						type="checkbox"
						name="capability"
						value={capability.name}
						checked={capability.held}
						disabled={!capability.mayTouch}
					/>
					{capability.name} - {capability.label}{capability.mayTouch
						? ''
						: ' (you do not hold this)'}
				</label>
			{/each}

			<span class="form-hint">
				a role already implies a base set; these are grants on top of it. you can only hand out what
				you hold yourself.
			</span>

			<div class="form-actions">
				<button type="submit" class="control-btn">save capabilities</button>
			</div>
		</form>
	</section>
{/if}

<!-- Projects before orders: what somebody has MADE is the first question an
     operator opens this page with, and a draft here is the only place one shows
     up outside its owner's own list. -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">projects</h2>
		<span class="panel-note">{data.projects.length}{data.moreProjects ? '+' : ''}</span>
	</header>

	<div class="panel-body">
		{#if data.projects.length === 0}
			<p class="panel-prose">nothing started.</p>
		{:else}
			{#each data.projects as project (project.id)}
				{@const status = PROJECT_STATUS[project.status]}
				<a
					class="row"
					href={resolve('/(app)/projects/[number]', { number: String(project.number) })}
				>
					<span class="row-label">
						#{project.number}
						{project.name}
						<span class="row-hint">
							started {day(project.createdAt)}
							{#if project.ships > 0}· {project.ships}
								{project.ships === 1 ? 'ship' : 'ships'} · {hours(project.approvedSeconds)} approved{/if}
						</span>
					</span>
					{#if project.hyperChroma}<HyperChroma />{/if}
					{#if project.archived}<span class="badge is-done">archived</span>{/if}
					<span class={['badge', status.tone]}>{status.label}</span>
				</a>
			{/each}
			{#if data.moreProjects}
				<!-- The panel stops; the list does not. Filtered to this person by
				     email, which the projects search matches through `personMatches`. -->
				<div class="row-actions">
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the path half is resolve()d; the rule cannot see through the concatenation -->
					<a class="control-btn is-small is-quiet" href={allProjectsHref}
						>see all of their projects</a
					>
				</div>
			{/if}
		{/if}
	</div>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">orders</h2>
		<span class="panel-note">{data.orders.length}</span>
	</header>

	<div class="panel-body">
		{#if data.orders.length === 0}
			<p class="panel-prose">nothing bought.</p>
		{:else}
			{#each data.orders as order (order.id)}
				{@const state = ORDER_STATE[order.state]}
				<a class="row" href={resolve('/(app)/admin/orders/[id]', { id: order.id })}>
					<span class="row-label">
						{order.quantity} × {order.productName}
						<span class="row-hint">{day(order.createdAt)} · {fragments(order.totalPrice)}</span>
					</span>
					<span class={['badge', state.tone]}>{state.label}</span>
				</a>
			{/each}
		{/if}
	</div>
</section>

<!-- The shop lock: the invite and the flight stipend only (see
     $lib/shop/locked.ts). Read only to an operator who cannot act on them. -->
<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">shop</h2>
		{#if data.subject.shopLocked}<span class="badge is-changes">limited</span>{/if}
	</header>
	<form method="POST" action="?/shopLock" class="panel-body form" use:enhance>
		<label class="check-field">
			<input
				type="checkbox"
				name="shop_locked"
				checked={data.subject.shopLocked}
				disabled={!data.acting.ok}
			/>
			only let them buy the invite and the flight stipend
		</label>
		<span class="form-hint">
			for someone who has received a visa letter or a flight stipend - they're told that's why. it
			lifts by itself once they buy the invite. everything else in the shop is hidden from them, and
			refused if they try. their balance is untouched.
		</span>
		{#if data.acting.ok}
			<div class="form-actions">
				<button type="submit" class="control-btn is-small">save</button>
			</div>
		{/if}
	</form>
</section>

<section class="panel">
	<header class="panel-head">
		<h2 class="panel-title">sessions</h2>
		<span class="panel-note">{data.sessions.length} live</span>
	</header>

	<div class="panel-body">
		{#each data.sessions as session (session.id)}
			<div class="row">
				<span class="row-label">
					{session.ipPrefix ?? 'unknown network'}
					<span class="row-hint">{session.userAgent ?? 'no user agent recorded'}</span>
				</span>
				<span class="row-value">{stamp(session.lastSeenAt)}</span>
			</div>
		{/each}
		{#if data.sessions.length === 0}
			<p class="panel-prose">not signed in anywhere.</p>
		{/if}
	</div>

	{#if data.acting.ok && data.sessions.length > 0}
		<div class="panel-foot">
			<form method="POST" action="?/sessions" use:enhance>
				<button type="submit" class="control-btn is-danger">end every session</button>
			</form>
		</div>
	{/if}
</section>
