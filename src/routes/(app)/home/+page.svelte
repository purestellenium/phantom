<script lang="ts">
	/**
	 * The home page.
	 *
	 * Read top to bottom it answers three questions in order: how you are, how
	 * far you have got, and what to do next. The greeting and the figures
	 * are the first; the goal meter is the second; the pair of cards under it is
	 * the third, with what is left to set up on the left and what you have been
	 * working on on the right.
	 */
	import { onMount } from 'svelte';

	import { enhance } from '$app/forms';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	import { trackEvent } from '$lib/analytics/client';
	import InviteEnvelope from '$lib/components/InviteEnvelope.svelte';
	import Hours from '$lib/components/Hours.svelte';
	import Fragments from '$lib/components/Fragments.svelte';
	import FragmentsIntro from '$lib/components/FragmentsIntro.svelte';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { REFERRAL_MILESTONES, REFERRAL_STICKERS_SLUG } from '$lib/referral';
	import { motionOk, whenRevealed } from '$lib/reveal';
	import { INVITE_SLUG } from '$lib/shop/invite';
	import { fragments, toFragments } from '$lib/fragments';
	import { ELIGIBILITY, VERIFICATION } from '$lib/status';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import PixelIcon from '$lib/components/PixelIcon.svelte';

	let { data, form }: PageProps = $props();

	/**
	 * The time of day, read from the reader's own clock.
	 *
	 * In `onMount` rather than at init, and that is the whole trick: this page is
	 * server-rendered, the server is on UTC, and "good evening" printed for
	 * somebody whose morning it is would be worse than not greeting them at all.
	 * So the server sends the timeless wording, and the browser - which is the
	 * only party that knows what time it is where the reader is - replaces it
	 * once it has hydrated. `onMount` is what guarantees that assignment lands as
	 * a reactive update rather than being computed during hydration and quietly
	 * discarded along with the markup it would have changed.
	 *
	 * The swap is invisible in practice: on a cold load the dither cover is still
	 * over the page until well after hydration (see Loader.svelte), and a
	 * client-side navigation here never renders the fallback at all.
	 */
	let part = $state<string | null>(null);
	onMount(() => {
		const hour = new Date().getHours();
		part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
	});

	const greeting = $derived(part ? `good ${part}` : 'welcome back');

	/**
	 * What to call them: everything except the surname, lowercased.
	 *
	 * The display name is whatever HCA has, which is routinely a full name, and a
	 * page that opens with all three of somebody's names is addressing them like
	 * a form. Dropping only the LAST word rather than keeping only the first is
	 * what makes "Anna Kat Lecter" greet Anna Kat instead of Anna - a given name
	 * is not always one word, and cutting it in half is a worse greeting than
	 * using too much of it.
	 *
	 * A single word is left whole, since there is no surname to drop; the nav
	 * takes the first word only, because a tab is not a greeting and has one
	 * word's worth of room.
	 */
	const given = $derived.by(() => {
		const source = data.user.displayName?.trim() || data.user.email.split('@')[0];
		const parts = source.trim().split(/\s+/);
		return (parts.length > 1 ? parts.slice(0, -1) : parts).join(' ').toLowerCase();
	});

	/* What the invite costs, which is the whole of what the bar counts toward -
	   see the server's note. Zero stands in for "no invite exists", and the panel
	   that would draw it is not rendered at all in that case. */
	const goalSeconds = $derived(data.goalSeconds ?? 0);
	/**
	 * What the meter is measuring: hours saved toward the ticket.
	 *
	 * The balance, not lifetime earnings - the goal is being able to buy the
	 * thing, and hours already spent cannot buy it again. The bar is therefore a
	 * savings bar and can genuinely go down.
	 *
	 * There is no case where it has to survive the purchase draining fifty hours
	 * out of the account: once the invite is theirs the bar is gone and the panel
	 * says where they are going instead.
	 *
	 * Never a negative headline either: a net clawback reads as 0h, not −Xh.
	 */
	const shown = $derived(Math.max(0, data.balance));

	/**
	 * Hours logged, which arrives after the page does.
	 *
	 * Three states, and the two that are not a number are not the same thing.
	 * `undefined` is still asking - Hackatime is being counted and the tile says
	 * nothing yet. Null is asked and could not be answered, which is what an
	 * unlinked account looks like too, and reads as a dash: printing 0h there
	 * would tell somebody with four days of tracked time that they have none.
	 *
	 * Floored, because Hackatime is another company's arithmetic and a headline
	 * figure should not be the place a negative from it first shows up.
	 *
	 * Same guard as the address above, for the same navigate-away-and-back race.
	 */
	let logged = $state<number | null | undefined>(undefined);
	$effect(() => {
		let live = true;
		logged = undefined;
		void data.logged.seconds.then((answer) => {
			if (live) logged = answer === null ? null : Math.max(0, answer);
		});
		return () => {
			live = false;
		};
	});

	const pct = $derived(goalSeconds > 0 ? Math.min(100, (shown / goalSeconds) * 100) : 0);

	/**
	 * [1a] The meter fills in from empty once the page is on screen, alongside
	 * the figure above it counting up, so it reads as "this far, out of this
	 * far" rather than as a picture of a bar.
	 *
	 * The server draws it full-width to the balance, so without script it is
	 * simply right. On mount it is held empty with no transition, and released
	 * a couple of frames after the page is revealed - two, so the empty width
	 * is painted before the transition to the real one begins.
	 */
	let meterHeld = $state(false);
	onMount(() => {
		if (!motionOk()) return;
		meterHeld = true;
		return whenRevealed(() => {
			requestAnimationFrame(() => requestAnimationFrame(() => (meterHeld = false)));
		});
	});
	/* Clamped into [0, goal] so the progressbar's value stays inside its own
	   range even for someone who has logged past the goal. */
	const meterNow = $derived(Math.min(toFragments(goalSeconds), toFragments(shown)));
	/* Floored at zero so passing the goal reads as having reached it rather than
	   as owing negative hours. */
	const remaining = $derived(Math.max(0, goalSeconds - shown));

	/**
	 * Getting set up, as a checklist that fills itself in.
	 *
	 * Everything an account needs before it can do the thing it came for, and
	 * nothing after: link the tool that counts your hours, say where to send
	 * things, make something. Shipping and spending are not on it - those are the
	 * program rather than the setting-up, and a list that only ends when you have
	 * collected the prize is not a list anybody finishes.
	 *
	 * Every step reads its own done-ness off the same data the rest of the page
	 * is drawn from, so there is nothing to tick and nothing to remember: the
	 * card is a view of the account, not a to-do list with its own state. That is
	 * also why it cannot be dismissed - there is nothing to dismiss, only
	 * something to finish, and an account that has not linked Hackatime cannot
	 * earn an hour no matter how long it builds for.
	 *
	 * Verification is deliberately NOT a step. It is the notice above the goal,
	 * which is louder, says which of the several states you are in, and carries
	 * the link out to Hack Club; a row here as well would be the same sentence
	 * twice on one screen.
	 *
	 * Hackatime drops out of the list entirely where the instance has no
	 * credentials for it: the step would be a button that fails at the far end of
	 * a redirect, and the numbering closes up behind it rather than skipping 01.
	 */
	const steps = $derived(
		[
			data.hackatimeConfigured
				? {
						label: 'link hackatime',
						hint: data.hackatimeLinked
							? 'linked. your hours come from it when you ship.'
							: 'it watches your editor and counts the time. your hours are read from it when you ship, so nothing counts until it is linked.',
						done: data.hackatimeLinked,
						action: 'link',
						/* Resolved here rather than in the markup: `resolve` takes a route
						   it knows, and a href read off a variable is just a string to it. */
						href: resolve('/api/auth/hackatime/start?redirectTo=/home'),
						link: null
					}
				: null,
			{
				label: 'set an address',
				hint: data.hasAddress
					? 'chosen. change which one we ship to on your '
					: 'we ship to an address on your Hack Club account. choose one on your ',
				done: data.hasAddress,
				action: 'account',
				href: resolve('/(app)/account'),
				/* The link matters most on the DONE row, which has a badge where the
				   other rows keep their button - without it a finished step is the one
				   row on the card with no way through to the thing it is about. */
				link: { text: 'account page', href: resolve('/(app)/account') }
			},
			{
				label: 'start a project',
				hint:
					data.projects.count > 0
						? `you have ${data.projects.count} ${data.projects.count === 1 ? 'project' : 'projects'}. ship from your `
						: 'a name is enough to begin. the rest you fill in when you ship.',
				done: data.projects.count > 0,
				action: 'new project',
				href: resolve('/projects?new'),
				/* The projects card that used to sit beside this is gone, so the done
				   row links through to them instead. */
				link:
					data.projects.count > 0
						? { text: 'projects page', href: resolve('/(app)/projects') }
						: null
			}
		].filter((step) => step !== null)
	);

	const doneCount = $derived(steps.filter((step) => step.done === true).length);
	/**
	 * The first step we know to be unfinished, or -1 when there is none.
	 *
	 * `=== false` rather than `!step.done`, because a step can be in three
	 * states and only one of them is an answer. A step still being checked is
	 * not a step you are on - there is nothing to do about it, its own hint says
	 * so, and it has no button - so it cannot be the live row, and neither can
	 * anything hidden behind it: `findIndex` stops at the first FALSE and walks
	 * past a null, which is what lets the project step below be the live one
	 * while Hack Club is still answering about the address.
	 *
	 * -1 when everything is done, and nothing is lit then. A finished list has
	 * no position in it.
	 */
	const current = $derived(steps.findIndex((step) => step.done === false));

	/**
	 * What to say to somebody Hack Club has not cleared, if anything.
	 *
	 * The shop refuses most of the catalog and the ship button refuses outright
	 * for anyone not `eligible`, and until now both of those were the first
	 * anybody heard of it - the shop's own notice even points at this page for an
	 * explanation it did not carry. So it is said here, once, where they land.
	 *
	 * Three cases, and the difference between them is the whole reason the loader
	 * sends two signals rather than one:
	 *
	 * - Nothing sent yet, or we could not tell: verifying is the next action and
	 *   the notice carries the link to go and do it.
	 * - Sent, and with Hack Club: there is nothing to do. A "go and verify"
	 *   button here would be asking somebody to do again what they are waiting
	 *   on, which is how a support inbox fills up with duplicate submissions.
	 * - Refused, too young, over eighteen: a verification link is no use, because
	 *   the answer came back and it was no. The hints on these already say to
	 *   email us, which is the only move left.
	 *
	 * Not dismissible, for the reason the checklist is not: it is not a message
	 * about the page, it is the state of the account, and it goes away by being
	 * resolved.
	 */
	const verify = $derived.by(() => {
		/* The same test `eligibilityAllows` makes on the server - written out
		   because that module is server-only, and `=== 'eligible'` is the whole of
		   it. `undetermined` must never read as permission here either. */
		if (data.eligibility === 'eligible') return null;

		const waiting = data.verificationStatus === 'pending';
		const decision = ELIGIBILITY[data.eligibility];

		if (waiting) {
			return {
				bad: false,
				title: 'Hack Club is checking who you are',
				body: VERIFICATION.pending.hint,
				href: null
			};
		}

		/* Verifying is worth offering only where it is the thing that is missing.
		   `blocked_unverified` is that case by definition; `undetermined` is the
		   one where we could not reach Hack Club at all, and starting the check is
		   what settles it. */
		const actionable =
			data.eligibility === 'blocked_unverified' || data.eligibility === 'undetermined';

		return {
			bad: !actionable,
			title: actionable
				? 'the shop is closed until Hack Club verifies you'
				: `Hack Club says: ${decision.label}`,
			body: actionable
				? 'verifying is what unlocks the shop and shipping a project. it takes a few minutes and Hack Club does the rest.'
				: decision.hint,
			href: actionable ? data.verifyUrl : null
		};
	});

	// Capture the purchase marker before removing it from the URL.
	let dealt = $state(page.url.searchParams.get('bought') === INVITE_SLUG);

	/* Then take the marker out, for LandingNotice's reason: it describes
	   something that has already happened, and a refresh - or a link somebody
	   shared - should not deal the ticket a second time. `replaceState` rather
	   than a navigation: same page, no server round trip, and no history entry
	   for the back button to walk through. */
	onMount(() => {
		if (!dealt) return;
		const url = new URL(page.url);
		url.searchParams.delete('bought');
		/* The rule wants to see a resolve() call, and there is no route here to
		   resolve: this is the URL the page was already served at, with one
		   parameter taken off it, so it carries whatever base path the router
		   gave it. Building it back up from a route id would be a longer way of
		   writing the address we are already standing on. */
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		replaceState(url, page.state);
	});

	function dealDone() {
		dealt = false;
	}

	const ticket = (slug: string) => resolve('/(app)/shop/[slug]', { slug });

	/* ── inviting friends ──────────────────────────────────────────────────
	   The milestones are counted on the server (lib/server/referrals.ts); this
	   only draws how far along the reader is. */
	const nextMilestone = $derived(
		REFERRAL_MILESTONES.find((milestone) => milestone.count > data.referral.qualified) ?? null
	);

	/* The reward, spelled out in fragments. Null is the stickers. */
	function reward(seconds: number | null): string {
		return seconds === null ? 'custom stickers' : fragments(seconds);
	}

	/* The link without its scheme, for the field: shorter, and nobody types
	   it. The button still copies the whole thing, which is what pastes as a
	   link everywhere. */
	const shownLink = $derived(data.referral.link.replace(/^https?:\/\//, ''));

	let copied = $state(false);
	async function copyInvite() {
		try {
			await navigator.clipboard.writeText(data.referral.link);
			copied = true;
			trackEvent('invite.link_copied', { qualified_so_far: data.referral.qualified });
			setTimeout(() => (copied = false), 2000);
		} catch {
			/* No clipboard (an insecure origin, a refused permission): the link is
			   in the field beside the button, selected on focus, to copy by hand. */
		}
	}
</script>

<svelte:head>
	<title>home · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title">{greeting}, {given}</h1>
</header>

<!-- Two numbers and a door: what the work has come to, the guides, and what
     is still with a reviewer. Hours lead because they are what the program is
     denominated in and what every other screen counts in.

     The first is deliberately not the balance. The meter below IS the balance,
     so a "to spend" tile would be the same number twice; this is the tracked
     time behind it, drafts and all, which is the figure that moves while you
     work rather than when a reviewer gets to you.

     Deliberately on the ground rather than inside a panel: they are the page's
     first line, not a section of it. -->
<div class="figures">
	<div class="figure">
		<!-- Nothing at all while it is still being counted, rather than a zero
		     that would be replaced a beat later by the real number: a figure that
		     corrects itself in front of you is worse than one that arrives. -->
		<span class="figure-value">
			{#if logged === undefined}
				<!-- A non-breaking space rather than nothing, so the tile keeps its
				     height and the row below it does not jump when the number lands. -->
				&nbsp;<span class="sr-only">counting your hours</span>
			{:else if logged === null}
				&mdash;<span class="sr-only">we could not reach hackatime to count your hours</span>
			{:else}
				<Hours seconds={logged} count />
			{/if}
		</span>
		<span class="figure-label">logged</span>
	</div>
	<a class="figure figure-link" href={resolve('/guides')}>
		<span class="figure-value figure-title">guides</span>
		<span class="figure-go" aria-hidden="true">→</span>
		<span class="figure-label">how to build and ship a project</span>
	</a>
	<div class="figure">
		<span class="figure-value"><Hours seconds={data.awaiting} count /></span>
		<span class="figure-label">awaiting review</span>
	</div>
</div>

<!-- Said above the goal, because it is a condition on the goal: the hours can be
     earned without it and cannot be spent without it. -->
{#if verify}
	<Notice bad={verify.bad} title={verify.title} body={verify.body}>
		{#if verify.href}
			<!-- A new tab, and noreferrer with it: verification is a submission
			     somebody fills in and waits on, not a round trip that comes back
			     here, and losing a half-written page to it would be rude. -->
			<!-- The href is an absolute URL on Hack Club Auth's own host, built on the
			     server from the configured HCA host (hcaVerifyUrl). resolve() maps THIS
			     app's route ids to paths, and there is no route of ours here to map, so
			     the rule is reading an external link as an unresolved internal one. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="control-btn is-small verify-go" href={verify.href} target="_blank" rel="noreferrer">
				verify with Hack Club
			</a>
		{/if}
		<!-- The only way, besides signing in again, that this app asks Hack Club
		     for a fresh answer: nothing re-checks on its own. -->
		<form method="POST" action="?/recheck" use:enhance class="verify-recheck">
			<button type="submit" class="control-btn is-small">check again</button>
			{#if form?.recheck === 'too_soon'}
				<span class="verify-note">you just checked - try again in a couple of minutes.</span>
			{:else if form?.recheck === 'unavailable'}
				<span class="verify-note">couldn't reach Hack Club - try again in a bit.</span>
			{:else if form?.recheck === 'checked'}
				<span class="verify-note">checked - nothing has changed at Hack Club yet.</span>
			{/if}
		</form>
	</Notice>
{/if}

<!-- Once the ticket is bought there is no goal left to measure, so no panel:
     the envelope sits on the page by itself. Before that, no invite in the
     catalog is no goal, and no panel either. The bar measures the price of one
     product; without it there is nothing to be a fraction of. -->
<FragmentsIntro balance={data.balance} />

{#if data.ticketOrder}
	<InviteEnvelope
		orderId={data.ticketOrder.id}
		recipient={data.user.displayName ?? data.user.email}
		boughtAt={data.ticketOrder.boughtAt}
		orderState={data.ticketOrder.state}
		{dealt}
		onarrive={dealDone}
	/>
{:else if data.goalSeconds !== null}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">come to philly</h2>
			<!-- The gap, not the progress: the figure and the bar under this both say
		     how far along you are, and a head note repeating the counts that are
		     now tiles would be the third and fourth time the same two numbers
		     appeared on one screen.

		     Nothing to say once the ticket is bought, or once the button to buy it
		     is on screen: both of those are the answer to "how far", and a note
		     beside them would be it said twice. -->
			{#if !data.invited && !data.ticket}
				<span class="panel-note">
					{#if remaining === 0}
						enough for the ticket
					{:else}
						{fragments(Math.ceil(remaining / 360) * 360)} to go
					{/if}
				</span>
			{/if}
		</header>

		<div class="panel-body">
			<div class="goal">
				<p class="goal-figure">
					<span class="goal-value"><Fragments seconds={shown} count word={false} /></span>
					<!-- In fragments, the way the shop prices: the target is what the
				     invite costs. -->
					<span class="goal-target">/ <Fragments seconds={goalSeconds} /></span>
				</p>

				<div
					class="meter"
					role="progressbar"
					aria-valuemin="0"
					aria-valuemax={toFragments(goalSeconds)}
					aria-valuenow={meterNow}
					aria-valuetext="{fragments(shown)} of {fragments(goalSeconds)}"
				>
					<span
						class={['meter-fill', meterHeld && 'is-held']}
						style="--fill: {meterHeld ? 0 : pct}%"
					></span>
				</div>
			</div>

			<!-- Through to the shop, which is the one place that sells it: the
		     quantity, the options, the address and every refusal are written
		     out there, and a second buy button here could only ever handle the
		     cases it happened to have been taught. Drawn once the balance
		     covers it; below that the note above says what is left. -->
			{#if data.ticket}
				<a class="control-btn goal-buy" href={ticket(data.ticket.slug)}>
					buy the ticket · <Fragments seconds={data.ticket.price} />
				</a>
			{/if}
		</div>
	</section>
{/if}

<!-- Two cards abreast: what is left to set up, and inviting friends. They keep their own heights rather than stretching to match, the way
     the order page's pair do. -->
<div class="home-duo">
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">getting started</h2>
			<span class="panel-note">{doneCount} of {steps.length} done</span>
		</header>

		<div class="panel-body">
			<!-- An ordered list, because the order is real: there is no point
			     shipping a project the hours of which nothing was counting. .task is
			     display:grid, which replaces display:list-item - so there are no
			     markers to suppress and the number in the first column is the only
			     one. -->
			<ol class="tasks">
				{#each steps as step, i (step.label)}
					<li
						class="task"
						data-state={step.done === true ? 'done' : i === current ? 'current' : 'todo'}
					>
						<span class="task-idx">{String(i + 1).padStart(2, '0')}</span>
						<span class="task-label">
							{step.label}
							<!-- A classless anchor, which is the shell's mark for a link in
							     running text: the ink, dotted. The full stop is out here so
							     it is not underlined along with the words. -->
							<span class="task-hint"
								>{step.hint}{#if step.link}<a href={step.link.href}>{step.link.text}</a>.{/if}</span
							>
						</span>
						{#if step.done === true}
							<span class="badge is-done">done</span>
						{:else if step.href}
							<a class="control-btn is-small" href={step.href}>{step.action}</a>
						{/if}
					</li>
				{/each}
			</ol>
		</div>
	</section>

	<!-- Inviting friends: the link, and the milestones it is working toward.
	     Beside the checklist, where the projects card used to be - the nav has
	     the projects, and this is on screen when the page loads. -->
	<section class="panel" id="invite">
		<header class="panel-head">
			<h2 class="panel-title">invite friends</h2>
			<!-- How it works, beside the title rather than at the far end of the
			     head: the bubble opens rightward and the panel clips anything
			     that runs past its edge. -->
			<InfoTip label="how referrals work">
				share your link and tell your friends about us! a referral counts when someone who's
				<span class="nowrap">id-verified</span> finishes signing up with your link.
			</InfoTip>
		</header>

		<div class="panel-body">
			<!-- The count first, then the link that earns it: how many have
			     counted, large, and how many are still pending under it. -->
			<div class="invite-row">
				<p class="invite-stat">
					<span class="invite-stat-value">{data.referral.qualified}</span>
					<span class="invite-stat-label">
						{data.referral.qualified === 1 ? 'friend' : 'friends'} invited
						{#if data.referral.joined > data.referral.qualified}
							<span class="invite-stat-pending">
								+{data.referral.joined - data.referral.qualified} pending
							</span>
						{/if}
					</span>
				</p>
				<div class="invite-link">
					<input
						class="control-input has-value invite-url"
						readonly
						value={shownLink}
						aria-label="your invite link"
						onfocus={(event) => event.currentTarget.select()}
					/>
					<!-- An icon, turning to a check for a moment once it has copied. The
					     label says the same for a screen reader. -->
					<button
						type="button"
						class="control-btn invite-copy"
						onclick={copyInvite}
						aria-label={copied ? 'copied' : 'copy your invite link'}
						title={copied ? 'copied' : 'copy'}
					>
						{#if copied}<Check size={18} strokeWidth={2.5} />{:else}<Copy size={18} />{/if}
					</button>
				</div>
			</div>

			<!-- The milestones as bars: each row fills toward its count, so the
			     list is also the progress. Flat fills only - small text on a weave
			     was unreadable. -->
			<ol class="milestones">
				{#each REFERRAL_MILESTONES as milestone (milestone.count)}
					{@const reached = data.referral.qualified >= milestone.count}
					<li
						class={['milestone', reached && 'is-reached', milestone === nextMilestone && 'is-next']}
						style="--fill: {Math.min(1, data.referral.qualified / milestone.count) * 100}%"
					>
						<span class="milestone-mark" aria-hidden="true">
							{#if reached}<PixelIcon name="check" size={12} />{:else}<PixelIcon
									name="circle"
									size={12}
								/>{/if}
						</span>
						<span class="milestone-need">
							<span class="milestone-count">{milestone.count}</span>
							{milestone.count === 1 ? 'friend' : 'friends'}
						</span>
						<span class="milestone-reward">{reward(milestone.seconds)}</span>
						<span class="milestone-state">
							{#if !reached}
								{milestone.count - data.referral.qualified} to go
							{:else if milestone.seconds !== null}
								<span class="badge is-done">earned</span>
							{:else if data.referral.stickersClaimed}
								<span class="badge is-done">claimed</span>
							{:else if data.referral.stickersOpen}
								<a class="control-btn is-small" href={ticket(REFERRAL_STICKERS_SLUG)}>claim</a>
							{:else}
								opens soon
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		</div>
	</section>
</div>

<style>
	/* [1a] The fill's way in: a long settle, the same curve as the count
	   beside it. Held empty with no transition until the page is revealed
	   (see meterHeld), so it never animates down to zero first. */
	.meter-fill {
		transition: width 1100ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.meter-fill.is-held {
		transition: none;
	}

	/* The link and its button on one row; the field takes what is left and
	   may shrink below its text, which scrolls inside it on a phone. */
	/* The figure above the link: a half-width card has no room for both on
	   one line. */
	/* One word, hyphen and all: never broken across the tooltip's lines. */
	.nowrap {
		white-space: nowrap;
	}

	.invite-row {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.invite-stat {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 0;
	}

	.invite-stat-value {
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		font-size: clamp(30px, 7vw, 40px);
		line-height: 1;
		color: var(--ink);
	}

	.invite-stat-label {
		display: flex;
		flex-direction: column;
		font-size: var(--text-sm);
		line-height: 1.3;
		color: var(--ink-mid);
	}

	.invite-stat-pending {
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	.invite-link {
		--invite-control: 40px;
		display: flex;
		gap: 8px;
		align-items: center;
		flex: 1;
		min-width: 0;
	}

	/* Square, and the field pinned to the same height, so the two match
	   exactly rather than the button guessing at the field's padding. */
	.invite-copy {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: var(--invite-control);
		/* .control-btn's 92px floor is for buttons with a word in them. */
		min-width: 0;
		height: var(--invite-control);
		padding: 0;
	}

	/* Padding off the top and bottom: the pinned height centres the text,
	   and the default 9px each way would squeeze a 40px box. */
	.invite-url {
		height: var(--invite-control);
		padding-block: 0;
		flex: 1;
		min-width: 0;
	}

	.milestones {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* One bar per milestone: the mark, the count, the prize, and the state at
	   the right. The fill is two levels up from the recessed track - one level
	   did not read as filled - as far as the reader has got toward this
	   count, so a reached bar is full and the next one shows how close it is.
	   The text is all in the full ink so it holds on either part. */
	.milestone {
		display: grid;
		grid-template-columns: 16px 5.5em 1fr auto;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 6px 12px;
		border: 1px solid var(--line);
		border-radius: var(--control-radius);
		background-color: var(--level-surface);
		background-image: linear-gradient(
			90deg,
			var(--level-lift) var(--fill, 0%),
			transparent var(--fill, 0%)
		);
	}

	.milestone.is-next {
		border-color: var(--panel-line);
	}

	.milestone-mark {
		display: flex;
		color: var(--ink-mid);
	}

	.milestone.is-reached .milestone-mark {
		color: var(--ink);
	}

	.milestone-need {
		font-size: var(--text-sm);
		color: var(--ink);
		white-space: nowrap;
	}

	.milestone-count {
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
	}

	/* One line, always. The state beside it changes width - a claim button,
	   then a wider "claimed" badge - and a prize that wrapped when it did made
	   the bar grow taller on claiming. Too narrow for it, it ends in an
	   ellipsis instead. */
	.milestone-reward {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-md);
		font-weight: 600;
		color: var(--ink);
	}

	.milestone-state {
		font-size: var(--text-xs);
		color: var(--ink);
		white-space: nowrap;
	}

	/* Two panels abreast, one column on a phone.

	   No `align-items: start` here, unlike the order page's pair: these two are a
	   row of cards rather than a column of content with a sidebar beside it, and
	   a row whose cards end at different heights reads as one of them having
	   failed to load. The grid's default stretch gives both the taller one's
	   height; .panel is already a flex column, so the shorter one simply has
	   space under its last row. */
	.home-duo {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 24px;
	}

	@media (max-width: 700px) {
		.home-duo {
			grid-template-columns: 1fr;
		}
	}

	.verify-recheck {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 6px;
	}

	.verify-note {
		font-size: var(--text-xs);
		color: var(--ink-mid);
	}

	/* The notice is a column with a 6px gap, which is the spacing between two
	   lines of text rather than between text and a control. */
	.verify-go {
		align-self: flex-start;
		margin-top: 6px;
	}
</style>
