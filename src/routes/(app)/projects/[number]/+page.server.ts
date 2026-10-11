import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordEvent } from '$lib/server/analytics';
import { can, mayActOnSelf, requireCapability } from '$lib/server/auth/authorize';
import { eligibilityAllows } from '$lib/server/auth/eligibility';
import { getLinkedHackatime, listHackatimeProjects } from '$lib/server/auth/hackatime';
import { fetchHcaAddresses, hcaAddressPortalUrl } from '$lib/server/auth/hca';
import { requireOnboarded } from '$lib/server/auth/session';
import { uploadImageBlob } from '$lib/server/cdn';
import { ariReviewUrl, ariShipsForProject } from '$lib/server/ari';
import { PHASE_LABELS, PHASE_ORDER, reviewPhase } from '$lib/server/ari-live';
import { NO_AI } from '$lib/ai-declaration';
import { fraudRejected, liftFraudBlock } from '$lib/server/projects/fraud';
import { setHyperChroma } from '$lib/server/projects/hyper-chroma';
import { projectLog } from '$lib/server/projects/log';
import { newTimeByProject } from '$lib/server/projects/window';
import type { Project, SubmissionState } from '$lib/server/db/schema';
import {
	archiveProject,
	deleteProject,
	claimedElsewhere,
	fillProjectKind,
	isProjectKind,
	claimedElsewhereError,
	hackatimeNamesInUse,
	isUnderReview,
	parseProjectNames,
	projectByNumber,
	updateProject,
	UNDER_REVIEW
} from '$lib/server/projects/projects';
import {
	resumeAfterChanges,
	shipProject,
	submissionsForProject
} from '$lib/server/projects/review';

/**
 * One project, serving two readers.
 *
 * The owner gets the working copy to edit, a ship control, and the history of
 * what they shipped - with the internal notes kept out. Staff who can see
 * other people's projects (`review_submissions`) get the working copy
 * read-only and the history with its internal side. Nothing is decided here:
 * review happens on Ari, and its decisions arrive through /api/ari/webhook.
 * Every action re-authorises itself in the domain.
 */

const OPEN: SubmissionState[] = ['pending', 'first_passed'];

/** The route param is the project's public number (1, 2, 3, ...), never the
 *  UUID primary key. Anything that is not a positive integer is the same "not
 *  found" as a number nobody has shipped yet - never a 500 from a malformed
 *  query parameter. */
function parseNumber(raw: string): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export const load: PageServerLoad = async ({ params }) => {
	const user = requireOnboarded();

	const number = parseNumber(params.number);
	const project = number === null ? null : await projectByNumber(number);
	if (!project) error(404);

	const isOwner = project.userId === user.id;
	const canReview = can(user, 'review_submissions');
	/* Not found rather than forbidden: a participant probing other people's
	   project numbers learns nothing they could not already guess. */
	if (!isOwner && !canReview) error(404);

	const subs = await submissionsForProject(project.id);
	const latest = subs[0] ?? null;
	/* Asked for changes and not yet answered: the project opens for editing
	   again, and the ship panel becomes the place to say they are done. */
	const changesRaw = latest?.state === 'changes_requested' ? latest : null;
	const openRaw = latest && OPEN.includes(latest.state) ? latest : null;

	/* Staff see the internals of the history; the author never sees them. An
	   owner testing the flow on their own project (see mayActOnSelf) is the
	   one author who does, because in that case the author is also staff. */
	const reveal = canReview && (!isOwner || mayActOnSelf(user));
	const eligible = eligibilityAllows(user.eligibility);
	const hasOpen = openRaw !== null;

	/* The history: one entry per move, oldest first, with reviewers' comments
	   for a reader who may see the internal side. See projectLog, which the
	   review desk draws from too. */
	const history = await projectLog(project.id, subs, reveal);

	/* The owner's Hackatime picker: the linked account's own projects, each
	   marked when it is already spoken for by one of this user's OTHER
	   projects, so a name cannot be double-counted across two submissions. Not
	   linked and "linked, but the list failed to load" are kept apart - the
	   first offers a link-out, the second a retry message - the same shape as
	   the address fetch just below. */
	let hackatimeLinked = false;
	let hackatimeProjects: { name: string; totalSeconds: number; disabled: boolean }[] | null = null;
	let hackatimeError = false;
	if (isOwner) {
		const linked = await getLinkedHackatime(user.id);
		hackatimeLinked = linked !== null;
		if (linked) {
			try {
				const list = await listHackatimeProjects(user.id);
				if (list) {
					const inUse = await hackatimeNamesInUse(user.id, project.id);
					/* Hackatime only lists projects with time since the cutoff (see
					   HACKATIME_COUNTS_FROM), so one this project already links but
					   has not touched since would vanish from the menu and leave a
					   pill nobody can untick. Kept, at the zero it now counts for. */
					const listed = new Set(list.map((entry) => entry.name));
					const stale = parseProjectNames(project.hackatimeProjects)
						.filter((name) => !listed.has(name))
						.map((name) => ({ name, totalSeconds: 0 }));
					hackatimeProjects = [...list, ...stale]
						.map((entry) => ({ ...entry, disabled: inUse.has(entry.name) }))
						.sort((a, b) => b.totalSeconds - a.totalSeconds);
				}
			} catch {
				hackatimeError = true;
			}
		}
	}

	/* Whether there is an address on the owner's HCA account, checked only when
	   the ship form will actually render (owner, eligible, nothing already in
	   review). The ship goes to the primary address; choosing between several
	   is a shop concern, not a review one. */
	let hasAddress = false;
	let addressError = false;
	let addressPortalUrl: string | null = null;
	/* The approved ship an update is counted from, and the new Hackatime time
	   on every project since it - per project, so the ship panel can add up
	   whichever are ticked. Counted from the moment of that ship (see
	   projects/window.ts). Null when there is no approved ship, or Hackatime
	   could not be asked; the server still checks at ship. */
	const baseline =
		subs.find((submission) => submission.state === 'approved' || submission.state === 'revoked') ??
		null;
	let sinceLastShip: Record<string, number> | null = null;
	if (isOwner && eligible && !hasOpen && !changesRaw && baseline) {
		try {
			sinceLastShip = await newTimeByProject(user.id, baseline.createdAt);
		} catch {
			sinceLastShip = null;
		}
	}
	if (isOwner && eligible && !hasOpen && !changesRaw) {
		/* Before the fetch, for the reason the shop page gives: it cannot fail
		   because HCA is down, and building it inside the `try` took the link
		   away on the one error that makes somebody need it. */
		addressPortalUrl = hcaAddressPortalUrl();
		try {
			const list = await fetchHcaAddresses(user.id);
			hasAddress = (list ?? []).length > 0;
		} catch {
			addressError = true;
		}
	}

	return {
		project: {
			number: project.number,
			name: project.name,
			description: project.description,
			repoUrl: project.repoUrl,
			demoUrl: project.demoUrl,
			screenshotUrl: project.screenshotUrl,
			kind: project.kind,
			hackatimeProjects: project.hackatimeProjects,
			aiDeclaration: project.aiDeclaration,
			updateDeclaration: project.updateDeclaration,
			notesForReviewer: project.notesForReviewer,
			changelogDraft: project.changelogDraft
		},
		isOwner,
		canReview,
		/* Whether this reader sees the internal side of the history. */
		reviewing: reveal,
		/* Staff only: where this project is reviewed on Ari, newest ship first. */
		ariReviews:
			!isOwner && canReview
				? (await ariShipsForProject(project.id)).flatMap((ship) => {
						const url = ariReviewUrl(ship.ariId);
						return url ? [{ url, sentAt: ship.createdAt }] : [];
					})
				: [],
		eligible,
		hasSubmissions: subs.length > 0,
		/* Put away - see archiveProject. The page says so and offers it back;
		   ships wait until it is. */
		archived: project.archivedAt !== null,
		/* Whether it could be put away: shipped, never approved, and nothing
		   still in review. The same rule archiveProject enforces. */
		canArchive:
			isOwner &&
			project.archivedAt === null &&
			subs.length > 0 &&
			!subs.some((submission) =>
				['approved', 'revoked', 'pending', 'first_passed', 'changes_requested'].includes(
					submission.state
				)
			),
		/* Approved or revoked: either is the baseline a reship is measured
		   against, and the server asks for a changelog whenever there is one. */
		hasApproved: subs.some(
			(submission) => submission.state === 'approved' || submission.state === 'revoked'
		),
		hasOpen,
		/* Turned down for fraud, so the ship panel says so instead of offering
		   a ship that would be refused - see projects/fraud.ts. */
		fraudBlocked: !hasOpen && !changesRaw ? await fraudRejected(project.id) : false,
		/* Whether this reader may lift that block - see liftFraudBlock. */
		canLiftFraud: !isOwner && can(user, 'manage_fraud'),
		/* Any approved ship marked exceptionally good - see
		   projects/hyper-chroma.ts. */
		hyperChroma: subs.some(
			(submission) => submission.state === 'approved' && submission.hyperChroma
		),
		/* Whether this reader may mark approved ships hyper-chroma by hand:
		   people who can approve, and not on their own project unless they are
		   the owner testing it (the same rule as a self-review). */
		canMarkHyperChroma: can(user, 'approve_submissions') && (!isOwner || mayActOnSelf(user)),
		/* Where the open ship is on Ari, for its owner - streamed: the page
		   renders straight away and this fills in when Ari answers (see
		   lib/server/ari-live.ts). `step` is its place on the page's timeline.
		   Null is "under review", nothing more. */
		reviewStatus:
			isOwner && openRaw
				? reviewPhase(openRaw.id).then((phase) =>
						phase ? { step: PHASE_ORDER.indexOf(phase), label: PHASE_LABELS[phase] } : null
					)
				: null,
		/* When the open ship went in, for the timeline's "shipped 2 days ago". */
		shippedAt: openRaw?.createdAt ?? null,
		/* What the ship floor measures a claim against, so the page can grey out
		   "ship it" before it is pressed. `subs` is newest-first, so the first
		   approved one is the baseline shipProject will use. */
		shipFloor: {
			/* Whether there is an approved ship to count new time from - an
			   update ship needs an hour of it. */
			isUpdate: baseline !== null,
			sinceLastShip,
			afterRejection: latest?.state === 'rejected'
		},
		history,
		/* What the reviewer asked for, in the words the author was sent. */
		changes: changesRaw ? { message: changesRaw.publicMessage } : null,
		hackatimeLinked,
		hackatimeProjects,
		hackatimeError,
		hasAddress,
		addressError,
		addressPortalUrl
	};
};

/* ── form helpers ────────────────────────────────────────────────────────── */

function trimmed(form: FormData, key: string): string | null {
	const value = form.get(key);
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function draftFrom(
	form: FormData,
	screenshotUrl: string | null,
	current: Pick<
		Project,
		'aiDeclaration' | 'updateDeclaration' | 'notesForReviewer' | 'changelogDraft'
	>
) {
	/**
	 * The "for the reviewer" panel saves with everything else - it is part of
	 * the working copy, so it can be written long before shipping - but only
	 * when its fields were actually on the page that submitted this form.
	 *
	 * They sit in a fieldset that goes dead while a review is open, and a
	 * disabled field is not submitted: on that page the form carries none of
	 * them, and reading them would blank four columns. `ship_fields` is a
	 * hidden input beside them, so it is submitted exactly when they are -
	 * absent means "this form was never asked", not "the answer is empty".
	 *
	 * "i did not use AI" is stored as the declaration it stands for, so the
	 * tick survives a save the same as typed text does.
	 */
	const asked = form.has('ship_fields');
	const projectKind = form.get('project_kind');
	const aiDeclaration = form.get('no_ai') === 'on' ? NO_AI : trimmed(form, 'ai_declaration');
	return {
		name: String(form.get('name') ?? ''),
		description: trimmed(form, 'description'),
		repoUrl: trimmed(form, 'repo_url'),
		demoUrl: trimmed(form, 'demo_url'),
		screenshotUrl,
		hackatimeProjects: trimmed(form, 'hackatime_projects'),
		aiDeclaration: asked ? aiDeclaration : current.aiDeclaration,
		/* Non-null is the mark (see the column), so unticked saves as null -
		   the text stays in the page's own state until it is reloaded. */
		updateDeclaration: asked
			? form.get('is_update') === 'on'
				? trimmed(form, 'update_declaration')
				: null
			: current.updateDeclaration,
		notesForReviewer: asked ? trimmed(form, 'notes_for_reviewer') : current.notesForReviewer,
		/* The details panel's software/hardware switch. Absent (a page that
		   did not draw it, or a locked fieldset) leaves the kind alone. */
		kind: isProjectKind(projectKind) ? projectKind : undefined,
		changelogDraft: asked ? trimmed(form, 'changelog') : current.changelogDraft
	};
}

/**
 * The screenshot the save should end up with.
 *
 * Nothing about the current picture travels through the form. A picked file
 * is uploaded and wins; `screenshot_clear` says the owner removed it; anything
 * else keeps what is stored. The form used to round-trip the current url and
 * the server only trusted it back from the CDN, which silently dropped any
 * picture that came from anywhere else on the next save.
 */
async function resolveScreenshot(
	form: FormData,
	current: string | null
): Promise<{ url: string | null } | { error: string }> {
	const file = form.get('screenshot1');
	if (file instanceof File && file.size > 0) {
		try {
			return { url: await uploadImageBlob(file, file.name) };
		} catch (e) {
			return { error: e instanceof Error ? e.message : 'Screenshot upload failed.' };
		}
	}
	if (form.get('screenshot_clear') === '1') return { url: null };
	return { url: current };
}

/**
 * The `save` action's own body, factored out so `ship` can run it first.
 *
 * The two panels are one `<form>` now (see `+page.svelte`) precisely so this
 * can happen: shipping without saving used to mean `shipProject` read the
 * project row as it stood before whatever the person had just typed, because
 * that row is exactly what `save` - and nothing else - ever wrote. A rename
 * typed one second before hitting "ship it" was a rename that never happened.
 */
async function saveWorkingCopy(
	number: number,
	userId: string,
	form: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
	const current = await projectByNumber(number);
	if (!current || current.userId !== userId) {
		return { ok: false, error: 'That project does not exist.' };
	}

	/* Every reason this edit can be refused, BEFORE the screenshot is uploaded.
	   The upload used to come first, so a save against a project locked for
	   review sent the file to the CDN and then returned the refusal - a form
	   somebody knows will fail is then a way to push files at our CDN credential
	   for free, as fast as they care to submit it. Refusing first costs a query
	   and uploads nothing.

	   `updateProject` still makes both of these checks itself. This is the cheap
	   early exit; that one is the gate. */
	if (!String(form.get('name') ?? '').trim()) {
		return { ok: false, error: 'A project needs a name.' };
	}
	if (await isUnderReview(number, userId)) return { ok: false, error: UNDER_REVIEW };
	const taken = await claimedElsewhere(userId, current.id, trimmed(form, 'hackatime_projects'));
	if (taken.length > 0) return { ok: false, error: claimedElsewhereError(taken) };

	const shot = await resolveScreenshot(form, current.screenshotUrl);
	if ('error' in shot) return { ok: false, error: shot.error };
	const result = await updateProject(number, userId, draftFrom(form, shot.url, current));
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true };
}

export const actions: Actions = {
	save: async ({ params, request }) => {
		const user = requireOnboarded();
		const number = parseNumber(params.number);
		if (number === null) return fail(404, { error: 'That project does not exist.' });
		const form = await request.formData();
		const result = await saveWorkingCopy(number, user.id, form);
		if (!result.ok) return fail(400, { error: result.error });
		return { saved: true };
	},

	ship: async ({ params, request }) => {
		const user = requireOnboarded();
		const number = parseNumber(params.number);
		if (number === null) return fail(404, { error: 'That project does not exist.' });
		const form = await request.formData();

		/* A project from before the kind was asked has to answer it to ship -
		   the page asks in a dialog on the way (see "ship it"), and this is the
		   rule behind the dialog. Checked before the save so a refusal writes
		   nothing; filled after it, so a save that fails leaves it blank too. */
		const current = await projectByNumber(number);
		/* The dialog's answer, or the details panel's switch if it was set
		   there instead - either answers the question. */
		const kind = isProjectKind(form.get('kind')) ? form.get('kind') : form.get('project_kind');
		const needsKind = current !== null && current.userId === user.id && current.kind === null;
		if (needsKind && !isProjectKind(kind)) {
			return fail(400, { error: 'Say whether it is a software or a hardware project first.' });
		}

		const saved = await saveWorkingCopy(number, user.id, form);
		if (!saved.ok) return fail(400, { error: saved.error });
		if (needsKind && isProjectKind(kind)) await fillProjectKind(number, user.id, kind);

		const result = await shipProject({
			user,
			projectNumber: number,
			changelog: trimmed(form, 'changelog'),
			addressId: null,
			noAi: form.get('no_ai') === 'on',
			aiDeclaration: trimmed(form, 'ai_declaration'),
			isUpdate: form.get('is_update') === 'on',
			updateDeclaration: trimmed(form, 'update_declaration'),
			notesForReviewer: trimmed(form, 'notes_for_reviewer')
		});
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.shipped', {
			kind: isProjectKind(kind) ? kind : current?.kind,
			is_update: form.get('is_update') === 'on',
			no_ai: form.get('no_ai') === 'on',
			notes_for_reviewer: Boolean(trimmed(form, 'notes_for_reviewer'))
		});
		/* `?shipped`: the page lays the review tape across the form as it
		   arrives, once (see justShipped there). */
		redirect(303, `/projects/${number}?shipped`);
	},

	/* The requested changes are made: save what is on the page, the same as
	   a ship does, then put the submission back in the queue where it was.
	   See resumeAfterChanges. */
	changesDone: async ({ params, request }) => {
		const user = requireOnboarded();
		const number = parseNumber(params.number);
		if (number === null) return fail(404, { error: 'That project does not exist.' });
		const form = await request.formData();

		const saved = await saveWorkingCopy(number, user.id, form);
		if (!saved.ok) return fail(400, { error: saved.error });

		const result = await resumeAfterChanges({
			user,
			projectNumber: number,
			note: trimmed(form, 'changes_note')
		});
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.resubmitted');
		/* `?shipped`: the page lays the review tape across the form as it
		   arrives, once (see justShipped there). */
		redirect(303, `/projects/${number}?shipped`);
	},

	archive: async ({ params }) => {
		const user = requireOnboarded();
		const number = parseNumber(params.number);
		if (number === null) return fail(404, { error: 'That project does not exist.' });
		const result = await archiveProject(number, user.id, true);
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.archived');
		redirect(303, '/projects/archived');
	},

	unarchive: async ({ params }) => {
		const user = requireOnboarded();
		const number = parseNumber(params.number);
		if (number === null) return fail(404, { error: 'That project does not exist.' });
		const result = await archiveProject(number, user.id, false);
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.unarchived');
		return { unarchived: true };
	},

	/* Staff with `manage_fraud`: let a project turned down for fraud ship
	   again. See liftFraudBlock. */
	liftFraud: async ({ params, request }) => {
		const actor = requireCapability('manage_fraud');
		const number = parseNumber(params.number);
		const project = number === null ? null : await projectByNumber(number);
		if (!project) return fail(404, { error: 'That project does not exist.' });
		const reason = String((await request.formData()).get('reason') ?? '');
		const result = await liftFraudBlock(project.id, actor.id, reason);
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.fraud_lifted');
		return { fraudLifted: true };
	},

	/* Staff with `approve_submissions`: mark one approved ship hyper-chroma
	   by hand, or take the mark off. `on=1` to mark, anything else to remove,
	   stated rather than toggled so a double-submit lands where it meant to.
	   See projects/hyper-chroma.ts. */
	hyperChroma: async ({ params, request }) => {
		const actor = requireCapability('approve_submissions');
		const number = parseNumber(params.number);
		const project = number === null ? null : await projectByNumber(number);
		if (!project) return fail(404, { error: 'That project does not exist.' });
		if (project.userId === actor.id && !mayActOnSelf(actor)) {
			return fail(403, { error: 'You cannot mark your own project hyper-chroma.' });
		}
		const form = await request.formData();
		const on = form.get('on') === '1';
		const result = await setHyperChroma({
			projectId: project.id,
			submissionId: String(form.get('submission') ?? ''),
			on,
			actorId: actor.id
		});
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.hyper_chroma_changed', { on });
		redirect(303, `/projects/${project.number}`);
	},

	delete: async ({ params }) => {
		const user = requireOnboarded();
		const number = parseNumber(params.number);
		if (number === null) return fail(404, { error: 'That project does not exist.' });
		const result = await deleteProject(number, user.id);
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.deleted');
		redirect(303, '/projects');
	}
};
