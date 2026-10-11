<script lang="ts">
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';

	import { tick, untrack } from 'svelte';
	import { fade } from 'svelte/transition';

	import { deserialize, enhance } from '$app/forms';
	import { beforeNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { autoScheme } from '$lib/auto-scheme';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import HyperChroma from '$lib/components/HyperChroma.svelte';
	import HyperChromaIntro from '$lib/components/HyperChromaIntro.svelte';
	import Log from '$lib/components/Log.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import ScreenshotPicker from '$lib/components/ScreenshotPicker.svelte';
	import { NO_AI } from '$lib/ai-declaration';
	import { motionOk } from '$lib/reveal';
	import { shipShortfall } from '$lib/ship-floor';
	import { day } from '$lib/status';
	import PixelIcon from '$lib/components/PixelIcon.svelte';
	import StepBar from '$lib/components/StepBar.svelte';
	import Fragments from '$lib/components/Fragments.svelte';
	import { payoutSeconds } from '$lib/fragments';

	let { data, form }: PageProps = $props();

	/**
	 * [4a] Just shipped (or just sent back after changes): the ship action
	 * redirects here with `?shipped`, and the review tape is laid across the
	 * form as the page arrives instead of simply being there - the lock is
	 * seen happening. Taken out of the address as soon as it is seen, so a
	 * reload or a shared link does not play it again.
	 *
	 * Watched rather than read once: the form submits in the background now,
	 * so a ship arrives as a navigation to this same page - the component
	 * stays mounted, and the barrier mounts when the new data lands.
	 */
	let justShipped = $state(untrack(() => page.url.searchParams.has('shipped')));
	$effect(() => {
		if (!page.url.searchParams.has('shipped')) return;
		justShipped = true;
		const url = new URL(page.url);
		url.searchParams.delete('shipped');
		/* The address the page is already at, less one parameter - nothing to
		   resolve, as on the home page's own replaceState. */
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		replaceState(url, page.state);
	});

	/**
	 * Ship and "changes are done" submit in the background, so a ship's
	 * redirect arrives as a navigation to this page (see justShipped). Both
	 * save the working copy first, server-side, so a save the autosave had
	 * not got to yet is not needed - and not wanted racing them.
	 *
	 * A refusal is shown where refusals always are, at the top of the page -
	 * which is out of sight from a button at the foot of a long form, so it
	 * is brought into view.
	 */
	const submitProject: SubmitFunction = () => {
		clearTimeout(saveTimer);
		if (saveState === 'waiting') saveState = 'idle';
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'failure') {
				/* A ship refused from the kind dialog would otherwise be said
				   behind it. */
				if (kindDialog?.open) closeKind();
				await tick();
				document
					.getElementById('project-error')
					?.scrollIntoView({ behavior: motionOk() ? 'smooth' : 'auto', block: 'center' });
			}
		};
	};

	const project = $derived(data.project);

	/* Software or hardware, as the details panel's switch has it - saved by
	   the autosave like any other field, and read here so the title, the ship
	   button and the kind question follow it without a reload. */
	let kind = $state(untrack(() => data.project.kind));

	/* The review timeline's steps, in the order Ari moves a ship through them
	   (see lib/server/ari-live.ts, PHASE_ORDER). */
	const REVIEW_STEPS = ['sent', 'checks', 'in queue', 'reviewing', 'final check'];

	/* "shipped 2 days ago": how long it has been in review, in the largest
	   unit that is not zero. */
	function ago(date: Date): string {
		const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
		const days = Math.floor(hours / 24);
		return `${days} ${days === 1 ? 'day' : 'days'} ago`;
	}
	/* The owner's own rename shows as it saves; everyone else reads the row. */
	const shownName = $derived.by(() => (data.isOwner ? name.trim() || project.name : project.name));

	/* Unchecked means a declaration is required at ship; checked stands in
	   for one, and is stored as the one it stands for (NO_AI) - so it comes
	   back ticked after a save. */
	let noAi = $state(untrack(() => data.project.aiDeclaration === NO_AI));

	/* The same shape for the update question. It starts ticked for a project
	   that already carries a declaration, so a reship does not silently drop a
	   mark the owner made on the last one - unticking is what takes it back. */
	let isUpdate = $state(untrack(() => data.project.updateDeclaration !== null));

	/* The "for the reviewer" answers, held here rather than left as the
	   textareas' own contents, because two of them are behind a checkbox and
	   `{#if}` takes a field out of the DOM - along with whatever was typed in
	   it, and along with its entry in the submitted form. Ticking "i did not
	   use AI" would otherwise throw away the declaration the person had just
	   written, and a save immediately afterwards would write that loss to the
	   database.

	   Bound here, the text survives the toggle, and the `{:else}` branches below
	   keep sending it so a save is never the thing that empties a column. */
	let aiDeclaration = $state(
		untrack(() => (data.project.aiDeclaration === NO_AI ? '' : (data.project.aiDeclaration ?? '')))
	);
	let updateDeclaration = $state(untrack(() => data.project.updateDeclaration ?? ''));
	let notesForReviewer = $state(untrack(() => data.project.notesForReviewer ?? ''));
	let changelog = $state(untrack(() => data.project.changelogDraft ?? ''));

	/* The name, bound so the title follows a rename the autosave has written
	   without the page reloading. */
	let name = $state(untrack(() => data.project.name));

	/* ── autosave ───────────────────────────────────────────────────────────

	   The details and "for the reviewer" panels save themselves: a moment
	   after typing stops, at once when a field is left or a box is ticked.
	   One save for both - it is one form and one working copy - and a toast
	   that says so (see showToast), so there is nothing to press and nothing
	   to wonder about.

	   Posted to the same `?/save` action the save button used to, by hand
	   rather than through `enhance`: a save is not a navigation, and running
	   the page's load after every pause in typing would ask Hackatime, HCA
	   and Ari each time. It is re-run only when a save changed the
	   screenshot, so the picker lets go of the file it would otherwise upload
	   again. */
	type SaveState = 'idle' | 'waiting' | 'saving' | 'saved' | 'error';

	let saveState = $state<SaveState>('idle');
	let saveError = $state<string | null>(null);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let saving = false;
	let saveAgain = false;

	const TYPING_PAUSE_MS = 900;

	/* The toast: "saved" pops up at the foot of the screen for a moment after
	   each save, so a save is seen happening wherever the eye is. A save that
	   failed keeps it up, in red, with the reason, until one goes through. */
	const TOAST_MS = 2200;
	let toastUp = $state(false);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	/* Bumped by every save, so a save landing while the toast is still up
	   plays its arrival again - a second save is seen as a second save. */
	let toastCount = $state(0);

	function showToast() {
		toastCount += 1;
		toastUp = true;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toastUp = false), TOAST_MS);
	}

	const toastShown = $derived(saveState === 'error' || toastUp);

	function scheduleSave(delay: number) {
		if (data.hasOpen) return;
		saveState = 'waiting';
		clearTimeout(saveTimer);
		saveTimer = setTimeout(saveNow, delay);
	}

	/* Every edit in the two panels bubbles to the form: typing waits for a
	   pause; leaving a field, ticking a box or picking a file goes now. Other
	   panels' fields - the changes note, the kind question - are not part of
	   the working copy and do not save. */
	function onEdit(event: Event) {
		const panel = (event.target as Element | null)
			?.closest('[data-panel]')
			?.getAttribute('data-panel');
		if (panel !== 'details' && panel !== 'reviewer') return;
		scheduleSave(event.type === 'input' ? TYPING_PAUSE_MS : 50);
	}

	/* Enter in a one-line field is the browser's "submit this form" - which
	   presses the form's first submit button, and with no save button left
	   that is "ship it". A ship is never a keypress away: Enter saves now
	   instead. (autoScheme's own Enter, on the url fields, runs first.) */
	function onFormKey(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.isComposing) return;
		const target = event.target;
		if (!(target instanceof HTMLInputElement) || target.type === 'submit') return;
		event.preventDefault();
		if (target.closest('[data-panel]')) void saveNow();
	}

	/* The picker's remove button changes no field anyone typed in, so it
	   says so itself; a picture equal to the stored one is not an edit. */
	function onPicture(url: string | null) {
		if (url === (data.project.screenshotUrl ?? null)) return;
		scheduleSave(50);
	}

	/* Why a field the browser will not accept is holding the save up, in
	   words that name the field. */
	function invalidReason(field: HTMLInputElement | HTMLTextAreaElement): string {
		if (field.id === 'name') return 'give it a name to save.';
		const label = document.querySelector(`label[for="${field.id}"]`)?.textContent?.trim();
		return `${label ?? 'a field'}: ${field.validationMessage.toLowerCase()}`;
	}

	async function saveNow() {
		clearTimeout(saveTimer);
		if (!projectForm || data.hasOpen) return;
		if (saving) {
			saveAgain = true;
			return;
		}

		const invalid = projectForm.querySelector<HTMLInputElement | HTMLTextAreaElement>(
			'[data-panel] input:invalid, [data-panel] textarea:invalid'
		);
		if (invalid) {
			saveState = 'error';
			toastCount += 1;
			saveError = invalidReason(invalid);
			return;
		}

		saving = true;
		saveState = 'saving';
		const body = new FormData(projectForm);
		const file = body.get('screenshot1');
		const pictureChanged =
			(file instanceof File && file.size > 0) || body.get('screenshot_clear') === '1';
		try {
			const response = await fetch(`${page.url.pathname}?/save`, {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await response.text());
			if (result.type === 'success') {
				saveError = null;
				if (pictureChanged) await invalidateAll();
				saveState = saveAgain ? 'waiting' : 'saved';
				if (!saveAgain) showToast();
			} else {
				saveState = 'error';
				toastCount += 1;
				saveError =
					result.type === 'failure' && typeof result.data?.error === 'string'
						? result.data.error
						: "couldn't save just now - it will try again with your next change.";
			}
		} catch {
			saveState = 'error';
			toastCount += 1;
			saveError = "couldn't reach Phantom - it will try again with your next change.";
		} finally {
			saving = false;
			if (saveAgain) {
				saveAgain = false;
				scheduleSave(0);
			}
		}
	}

	/* An edit still waiting is saved on the way out: leaving the tab, or the
	   page, mid-sentence keeps the sentence. A reload or close asks first if
	   it has not landed yet. */
	function flushOnHide() {
		if (document.visibilityState === 'hidden' && saveState === 'waiting') void saveNow();
	}

	function warnUnsaved(event: BeforeUnloadEvent) {
		if (saveState === 'waiting' || saveState === 'saving') event.preventDefault();
	}

	beforeNavigate(({ willUnload }) => {
		if (!willUnload && saveState === 'waiting') void saveNow();
	});

	/* How far the ticked Hackatime projects are from the ship floor, so "ship
	   it" is greyed out before it is pressed rather than refused after. On an
	   update the new time is counted the way Ari counts it - since the last
	   approved ship, on every ticked project. Null when the figures are not to
	   hand; the server still checks. */
	const shipShort = $derived.by(() => {
		if (!data.hackatimeProjects) return null;
		const claimed = data.hackatimeProjects
			.filter((opt) => selectedHackatime.includes(opt.name))
			.reduce((sum, opt) => sum + opt.totalSeconds, 0);
		const since = data.shipFloor.sinceLastShip;
		if (data.shipFloor.isUpdate && !since && !data.shipFloor.afterRejection) return null;
		const fresh =
			data.shipFloor.isUpdate && since
				? selectedHackatime.reduce((sum, name) => sum + (since[name] ?? 0), 0)
				: null;
		return shipShortfall(claimed, fresh, data.shipFloor.afterRejection);
	});

	/* What this ship would carry and roughly what it would pay, said beside
	   "ship it". The time is the figure Ari reviews: on an update, the new time
	   since the last approved ship on the ticked projects (projects/window.ts
	   counts it the way Ari does); otherwise everything they have logged. The
	   payout is that in whole fragments, rounded down the way a grant is - an
	   estimate, because Ari decides the real figure and can grant less. Null
	   when the figures are not to hand. */
	const shipEstimate = $derived.by(() => {
		if (!data.hackatimeProjects || selectedHackatime.length === 0) return null;
		const since = data.shipFloor.sinceLastShip;
		if (data.shipFloor.isUpdate) {
			if (!since) return null;
			return selectedHackatime.reduce((sum, name) => sum + (since[name] ?? 0), 0);
		}
		return data.hackatimeProjects
			.filter((opt) => selectedHackatime.includes(opt.name))
			.reduce((sum, opt) => sum + opt.totalSeconds, 0);
	});

	function hoursAndMinutes(seconds: number): string {
		const minutes = Math.floor(seconds / 60);
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}

	/**
	 * The kind question, for a project made before the new-project flow asked
	 * it. Shipping needs an answer (the ship action refuses without one), so
	 * "ship it" on such a project opens this instead of submitting, and each
	 * answer is itself a ship button: one press answers and ships.
	 *
	 * The dialog sits INSIDE the project form, unlike ConfirmDialog, whose own
	 * form posts nothing but itself - a ship has to carry every field on the
	 * page, and a button belongs to the form it is written in even while its
	 * dialog is up in the top layer.
	 *
	 * The form is checked before the dialog opens, not after: the browser's
	 * complaint about an empty name has nowhere to show while a modal covers
	 * the field it is pointing at.
	 */
	let projectForm: HTMLFormElement | undefined = $state();
	let kindDialog: HTMLDialogElement | undefined = $state();
	let kindClosing = $state(false);

	function askKind() {
		if (!projectForm?.reportValidity()) return;
		kindDialog?.showModal();
	}

	/* The hold-open-then-close from modal.css, as in ConfirmDialog. */
	function closeKind() {
		if (!kindDialog || kindClosing) return;
		kindClosing = true;
		const finish = () => {
			if (!kindClosing) return;
			kindClosing = false;
			kindDialog?.close();
		};
		kindDialog.addEventListener('transitionend', finish, { once: true });
		setTimeout(finish, 250);
	}

	/* Deleting is irreversible and the button is one click from the bottom of
	   the page, so it asks first - in the frame, not in the browser's own
	   dialog. See ConfirmDialog for why that distinction is worth a component. */
	let confirmDelete = $state(false);
	let confirmArchive = $state(false);

	/* Staff looking at someone else's project see its working copy's picture,
	   the same one the owner sees. */
	const reviewerBanner = $derived(data.project.screenshotUrl ?? null);

	/* The Hackatime project picker: a dropdown of the linked account's actual
	   projects rather than a name typed by hand, so a typo can't silently zero
	   out the hours a submission is judged against. */
	let selectedHackatime = $state<string[]>(
		untrack(() =>
			(data.project.hackatimeProjects ?? '')
				.split(',')
				.map((name) => name.trim())
				.filter(Boolean)
		)
	);

	/* A <details> only closes from its own summary, which is not how a dropdown
	   is expected to behave: a click anywhere else, or Escape, closes it too. */
	let hackatimeSelect = $state<HTMLDetailsElement>();

	function closeHackatimeOnOutside(event: PointerEvent) {
		if (!hackatimeSelect?.open) return;
		if (event.target instanceof Node && hackatimeSelect.contains(event.target)) return;
		hackatimeSelect.open = false;
	}

	function closeHackatimeOnEscape(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !hackatimeSelect?.open) return;
		hackatimeSelect.open = false;
		hackatimeSelect.querySelector('summary')?.focus();
	}

	/* Only an open review locks the picker. Under a change request the claim
	   is counted again when the changes are marked done (resumeAfterChanges). */
	const hackatimeLocked = $derived(data.hasOpen);

	function toggleHackatime(name: string) {
		if (hackatimeLocked) return;
		selectedHackatime = selectedHackatime.includes(name)
			? selectedHackatime.filter((n) => n !== name)
			: [...selectedHackatime, name];
	}
</script>

<!-- Every href on this page is an external project or Hack Club portal link; all
     in-app navigation here is form actions, so the resolve() rule has nothing to
     guard. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->

<svelte:window
	onpointerdown={closeHackatimeOnOutside}
	onkeydown={closeHackatimeOnEscape}
	onbeforeunload={warnUnsaved}
/>
<svelte:document onvisibilitychange={flushOnHide} />

<svelte:head>
	<title>{shownName} · PHANTOM</title>
</svelte:head>

<header class="page-head">
	<h1 class="page-title project-title">
		{shownName}
		<span class="project-number"
			>#{project.number}{#if kind}&nbsp;· {kind}{/if}</span
		>
	</h1>
	{#if data.hyperChroma}<p class="project-hc"><HyperChroma /></p>{/if}
	{#if !data.isOwner && data.canReview}
		<p class="page-lede">you are viewing this project. it is reviewed on Ari.</p>
	{/if}
</header>

{#if !data.isOwner && reviewerBanner}
	<img class="project-banner" src={reviewerBanner} alt="" />
{/if}

{#if form?.error}
	<div id="project-error"><Notice bad alert body={form.error} /></div>
{/if}

<!-- Put away: off their projects page and out of "logged", until it is
     brought back. Everything else on the page still works - only shipping
     waits. -->
{#if data.isOwner && data.hyperChroma}
	<HyperChromaIntro number={data.project.number} name={data.project.name} where="page" />
{/if}

{#if data.isOwner && data.archived}
	<Notice title="this project is archived">
		<span class="notice-body"
			>it's off your projects page and doesn't count toward your logged hours. bring it back to work
			on it or ship it again.</span
		>
		<form method="POST" action="?/unarchive" use:enhance class="form-actions">
			<button type="submit" class="control-btn is-small">bring it back</button>
		</form>
	</Notice>
{/if}

<!-- ── owner: edit the working copy ────────────────────────────────────────── -->
{#if data.isOwner}
	<!-- ── owner: where the ship is ─────────────────────────────────────── -->
	<!-- While a review is open: the ship's way through Ari as a step track,
	     filled to where it is now - asked of Ari after the page arrives, so
	     the track starts empty and fills in. If Ari cannot be asked, the
	     track goes and the words say "under review", as they used to. -->
	{#if data.hasOpen}
		<section class="panel rt-panel">
			<header class="panel-head">
				<h2 class="panel-title">in review</h2>
				{#if data.shippedAt}<span class="panel-note">shipped {ago(data.shippedAt)}</span>{/if}
			</header>
			<div class="panel-body">
				{#await data.reviewStatus}
					<StepBar steps={REVIEW_STEPS} current={-1} label="review progress" />
					<p class="rt-status">checking with Ari…</p>
				{:then status}
					{#if status}
						<StepBar steps={REVIEW_STEPS} current={status.step} label="review progress" arrive />
						<p class="rt-status">{status.label}</p>
					{:else}
						<p class="rt-status">under review</p>
					{/if}
				{/await}
				<p class="form-hint">you'll get a slack dm the moment it's decided.</p>
			</div>
		</section>
	{/if}

	<!-- One form for the working copy AND the ship panel below, not two: a
	     "ship it" click has to carry whatever is in the fields above along with
	     it, and the ship action saves them before it reads the project row - so
	     an edit the autosave has not reached yet still ships. `formaction` is
	     what tells "ship it" to go to ?/ship; the form's own ?/save is what the
	     autosave posts to. -->
	<!-- The keydown is delegation, not interaction: it catches Enter from the
	     fields inside (see onFormKey). -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<form
		id="project-form"
		method="POST"
		action="?/save"
		enctype="multipart/form-data"
		bind:this={projectForm}
		use:enhance={submitProject}
		oninput={onEdit}
		onchange={onEdit}
		onkeydown={onFormKey}
	>
		<section class="panel" data-panel="details">
			<header class="panel-head">
				<h2 class="panel-title">details</h2>
				{#if data.hasOpen}
					<span class="badge is-good">under review</span>
				{:else if data.changes}
					<span class="badge is-changes">changes requested</span>
				{/if}
			</header>
			<!-- Everything inside the fieldset goes dead while a review is open; the
			     server refuses a save then too. -->
			<div class="panel-body form">
				<fieldset class="lock" disabled={data.hasOpen}>
					<!-- The screenshot, first, inside the same panel as the rest of the
				     working copy - so the lock and the tape cover it too. -->
					<ScreenshotPicker
						url={project.screenshotUrl}
						disabled={data.hasOpen}
						clearName="screenshot_clear"
						onpicture={onPicture}
					/>
					<div class="form-field">
						<label class="form-label" for="name">name</label>
						<input
							id="name"
							name="name"
							class="control-input"
							type="text"
							maxlength="120"
							bind:value={name}
							required
						/>
					</div>
					<!-- Software or hardware: picked when the project was made, and
					     changeable here - a project that started as a game and grew
					     a controller is a hardware project now. -->
					<div class="form-field">
						<span class="form-label" id="kind-label">kind</span>
						<div class="pk-switch" role="radiogroup" aria-labelledby="kind-label">
							{#each [{ value: 'software', icon: 'code' }, { value: 'hardware', icon: 'cpu' }] as const as option (option.value)}
								<label class={['pk-option', kind === option.value && 'is-picked']}>
									<input
										class="sr-only"
										type="radio"
										name="project_kind"
										value={option.value}
										bind:group={kind}
									/>
									<PixelIcon name={option.icon} size={12} />
									{option.value}
								</label>
							{/each}
						</div>
					</div>
					<div class="form-field">
						<label class="form-label" for="description">description</label>
						<textarea id="description" name="description" class="control-textarea" maxlength="2000"
							>{project.description ?? ''}</textarea
						>
					</div>
					<div class="form-grid">
						<div class="form-field">
							<label class="form-label" for="repo_url">repository url</label>
							<input
								id="repo_url"
								name="repo_url"
								class="control-input"
								type="url"
								pattern="https?://.+"
								use:autoScheme
								value={project.repoUrl ?? ''}
							/>
						</div>
						<div class="form-field">
							<label class="form-label" for="demo_url">demo url</label>
							<input
								id="demo_url"
								name="demo_url"
								class="control-input"
								type="url"
								pattern="https?://.+"
								use:autoScheme
								value={project.demoUrl ?? ''}
							/>
						</div>
						<div class="form-field">
							<span class="form-label" id="hackatime-label">hackatime project(s)</span>
							{#if !data.hackatimeLinked}
								<Notice body="link Hackatime to choose which projects count toward this one." />
								<div class="form-actions">
									<a
										class="control-btn is-quiet is-small"
										href={resolve(
											`/api/auth/hackatime/start?redirectTo=/projects/${project.number}`
										)}>link hackatime</a
									>
								</div>
							{:else if data.hackatimeError}
								<Notice bad body="couldn't load your hackatime projects. try again in a moment." />
							{:else}
								<!-- A details element is not a form control, so the disabled
							     fieldset does not reach it; inert does. -->
								<details
									bind:this={hackatimeSelect}
									class="hk-select"
									inert={hackatimeLocked || undefined}
								>
									<summary class="hk-summary" aria-labelledby="hackatime-label">
										{#if selectedHackatime.length}
											<span class="hk-pills">
												{#each selectedHackatime as name (name)}
													<span class="hk-pill">{name}</span>
												{/each}
											</span>
										{:else}
											<span class="hk-placeholder">select projects…</span>
										{/if}
										<span class="select-caret" aria-hidden="true">▼</span>
									</summary>
									<div class="hk-menu">
										{#if data.hackatimeProjects?.length}
											{#each data.hackatimeProjects as opt (opt.name)}
												{@const picked = selectedHackatime.includes(opt.name)}
												<label class="hk-option" class:is-disabled={opt.disabled && !picked}>
													<input
														type="checkbox"
														checked={picked}
														disabled={opt.disabled && !picked}
														onchange={() => toggleHackatime(opt.name)}
													/>
													<span class="hk-option-name">{opt.name}</span>
													<span class="hk-option-hours"
														>{(opt.totalSeconds / 3600).toFixed(1)}h</span
													>
													{#if opt.disabled && !picked}
														<span class="hk-option-tag">used by another project</span>
													{/if}
												</label>
											{/each}
										{:else}
											<p class="hk-empty">no hackatime projects found yet.</p>
										{/if}
									</div>
								</details>
							{/if}
							<input type="hidden" name="hackatime_projects" value={selectedHackatime.join(',')} />
							<span class="form-hint"
								>this is how your hours are counted. only time logged from august 6, 2026 on counts.</span
							>
						</div>
					</div>
				</fieldset>
			</div>
			{#if data.hasOpen}
				<!-- The barrier: tape across the form while a review is open. The
			     fields behind it are already dead; this is what says why. -->
				<div class={['barrier', justShipped && 'is-arriving']} aria-hidden="true">
					{#each ['is-second', 'is-first'] as side (side)}
						<span class={['barrier-tape', side]}>
							<span class="barrier-run">
								{#each { length: 12 }, i (i)}
									<span>under review</span>
								{/each}
							</span>
						</span>
					{/each}
				</div>
			{/if}
		</section>

		<!-- ── owner: for the reviewer ─────────────────────────────────────────── -->
		<!-- What the reviewer reads beside the project, in a panel of its own.
		     Part of the working copy, so it can be
		     written as the work happens rather than in a rush at ship time - and
		     frozen onto the submission when it ships. It saves itself, with the
		     details panel - see the autosave. None of it carries
		     `required`: these are conditions of SHIPPING, and `required` would
		     enforce them on a save too, so `shipProject` refuses them instead.

		     `ship_fields` says these were on the page at all - the fieldset goes
		     dead while a review is open, and a disabled field is not submitted.
		     See `draftFrom`. No tape across this one while it is locked; the
		     cursor says it. -->
		<section class={['panel', data.hasOpen && 'reviewer-locked']} data-panel="reviewer">
			<header class="panel-head">
				<h2 class="panel-title">for the reviewer</h2>
			</header>
			<div class="panel-body form">
				<fieldset class="lock" disabled={data.hasOpen}>
					<p class="form-hint">
						saved as you go, with the rest of your project. the reviewer sees it when you ship.
					</p>
					<input type="hidden" name="ship_fields" value="1" />
					<label class="check-field">
						<input type="checkbox" name="no_ai" bind:checked={noAi} />
						i did not use AI on this project
					</label>
					{#if !noAi}
						<div class="form-field">
							<label class="form-label" for="ai_declaration">ai declaration</label>
							<textarea
								id="ai_declaration"
								name="ai_declaration"
								class="control-textarea"
								maxlength="1000"
								bind:value={aiDeclaration}></textarea>
							<span class="form-hint"
								>what did you use AI for? be honest - the code is checked.</span
							>
						</div>
					{:else}
						<input type="hidden" name="ai_declaration" value={aiDeclaration} />
					{/if}
					{#if data.hasApproved}
						<div class="form-field">
							<label class="form-label" for="changelog">what's new since your last ship?</label>
							<textarea
								id="changelog"
								name="changelog"
								class="control-textarea"
								maxlength="2000"
								bind:value={changelog}></textarea>
							<span class="form-hint"
								>keep it going as you work - it starts fresh after each ship.</span
							>
						</div>
					{/if}
					<!-- The update mark Phantom cannot work out for itself. A project
					     that has been approved HERE is already an update and the
					     changelog above is the account of it; this is for the project
					     that existed before Phantom did - built for another program,
					     shipped somewhere else - which reads to us as brand new. Only
					     the owner knows, so only the owner can say.

					     Ticked and left blank is refused at ship, the same way the AI
					     declaration is and for the same reason: the box is a claim and
					     the text is the claim's content. Unticking clears it. -->
					<label class="check-field">
						<input type="checkbox" name="is_update" bind:checked={isUpdate} />
						this is an update to a project i've already made
					</label>
					{#if isUpdate}
						<div class="form-field">
							<label class="form-label" for="update_declaration">update declaration</label>
							<textarea
								id="update_declaration"
								name="update_declaration"
								class="control-textarea"
								maxlength="2000"
								bind:value={updateDeclaration}></textarea>
							<span class="form-hint"
								>where was it submitted before, what did you have then, and what have you changed?</span
							>
						</div>
					{:else}
						<input type="hidden" name="update_declaration" value={updateDeclaration} />
					{/if}

					<!-- The last word, and the only one with no question behind it.
					     Everything above asks something specific and refuses a bad
					     answer; this asks nothing, refuses nothing, and is simply
					     where the things the form did not think to ask about go.
					     Saved with the project like the two above it, frozen onto the
					     submission at ship, and shown to the reviewer as the
					     submitter's own words. -->
					<div class="form-field">
						<label class="form-label" for="notes_for_reviewer"
							>anything else you want to tell the reviewer?</label
						>
						<textarea
							id="notes_for_reviewer"
							name="notes_for_reviewer"
							class="control-textarea"
							maxlength="2000"
							bind:value={notesForReviewer}></textarea>
					</div>
				</fieldset>
			</div>
		</section>

		<!-- ── owner: ship ──────────────────────────────────────────────────────── -->
		<!-- Not drawn while a review is open: the history below already says the
	     project is under review, and a panel that only says "wait" is not a
	     panel. -->
		{#if data.changes}
			<!-- In place of the ship panel: this is not a new ship. Saying the
			     changes are done saves the fields above, the way "ship it" does,
			     and puts the same submission back where it was in the queue. -->
			<section class="panel">
				<header class="panel-head">
					<h2 class="panel-title">changes requested</h2>
				</header>
				<div class="panel-body form">
					{#if data.changes.message}
						<blockquote class="changes-ask">{data.changes.message}</blockquote>
					{/if}
					<p class="panel-prose">
						a reviewer asked for these changes before your project can be approved. make them above,
						then mark them done. your project goes straight back to its old place in the review
						queue - no waiting at the back. everything on the page can be changed, hackatime
						projects included, and goes to the reviewer as it is when you mark them done.
					</p>
					<div class="form-field">
						<label class="form-label" for="changes_note">what did you change? (optional)</label>
						<textarea
							id="changes_note"
							name="changes_note"
							class="control-textarea"
							maxlength="2000"></textarea>
						<span class="form-hint">shown to the reviewer.</span>
					</div>
					<div class="form-actions">
						<button type="submit" formaction="?/changesDone" class="control-btn"
							>changes are done</button
						>
					</div>
				</div>
			</section>
		{:else if !data.hasOpen && !data.archived}
			<section class="panel">
				<header class="panel-head">
					<h2 class="panel-title">ship for review</h2>
				</header>
				<div class="panel-body">
					<!-- The two guides most change requests come back to, where they
					     are needed: right before shipping. -->
					<p class="form-hint">
						before you ship: <a href={resolve('/(app)/guides/[slug]', { slug: 'readme' })}
							>write a README a reviewer can follow</a
						>
						and <a href={resolve('/(app)/guides/[slug]', { slug: 'git' })}>commit as you go</a>.
					</p>
					{#if data.fraudBlocked}
						<!-- Turned down by the fraud team: not something to fix and
						     resubmit, so no ship button and no hints about one. -->
						<Notice
							bad
							title="this project can't be shipped again"
							body="it was turned down by Hack Club's fraud team. for more information see fraud.hackclub.com. if you think this is a mistake, DM the @Fraud Squad bot on Slack."
						/>
					{:else if !data.eligible}
						<Notice
							body="you need to be verified and eligible with Hack Club before you can ship."
						/>
					{:else if data.addressError}
						<Notice bad body="we couldn't read your Hack Club address. try again in a moment." />
					{:else if !data.hasAddress}
						<Notice
							body="you need a shipping address on your Hack Club account before you can ship."
						/>
						{#if data.addressPortalUrl}
							<div class="form-actions">
								<a
									class="control-btn is-quiet"
									href={data.addressPortalUrl}
									target="_blank"
									rel="noreferrer">add an address at Hack Club</a
								>
							</div>
						{/if}
					{:else}
						<div class="form">
							{#if shipShort}
								<span class="form-hint"
									>you need {Math.ceil(shipShort / 60)} more minutes of hackatime time{data
										.shipFloor.isUpdate && !data.shipFloor.afterRejection
										? ' since your last approved ship'
										: ''} to ship.</span
								>
							{:else if shipEstimate !== null}
								<p class="ship-estimate">
									you're shipping <strong>{hoursAndMinutes(shipEstimate)}</strong>{data.shipFloor
										.isUpdate
										? ' of new time'
										: ''}, which will yield an estimated
									<strong><Fragments seconds={payoutSeconds(shipEstimate)} /></strong>.
									<span class="form-hint">the reviewer decides the final amount.</span>
								</p>
							{/if}
							<div class="form-actions">
								{#if kind}
									<button
										type="submit"
										formaction="?/ship"
										class="control-btn"
										disabled={!!shipShort}>ship it</button
									>
								{:else}
									<button type="button" class="control-btn" disabled={!!shipShort} onclick={askKind}
										>ship it</button
									>
								{/if}
							</div>

							{#if !kind}
								<dialog
									class="modal"
									class:is-closing={kindClosing}
									bind:this={kindDialog}
									aria-labelledby="kind-title"
									onclick={(event) => event.target === kindDialog && closeKind()}
									oncancel={(event) => {
										event.preventDefault();
										closeKind();
									}}
								>
									<header class="panel-head">
										<h2 class="panel-title" id="kind-title">one quick thing</h2>
									</header>
									<div class="panel-body kind-body">
										<p class="confirm-body">
											is {project.name} a software or a hardware project? it was made before we started
											asking, and reviewers look for different things in each. pick one and it ships.
										</p>
										<div class="kind-choices">
											<button
												type="submit"
												formaction="?/ship"
												name="kind"
												value="software"
												class="kind-choice"
											>
												<PixelIcon name="code" size={24} />
												<span class="kind-choice-title">software</span>
												<span class="kind-choice-body">games, websites, apps, tools, bots</span>
											</button>
											<button
												type="submit"
												formaction="?/ship"
												name="kind"
												value="hardware"
												class="kind-choice"
											>
												<PixelIcon name="cpu" size={24} />
												<span class="kind-choice-title">hardware</span>
												<span class="kind-choice-body">circuits, pcbs, keyboards, robots</span>
											</button>
										</div>
										<div class="form-actions">
											<button type="button" class="control-btn is-quiet" onclick={closeKind}
												>cancel</button
											>
										</div>
									</div>
								</dialog>
							{/if}
						</div>
					{/if}
				</div>
			</section>
		{/if}
	</form>

	<!-- The autosave's toast: a strip of the review barrier's tape, slapped on
	     across the top of the screen. The live region is always there, so a
	     screen reader hears it change; the tape inside comes and goes. -->
	<div class="save-toast-region" role="status" aria-live="polite">
		{#if toastShown}
			<!-- The fade is the wrapper's; the strip inside is re-made by each save
			     (keyed on the count), so its arrival plays again. -->
			<div out:fade={{ duration: motionOk() ? 280 : 0 }}>
				{#key toastCount}
					<div class={['save-toast', saveState === 'error' && 'is-error']}>
						<span class="save-toast-word">
							<PixelIcon name={saveState === 'error' ? 'alert' : 'check'} size={14} />
							{saveState === 'error' ? 'not saved' : 'saved'}
						</span>
						{#if saveState === 'error' && saveError}
							<span class="save-toast-why">{saveError}</span>
						{/if}
					</div>
				{/key}
			</div>
		{/if}
	</div>

	<!-- Only ever offered on a project that has never been shipped, which is
	     also the only project `deleteProject` will delete - so the confirmation
	     is about losing the working copy and nothing else. -->
	<!-- Shipped and never approved, so it cannot be deleted: it can be put
	     away instead, and brought back from the archived page. -->
	{#if data.canArchive}
		<button
			type="button"
			class="control-btn is-danger is-wide archive-btn"
			onclick={() => (confirmArchive = true)}
			><PixelIcon name="archive" size={12} /> archive project</button
		>
		<ConfirmDialog
			bind:open={confirmArchive}
			title="archive {project.name}?"
			confirmLabel="archive it"
			danger
			action="?/archive"
		>
			{#snippet body()}
				<p class="confirm-body">
					it comes off your projects page and stops counting toward your logged hours. its history
					stays, and you can bring it back any time from your archived projects. its hackatime
					projects stay linked to it, so they can't be used by another project while it's archived.
				</p>
			{/snippet}
		</ConfirmDialog>
	{/if}

	{#if !data.hasSubmissions}
		<button
			type="button"
			class="control-btn is-danger is-wide"
			onclick={() => (confirmDelete = true)}>delete project</button
		>
		<ConfirmDialog
			bind:open={confirmDelete}
			title="delete {project.name}?"
			confirmLabel="delete it"
			danger
			action="?/delete"
		>
			{#snippet body()}
				<p class="confirm-body">
					this deletes the project and everything on it - the description, the links, the screenshot
					and the hackatime projects you linked. it has never been shipped, so there is nothing in
					review and no hours to lose. it cannot be undone.
				</p>
			{/snippet}
		</ConfirmDialog>
	{/if}
{/if}

<!-- ── staff: the working copy, read-only ──────────────────────────────────── -->
<!-- What the owner sees in their form, with nothing to edit. Decisions are
     made on Ari, so there are no controls here - except lifting a fraud
     block, which is Phantom's own rule. -->
{#if !data.isOwner && data.fraudBlocked}
	<Notice bad title="blocked for fraud">
		<span class="notice-body"
			>Ari turned this project down for fraud, so its owner can't ship it again.
			{#if data.canLiftFraud}
				if that call has been overturned, lift the block - it's recorded with your name and reason,
				and a later fraud rejection blocks it again.
			{/if}</span
		>
		{#if data.canLiftFraud}
			<form method="POST" action="?/liftFraud" use:enhance class="form">
				<div class="form-field">
					<label class="form-label" for="lift-reason">reason</label>
					<input
						id="lift-reason"
						name="reason"
						class="control-input"
						type="text"
						maxlength="500"
						placeholder="e.g. fraud squad cleared them on slack"
						required
					/>
				</div>
				<div class="form-actions">
					<button type="submit" class="control-btn is-small">let it ship again</button>
				</div>
			</form>
		{/if}
	</Notice>
{:else if !data.isOwner && form && 'fraudLifted' in form}
	<Notice title="block lifted" body="the owner can ship this project again." />
{/if}

{#if !data.isOwner}
	<section class="panel">
		<header class="panel-head">
			<h2 class="panel-title">details</h2>
		</header>
		<div class="panel-body">
			{#if project.description}<p class="project-desc">{project.description}</p>{/if}
			<div class="row">
				<span class="row-label">
					review on Ari
					{#if data.ariReviews.length > 1}
						<span class="row-hint"
							>earlier ships:
							{#each data.ariReviews.slice(1) as review, index (review.url)}
								{#if index > 0},
								{/if}<a href={review.url} target="_blank" rel="noopener noreferrer"
									>{day(review.sentAt)}</a
								>
							{/each}</span
						>
					{:else if data.ariReviews.length === 0}
						<span class="row-hint">not sent to Ari yet</span>
					{/if}
				</span>
				<span class="row-value">
					{#if data.ariReviews[0]}
						<a
							class="control-btn is-small"
							href={data.ariReviews[0].url}
							target="_blank"
							rel="noopener noreferrer">open</a
						>
					{:else}-{/if}
				</span>
			</div>
			<div class="row">
				<span class="row-label">
					repository
					{#if project.repoUrl}<span class="row-hint row-url">{project.repoUrl}</span>{/if}
				</span>
				<span class="row-value">
					{#if project.repoUrl}
						<a
							class="control-btn is-small"
							href={project.repoUrl}
							target="_blank"
							rel="noopener noreferrer">open</a
						>
					{:else}-{/if}
				</span>
			</div>
			<div class="row">
				<span class="row-label">
					demo
					{#if project.demoUrl}<span class="row-hint row-url">{project.demoUrl}</span>{/if}
				</span>
				<span class="row-value">
					{#if project.demoUrl}
						<a
							class="control-btn is-small"
							href={project.demoUrl}
							target="_blank"
							rel="noopener noreferrer">open</a
						>
					{:else}-{/if}
				</span>
			</div>
			<div class="row">
				<span class="row-label">hackatime</span>
				<span class="row-value">{project.hackatimeProjects || '-'}</span>
			</div>
			{#if project.aiDeclaration}
				<div class="row is-full">
					<span class="row-label"
						>ai declaration<span class="row-hint">{project.aiDeclaration}</span></span
					>
				</div>
			{/if}
			{#if project.updateDeclaration}
				<div class="row is-full">
					<span class="row-label"
						>marked as an update<span class="row-hint">{project.updateDeclaration}</span></span
					>
				</div>
			{/if}
			{#if project.notesForReviewer}
				<div class="row is-full">
					<span class="row-label"
						>notes for the reviewer<span class="row-hint">{project.notesForReviewer}</span></span
					>
				</div>
			{/if}
		</div>
	</section>
{/if}

<!-- ── history ─────────────────────────────────────────────────────────────── -->
{#if data.history.length > 0}
	<section class="panel">
		<header class="panel-head"><h2 class="panel-title">history</h2></header>
		<div class="panel-body">
			<Log entries={data.history}>
				{#snippet tail(entry)}
					<!-- On the approval each still-approved ship stands on: mark it
					     hyper-chroma, or take the mark off, for people who can
					     approve. See projects/hyper-chroma.ts. -->
					{#if data.canMarkHyperChroma && entry.ship}
						<form method="POST" action="?/hyperChroma" use:enhance class="project-hc-form">
							<input type="hidden" name="submission" value={entry.ship.submissionId} />
							<input type="hidden" name="on" value={entry.ship.hyperChroma ? '0' : '1'} />
							<button type="submit" class="control-btn is-small is-quiet">
								{entry.ship.hyperChroma ? 'remove hyper-chroma' : 'mark hyper-chroma'}
							</button>
						</form>
					{/if}
				{/snippet}
			</Log>
		</div>
	</section>
{/if}

<style>
	/* What the reviewer asked for, in their words, set apart from ours. */
	.changes-ask {
		margin: 0;
		padding: 2px 0 2px 12px;
		border-left: 2px solid var(--panel-line);
		white-space: pre-wrap;
		line-height: 1.5;
	}

	/* The two panels here - the working copy and the ship panel - share one
	   form, for the reason written above the form itself. That makes the form
	   the single child .shell-main spaces, so its 24px gap falls above and
	   below the pair and nothing falls between them: "details" and "ship for
	   review" met edge to edge and read as one tall panel with a rule across
	   it. The form carries the column and the same gap, so the two stand apart
	   exactly as far as every other panel on the page does. */
	#project-form {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	/* Bigger and heavier than the other page titles. The serif ships in one
	   weight, so the weight is a hairline stroke rather than a synthesised
	   bold, which smears. */
	.project-title {
		font-size: clamp(42px, 7.5vw, 68px);
		-webkit-text-stroke: 0.7px currentColor;
		paint-order: stroke fill;
	}

	.project-hc {
		display: flex;
		margin: 0;
	}

	.project-hc-form {
		display: flex;
		margin-top: 8px;
	}

	.project-number {
		font-size: var(--text-xs);
		font-style: normal;
		color: var(--ink-dim);
		font-family: var(--font-geist-mono), ui-monospace, monospace;
	}

	/* The Hackatime project picker: a <details> disclosure standing in for a
	   multi-select, since the platform draws no such control natively. Closed,
	   it takes the same flat field material as .control-select; open, the menu
	   drops beneath it in the panel's own woven surface. */
	.hk-select {
		position: relative;
	}

	/* The panel clips its overflow for its corners, which cut the open menu
	   off at the panel's foot. While the menu is open the panel lets it out;
	   the menu keeps its own bounded height and scrolls inside that. */
	:global(.panel:has(.hk-select[open])) {
		overflow: visible;
	}

	.hk-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 9px 34px 9px 15px;
		font-size: var(--text-sm);
		line-height: 1.4286;
		color: var(--ink);
		background-color: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--control-radius);
		cursor: pointer;
		list-style: none;
		background-image: var(--weave-bayer), var(--shade-inset);
	}

	/* Same move as every other field: the fill and the edge step up together,
	   and there is no outline. */
	.hk-summary:focus,
	.hk-summary:focus-visible {
		background-color: var(--panel);
		border-color: var(--panel-line);
		background-image: var(--weave-grid);
		outline: none;
	}

	.hk-summary::-webkit-details-marker {
		display: none;
	}

	.hk-select[open] > .hk-summary {
		background-color: var(--panel);
		border-color: var(--panel-line);
		border-radius: var(--control-radius) var(--control-radius) 0 0;
		background-image: var(--weave-grid);
	}

	.hk-placeholder {
		color: var(--ink-dim);
	}

	.hk-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.hk-pill {
		padding: 2px 8px;
		font-size: var(--text-xs);
		color: var(--ink);
		background-color: var(--panel);
		border: 1px solid var(--panel-line);
		border-radius: 999px;
	}

	/* Floats over whatever is below rather than sitting in the flow: in the
	   flow it made its grid row as tall as the open list, and the url fields
	   beside it stretched to match. */
	.hk-menu {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		max-height: 220px;
		overflow-y: auto;
		overflow-x: hidden;
		color: var(--ink);
		background-color: var(--surface);
		border: 1px solid var(--panel-line);
		border-top: 0;
		border-radius: 0 0 var(--control-radius) var(--control-radius);
		background-image: var(--weave-grid), var(--shade-inset);
	}

	.hk-option {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		font-size: var(--text-xs);
		cursor: pointer;
		border-bottom: 1px solid var(--panel-line);
	}

	.hk-option:last-child {
		border-bottom: 0;
	}

	.hk-option.is-disabled {
		color: var(--ink-dim);
		cursor: not-allowed;
	}

	.hk-option-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hk-option-hours {
		flex: none;
	}

	.hk-option-hours {
		color: var(--ink-dim);
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		white-space: nowrap;
	}

	.hk-option-tag {
		font-size: 11px;
		color: var(--ink-dim);
	}

	.hk-empty {
		margin: 0;
		padding: 12px;
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	.row-url {
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		overflow-wrap: anywhere;
	}

	.project-desc {
		margin: 0 0 8px;
		line-height: 1.5;
		white-space: pre-line;
	}

	/* Scoped to this component even though it renders inside ConfirmDialog: a
	   snippet carries the style scope of the file it is written in, not the one
	   it is rendered by. */
	.kind-body {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.kind-choices {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 10px;
	}

	/* The new-project flow's kind cards, a size down: the same two answers
	   should look like the same two answers wherever they are asked. */
	.kind-choice {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		padding: 16px;
		font: inherit;
		text-align: left;
		color: var(--ink);
		background-color: var(--surface);
		background-image: var(--weave-grid), var(--shade-inset);
		border: 1px solid var(--panel-line);
		border-radius: var(--control-radius);
		cursor: pointer;
		transition:
			border-color 140ms ease,
			background-color 140ms ease;
	}

	.kind-choice:hover,
	.kind-choice:focus-visible {
		background-color: var(--level-lift);
		border-color: var(--ink);
		outline: none;
	}

	.kind-choice-title {
		margin-top: 4px;
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-size: 26px;
		line-height: 1;
	}

	.kind-choice-body {
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--ink-mid);
	}

	/* ── autosave ─────────────────────────────────────────────────────────── */

	/* The toast: the "under review" tape's material (controls-states.css) -
	   the light fill, the soft weave, pixel lettering - rounded like the
	   panels and buttons around it, across the top of the screen. It glides down into
	   place and fades away; nothing bounces. A save that failed is the same
	   strip in the alarm red, with the reason under the word. */
	.save-toast-region {
		position: fixed;
		top: max(20px, env(safe-area-inset-top));
		left: 50%;
		z-index: 50;
		width: max-content;
		max-width: calc(100vw - 32px);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.save-toast {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 10px 28px;
		color: var(--on-light);
		background-color: var(--ink);
		background-image: var(--weave-bayer), var(--shade-raised);
		border: 1px solid var(--ink);
		border-radius: var(--control-radius);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
		animation: save-arrive 360ms cubic-bezier(0.22, 1, 0.36, 1) both;
	}

	@keyframes save-arrive {
		from {
			opacity: 0;
			transform: translateY(-16px);
		}
	}

	.save-toast-word {
		display: flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-geist-pixel-square), ui-monospace, monospace;
		font-size: 18px;
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.save-toast-why {
		max-width: 46ch;
		font-size: var(--text-xs);
		line-height: 1.45;
		text-align: center;
	}

	.save-toast.is-error {
		color: #f3ccd0;
		background-color: #3a1519;
		background-image: var(--weave-alarm);
		border-color: #c2414c;
	}

	@media (prefers-reduced-motion: reduce) {
		.save-toast {
			animation: none;
		}
	}

	/* The estimate beside "ship it": the sentence in the ink, the caveat after
	   it in the hint's quieter colour, on the same line when there is room. */
	.ship-estimate {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.6;
		color: var(--ink-mid);
	}

	.ship-estimate strong {
		font-weight: 500;
		color: var(--ink);
	}

	/* The review timeline's words under its track: where the ship is, in the
	   ink, a size up from the hint beneath it. */
	.rt-status {
		margin: 4px 0 0;
		font-size: var(--text-sm);
		line-height: 1.4;
		color: var(--ink);
	}

	/* The software/hardware switch: two small pills, the picked one in the
	   light fill the primary button wears. */
	.pk-switch {
		display: inline-flex;
		align-self: flex-start;
		gap: 6px;
	}

	.pk-option {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		font-size: var(--text-xs);
		color: var(--ink-mid);
		background-color: var(--surface);
		background-image: var(--weave-bayer), var(--shade-inset);
		border: 1px solid var(--line);
		border-radius: 999px;
		cursor: pointer;
		transition:
			color 140ms ease,
			background-color 140ms ease,
			border-color 140ms ease;
	}

	.pk-option:hover {
		color: var(--ink);
		border-color: var(--panel-line);
	}

	.pk-option:has(input:focus-visible) {
		border-color: var(--ink);
	}

	.pk-option.is-picked {
		color: var(--on-light);
		background-color: var(--ink);
		background-image: var(--shade-raised);
		border-color: var(--ink);
	}

	.lock:disabled .pk-option {
		cursor: not-allowed;
	}

	/* The archive button: delete's red, with the archive box beside the words. */
	.archive-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}

	/* The reviewer panel while a review is open: no tape over it, but
	   nothing in it takes a click, and the cursor says so everywhere on it. */
	.reviewer-locked,
	.reviewer-locked :global(*) {
		cursor: not-allowed;
	}

	.confirm-body {
		margin: 0;
		line-height: 1.5;
	}

	/* [4a] The tape, laid on as the page arrives after a ship: the veil comes
	   down, then each band is drawn across from its own side and settles at
	   its angle - the form locking in front of you rather than already
	   locked. */
	.barrier.is-arriving {
		animation: barrier-veil 360ms ease 200ms backwards;
	}

	.barrier.is-arriving :global(.barrier-tape.is-second) {
		animation: tape-second 620ms cubic-bezier(0.22, 1, 0.36, 1) 320ms backwards;
	}

	.barrier.is-arriving :global(.barrier-tape.is-first) {
		animation: tape-first 620ms cubic-bezier(0.22, 1, 0.36, 1) 460ms backwards;
	}

	@keyframes barrier-veil {
		from {
			background-color: rgba(10, 10, 12, 0);
		}
	}

	@keyframes tape-second {
		from {
			transform: rotate(15deg) translateX(110%);
		}
	}

	@keyframes tape-first {
		from {
			transform: rotate(-16deg) translateX(-110%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.barrier.is-arriving,
		.barrier.is-arriving :global(.barrier-tape) {
			animation: none;
		}
	}
</style>
