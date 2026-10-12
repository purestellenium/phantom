import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { chooseAddress } from '$lib/server/address';
import { ARI_INGEST_EFFECT, ariIngestDedupeKey, latestAriShip } from '$lib/server/ari';
import { recordAudit } from '$lib/server/audit';
import { eligibilityAllows } from '$lib/server/auth/eligibility';
import { currentEligibility } from '$lib/server/auth/eligibility-refresh';
import { fetchHackatimeSeconds } from '$lib/server/auth/hackatime';
import { fetchHcaAddresses, type HcaAddress } from '$lib/server/auth/hca';
import { currentOrigin } from '$lib/server/auth/origin';
import type { SessionUser } from '$lib/server/auth/session';
import type { DbHandle } from '$lib/server/audit';
import { bindings, encryptJson } from '$lib/server/crypto';
import { db } from '$lib/server/db/client';
import {
	auditEvents,
	projects,
	submissionComments,
	submissionTransitions,
	submissions,
	users,
	type Submission,
	type SubmissionState,
	type UserRole
} from '$lib/server/db/schema';
import { repoVisibility } from '$lib/server/github';
import { nudgeOutbox } from '$lib/server/jobs';
import { enqueue } from '$lib/server/outbox';
import {
	claimedElsewhere,
	claimedElsewhereError,
	lockClaims,
	parseProjectNames
} from '$lib/server/projects/projects';
import { FRAUD_REJECTED, fraudRejected } from '$lib/server/projects/fraud';
import { newTimeSince } from '$lib/server/projects/window';
import type { JsonObject } from '$lib/json';
import type { LogEntry } from '$lib/log';
import { NO_AI } from '$lib/ai-declaration';
import { isStillImageUrl, NOT_STILL_IMAGE } from '$lib/images';
import { shipShortfall } from '$lib/ship-floor';
import { isUuid } from '$lib/uuid';

/**
 * Shipping a project for review, and the parts of a review Phantom still owns.
 *
 * A submission is the review unit: it froze the project and the Hackatime claim
 * at ship time, so a reviewer judges exactly what was shipped. Reviewing itself
 * happens on Ari - a ship is sent there (the `ari.ingest` outbox effect, see
 * lib/server/ari.ts) and every decision comes back through its webhook and is
 * applied by projects/decisions.ts. What stays here is the participant's half:
 * shipping, and sending a project back after a reviewer asked for changes.
 *
 * Every state move guards on the state it expects to be leaving, so a stale
 * tab - or a late delivery from Ari - updates zero rows instead of winning a
 * race.
 */

/** Waiting on Ari. `first_passed` is the old on-platform two-step's middle
 *  state, kept here because a submission left in it is still open. */
export const OPEN_STATES = ['pending', 'first_passed'] as const;

/* A reship would start a new ship at the back of Ari's queue, which is the
   thing sending it back after changes exists to spare them. */
const CHANGES_NOT_RESHIP =
	'Changes were requested on this project. Make them and send it back instead of reshipping.';

/* ── helpers ─────────────────────────────────────────────────────────────── */

export async function latestSubmission(
	projectId: string,
	handle: DbHandle = db
): Promise<Submission | null> {
	const [row] = await handle
		.select()
		.from(submissions)
		.where(eq(submissions.projectId, projectId))
		.orderBy(desc(submissions.createdAt))
		.limit(1);
	return row ?? null;
}

/**
 * The states whose claim is a project's baseline: approved, and approved then
 * revoked. A revocation (the old on-platform one) took the hours back but left
 * them consumed, so the same tracked time could not be shipped for again.
 *
 * `reverted` is deliberately not here. When Ari reverts or requeues an
 * approval the hours come back off the balance AND stay shippable - the
 * decision was taken back, not found to be a double-dip - so the project's
 * baseline falls back to whatever was approved before it.
 */
export const BASELINE_STATES = ['approved', 'revoked'] as const;

/** The most recent approved (or revoked) submission - its claim is the
 *  baseline, and its existence marks the project as one with prior approved
 *  work (an update ship). */
export async function lastApproved(
	projectId: string,
	handle: DbHandle = db
): Promise<Submission | null> {
	const [row] = await handle
		.select()
		.from(submissions)
		.where(
			and(eq(submissions.projectId, projectId), inArray(submissions.state, [...BASELINE_STATES]))
		)
		.orderBy(desc(submissions.createdAt))
		.limit(1);
	return row ?? null;
}

/**
 * Take the project's row for the length of the transaction.
 *
 * `for update` rather than a plain read, and that is the point of the function
 * rather than an incidental detail. Everything that decides what a submission
 * is worth reads the project's BASELINE - the newest approved submission - and
 * two transactions that read the same baseline both believe the same hours are
 * unspent. Holding the project row makes every ship and every approval on one
 * project queue behind the last, so the baseline each of them reads is the
 * baseline the one before it left.
 */
export async function lockProject(
	handle: DbHandle,
	projectId: string
): Promise<{
	id: string;
	userId: string;
	hackatimeProjects: string | null;
} | null> {
	const [row] = await handle
		.select({
			id: projects.id,
			userId: projects.userId,
			hackatimeProjects: projects.hackatimeProjects
		})
		.from(projects)
		.where(eq(projects.id, projectId))
		.for('update')
		.limit(1);
	return row ?? null;
}

/** The new-work delta up for review on a submission, given its project's baseline. */
export async function newWorkFor(submission: Submission, handle: DbHandle = db): Promise<number> {
	const baseline = await lastApproved(submission.projectId, handle);
	return newWorkFrom(submission, baseline);
}

/**
 * The new Hackatime time recorded when this submission shipped, counted from
 * the last approved ship (see projects/window.ts). Null for a ship with no approval before it.
 */
export async function sinceLastShipAtShip(
	submissionId: string,
	handle: DbHandle = db
): Promise<number | null> {
	const [row] = await handle
		.select({ metadata: submissionTransitions.metadata })
		.from(submissionTransitions)
		.where(
			and(
				eq(submissionTransitions.submissionId, submissionId),
				sql`${submissionTransitions.fromState} is null`
			)
		)
		.orderBy(submissionTransitions.createdAt)
		.limit(1);
	const value = row?.metadata?.sinceLastShip;
	return typeof value === 'number' ? value : null;
}

/**
 * The new work Phantom itself counts for this submission. Recorded beside an
 * approval and shown to Ari's reviewers; the grant is Ari's own figure.
 *
 * The claim past the last approved claim - Phantom's rule since the start -
 * or the new time since the last approved ship, whichever is more. The second
 * exists for the cutoff moving: a claim counted from August 6 measured against
 * a baseline counted from January 1 comes out short (or below zero) for work
 * that is genuinely new, and the time since the last ship does not depend on
 * where counting starts. Neither can count time from before the last approved
 * ship, so taking the larger never pays the same time twice.
 */
export async function grantCap(submission: Submission, handle: DbHandle = db): Promise<number> {
	const claimDelta = await newWorkFor(submission, handle);
	const since = await sinceLastShipAtShip(submission.id, handle);
	return Math.max(0, claimDelta, since ?? 0);
}

/**
 * The address a Slack message links back to, captured while there is a request
 * whose origin is the public one.
 *
 * The message itself is posted later, by the outbox, on whatever request the
 * job runner happened to arrive on - a cron hitting an internal address, as
 * like as not - so the origin is read now and carried in the payload. A ship
 * is the participant's own request; a decision is Ari's delivery to the public
 * webhook URL, which arrives on the public host too. Null outside a request (a
 * script, a test), which the message treats as "no link" rather than as a
 * failure.
 */
export async function linkOrigin(): Promise<string | null> {
	try {
		return await currentOrigin();
	} catch {
		return null;
	}
}

/**
 * The same subtraction, with the baseline already in hand.
 *
 * Split out so a caller holding many submissions can fetch every baseline at
 * once and still compute the delta the one way. Without this the arithmetic
 * would be written twice - here and in whatever batched the lookup - and two
 * copies of "what counts as new work" is exactly the thing that drifts.
 */
export function newWorkFrom(submission: Submission, baseline: Submission | null): number {
	return newWorkFromClaim(submission.claimedSeconds, baseline);
}

/**
 * The same subtraction again, for a caller holding the claim but not the row.
 *
 * The dashboard is the caller: it reads a handful of columns off its
 * submissions rather than whole rows - one of which is the encrypted shipping
 * envelope - and a full select made only to satisfy this signature would be
 * pulling that around a page that has no business with it. So the arithmetic
 * stays here, in one place, and `newWorkFrom` is now a thin wrapper over it.
 * Both still mean: what is up for review is what was not approved last time.
 */
export function newWorkFromClaim(claimedSeconds: number, baseline: Submission | null): number {
	return claimedSeconds - (baseline?.claimedSeconds ?? 0);
}

/**
 * The latest approved submission for each of many projects, in ONE query.
 *
 * The review queue is the reason this exists. Calling `newWorkFor` per item ran
 * `lastApproved` once per row - 68 queue items, 68 queries - which is invisible
 * against a local database at a millisecond each and costs about nine seconds
 * against one ~175ms away, where a round trip dwarfs the work. Measured on the
 * real queue: 1978ms as a loop, 355ms as this.
 *
 * DISTINCT ON is the point. Postgres sorts by (project_id, created_at desc) and
 * keeps the first row per project, so "the newest approved submission for each
 * of these projects" is one scan rather than N ordered limit-1 lookups. The
 * ORDER BY must lead with the same expression the DISTINCT ON names - that is
 * the rule the feature is built on, not a stylistic choice, and reordering it
 * silently returns an arbitrary row per project instead of the newest.
 *
 * Projects with nothing approved are simply absent from the map; the caller
 * treats a miss as a zero baseline, which is what `newWorkFrom` does with null.
 */
export async function lastApprovedByProject(
	projectIds: readonly string[],
	handle: DbHandle = db
): Promise<Map<string, Submission>> {
	/* An empty `in ()` is a syntax error in some drivers and a query that can
	   match nothing in the rest, so the round trip is skipped rather than sent. */
	const ids = [...new Set(projectIds)];
	if (ids.length === 0) return new Map();

	const rows = await handle
		.selectDistinctOn([submissions.projectId])
		.from(submissions)
		.where(
			and(inArray(submissions.projectId, ids), inArray(submissions.state, [...BASELINE_STATES]))
		)
		.orderBy(submissions.projectId, desc(submissions.createdAt));

	return new Map(rows.map((row) => [row.projectId, row]));
}

/* ── shipping ────────────────────────────────────────────────────────────── */

export type ShipInput = {
	user: SessionUser;
	projectNumber: number;
	/** "What did you add since the last ship?" - required on an update ship. */
	changelog: string | null;
	/** The HCA address id chosen to ship to; null falls back to the primary. */
	addressId: string | null;
	/** "I did not use AI." Checked stands in for a declaration. */
	noAi: boolean;
	/** What AI was used for. Required unless `noAi`. Written onto the project
	 *  and frozen onto the submission. */
	aiDeclaration: string | null;
	/** "This is an update to something that already existed." The owner's own
	 *  mark, for work Phantom's history cannot see - a project carried over from
	 *  another program reads as brand new here. */
	isUpdate: boolean;
	/** Where it was submitted before, what they had, and what they changed - one
	 *  field, the shape the AI declaration already uses. Required when
	 *  `isUpdate`; written onto the project and frozen onto the submission. */
	updateDeclaration: string | null;
	/** Anything else the owner wants the reviewer to know. Answers no question,
	 *  so nothing here can refuse it - written onto the project and frozen onto
	 *  the submission exactly as typed, or null when they said nothing. */
	notesForReviewer: string | null;
};
export type ShipResult = { ok: true; submission: Submission } | { ok: false; error: string };

export async function shipProject(input: ShipInput): Promise<ShipResult> {
	const { user } = input;

	/* The stored decision - from their last sign-in or "check again". No call to
	   HCA; see lib/auth/eligibility-refresh.ts. */
	if (!eligibilityAllows(await currentEligibility(user))) {
		return {
			ok: false,
			error: 'You need to be verified and eligible with Hack Club before you can ship a project.'
		};
	}

	const [project] = await db
		.select()
		.from(projects)
		.where(and(eq(projects.number, input.projectNumber), eq(projects.userId, user.id)))
		.limit(1);
	if (!project) return { ok: false, error: 'That project does not exist.' };

	/* Put away by its owner: brought back first, then shipped. */
	if (project.archivedAt !== null) {
		return { ok: false, error: 'This project is archived. Bring it back to ship it.' };
	}

	/* Turned down for fraud: not a thing to fix and resubmit. See fraud.ts. */
	if (await fraudRejected(project.id)) return { ok: false, error: FRAUD_REJECTED };

	if (!project.name.trim())
		return { ok: false, error: 'Give your project a name before shipping.' };
	if (!project.description?.trim()) {
		return { ok: false, error: 'Add a description before shipping.' };
	}
	if (!project.repoUrl) return { ok: false, error: 'Add a repository URL before shipping.' };
	if (!project.demoUrl) return { ok: false, error: 'Add a demo URL before shipping.' };
	/* Required, and not merely expected. Three things downstream assume it: a
	   reviewer judges the shot frozen onto the submission, the explore page draws
	   it as the card's face, and the YSWS record has a Screenshot column that
	   `postAirtableSubmission` simply omits when there is nothing to put in it -
	   so a submission that shipped without one files an incomplete record and
	   nothing anywhere says so. OneKey refuses the same way at the same point.

	   The picker can clear a shot as well as set one, so this is reachable by an
	   owner who removes theirs and ships, not only by one who never added it. */
	if (!project.screenshotUrl) return { ok: false, error: 'Add a screenshot before shipping.' };
	/* A still image only - a screenshot uploaded before the rule, or from
	   somewhere else, can still be a GIF. Refused like a missing field, so it
	   is replaced rather than shipped. */
	if (!isStillImageUrl(project.screenshotUrl)) {
		return { ok: false, error: `${NOT_STILL_IMAGE} Replace it, then ship.` };
	}
	if (!project.kind) {
		return { ok: false, error: 'Say whether it is a software or a hardware project first.' };
	}
	const names = parseProjectNames(project.hackatimeProjects);
	if (names.length === 0) {
		return { ok: false, error: 'Link at least one Hackatime project before shipping.' };
	}

	/* Ari shows the maker by their Slack account and refuses a ship without
	   one, so a ship that cannot carry it is refused here, where it can be
	   fixed, rather than vanishing into a failed send. */
	if (!user.slackId) {
		return {
			ok: false,
			error:
				'Link a Slack account to your Hack Club account before shipping - reviewers need it to reach you.'
		};
	}

	/* Review needs a public repository, and a private or missing one is a
	   ship Ari turns down. Asked of GitHub only - a repository elsewhere is left
	   for Ari - and only refused on GitHub's own "no such repository": a check
	   that could not be made lets the ship through. */
	if ((await repoVisibility(project.repoUrl)) === 'missing') {
		return {
			ok: false,
			error:
				"Your repository is private or doesn't exist. Make it public on GitHub, then ship again."
		};
	}

	/* An address on record - the YSWS/Airtable record needs one. Read live from
	   HCA; adding or editing one happens on HCA's own portal. */
	let addresses: HcaAddress[] | null;
	try {
		addresses = await fetchHcaAddresses(user.id, { fresh: true });
	} catch {
		return { ok: false, error: 'Could not reach Hack Club to read your address. Try again.' };
	}
	if (addresses === null) {
		return { ok: false, error: 'Reconnect your Hack Club account so we can read your address.' };
	}
	if (addresses.length === 0) {
		return {
			ok: false,
			error: 'Add a shipping address to your Hack Club account before shipping.'
		};
	}
	const address = chooseAddress(addresses, {
		requestedId: input.addressId,
		defaultId: user.defaultAddressId
	});
	if (!address) {
		return {
			ok: false,
			error: 'Add a shipping address to your Hack Club account before shipping.'
		};
	}

	/* The cheap refusal for the ordinary double-submit, before a network call is
	   spent on a ship that is going to be refused. NOT the gate: this runs
	   outside the transaction and outside any lock, so two genuinely concurrent
	   requests both pass it. The gate is the same check below, holding the
	   project's row. */
	const pending = await latestSubmission(project.id);
	if (pending && (pending.state === 'pending' || pending.state === 'first_passed')) {
		return { ok: false, error: 'A review is already pending for this project.' };
	}
	if (pending?.state === 'changes_requested') return { ok: false, error: CHANGES_NOT_RESHIP };

	/* The approved ship an update is counted from, read here so the Hackatime
	   questions below can be asked outside the transaction. The transaction
	   reads it again under the project's lock and refuses if it moved. */
	const priorApproval = await lastApproved(project.id);

	let claimed: number | null;
	let sinceLastShip: number | null = null;
	try {
		claimed = await fetchHackatimeSeconds(user.id, names);
		if (claimed !== null && priorApproval) {
			sinceLastShip = await newTimeSince(user.id, names, priorApproval.createdAt);
			if (sinceLastShip === null) claimed = null;
		}
	} catch {
		return {
			ok: false,
			error: 'Could not reach Hackatime to count your hours. Try again in a moment.'
		};
	}
	if (claimed === null) {
		return { ok: false, error: 'Reconnect your Hackatime account - we could not read your hours.' };
	}

	const aiDeclaration = input.noAi ? NO_AI : input.aiDeclaration?.trim() || null;
	if (!aiDeclaration) {
		return { ok: false, error: 'Say what you used AI for, or confirm that you did not.' };
	}

	const changelog = input.changelog?.trim() || null;
	const notesForReviewer = input.notesForReviewer?.trim() || null;

	/* The owner's own update mark. Unticking is how it is taken back, so an
	   unticked box writes null over whatever the project was carrying - the box
	   and the column say the same thing or the declaration outlives the claim. */
	const updateDeclaration = input.isUpdate ? input.updateDeclaration?.trim() || null : null;
	if (input.isUpdate && !updateDeclaration) {
		return {
			ok: false,
			error: 'Say where this project was submitted before, what you had, and what you changed.'
		};
	}

	/* Annotated rather than inferred, for the reason lib/shop/purchase.ts gives:
	   assigning or returning the transaction without a return type widens every
	   `ok: true` literal to `boolean` and the union stops discriminating. */
	const result = await db.transaction(async (tx): Promise<ShipResult> => {
		/* ── the locks ──────────────────────────────────────────────────────────
       The user's claims first, then this project's row, in that order
       everywhere so two of these can only ever queue and never deadlock.

       Between them they are what makes the rest of this transaction mean
       anything. The claim lock stops the same Hackatime names being taken by
       another of this person's projects while we are checking they are free;
       the project lock stops a second ship of THIS project reading the same
       baseline we are about to read. Without the second one, two requests
       fired together both saw no open review, both inserted a pending
       submission, and both were then approved against a baseline neither had
       moved - ten hours of tracked work minting twenty. */
		await lockClaims(tx, user.id);
		const locked = await lockProject(tx, project.id);
		if (!locked) return { ok: false, error: 'That project does not exist.' };

		/* ── the claim, checked against the account as it stands now ────────── */
		const taken = await claimedElsewhere(user.id, project.id, locked.hackatimeProjects, tx);
		if (taken.length > 0) return { ok: false, error: claimedElsewhereError(taken) };

		/* The hours were counted from the names as they were read before the
		   lock. If they have moved since, the figure in `claimed` is the answer
		   to a question about a different set of projects, and freezing it onto
		   the submission would be recording a claim nobody made. Refused rather
		   than recounted: another network call under a row lock is the thing this
		   transaction most needs not to do. */
		if (locked.hackatimeProjects !== project.hackatimeProjects) {
			return { ok: false, error: 'Your linked Hackatime projects changed. Try shipping again.' };
		}

		/* ── one review open at a time, this time authoritatively ───────────── */
		const latest = await latestSubmission(project.id, tx);
		if (latest && (latest.state === 'pending' || latest.state === 'first_passed')) {
			return { ok: false, error: 'A review is already pending for this project.' };
		}
		if (latest?.state === 'changes_requested') return { ok: false, error: CHANGES_NOT_RESHIP };

		/* ── the floor, against the baseline this transaction can see ───────── */
		const baseline = await lastApproved(project.id, tx);
		if ((baseline?.id ?? null) !== (priorApproval?.id ?? null)) {
			return { ok: false, error: 'This project was just reviewed. Try shipping again.' };
		}
		/* What Phantom will grant at most: the claim past the last approved one.
		   The time since the last ship, `sinceLastShip`, is never more for the
		   same projects - see projects/window.ts. */
		const newWork = claimed - (baseline?.claimedSeconds ?? 0);

		/* An hour in total always, and an hour of new time too unless this
		   follows a rejection - see shipShortfall, which the project page also
		   asks. */
		const afterRejection = latest?.state === 'rejected';
		if (shipShortfall(claimed, sinceLastShip, afterRejection) > 0) {
			const wantsNew = sinceLastShip !== null && !afterRejection;
			const mins = Math.max(0, Math.floor((wantsNew ? (sinceLastShip ?? 0) : claimed) / 60));
			return {
				ok: false,
				error: wantsNew
					? `You need at least 1 hour of new Hackatime time since your last approved ship (you have ${mins}m).`
					: `At least 1 hour of Hackatime time is required (you have ${mins}m).`
			};
		}

		/* A reship is what PHANTOM knows: this project has been approved here
		   before, so there is a baseline and the changelog is the account of what
		   moved past it. `updateDeclaration` is the other kind of update - the one
		   only the owner can know about - and the two are independent. A project
		   can be both, and neither implies the other. */
		const reship = baseline !== null;
		if (reship && !changelog) {
			return { ok: false, error: 'Say what you added since your last ship.' };
		}

		await tx
			.update(projects)
			/* The drafted changelog has gone onto the submission; the next update
			   starts from an empty box. */
			.set({
				aiDeclaration,
				updateDeclaration,
				notesForReviewer,
				changelogDraft: null,
				updatedAt: new Date()
			})
			.where(eq(projects.id, project.id));

		const [submission] = await tx
			.insert(submissions)
			.values({
				projectId: project.id,
				userId: user.id,
				name: project.name,
				description: project.description,
				repoUrl: project.repoUrl,
				demoUrl: project.demoUrl,
				screenshotUrl: project.screenshotUrl,
				hackatimeProjects: project.hackatimeProjects,
				kind: project.kind,
				aiDeclaration,
				updateDeclaration,
				notesForReviewer,
				claimedSeconds: claimed,
				changelog: reship ? changelog : null,
				state: 'pending'
			})
			.returning();

		/* The address is bound to the submission id, which exists only after the
		   insert, so it is sealed and written in a second statement in this same
		   transaction - a submission has no stable pre-insert key to bind on. */
		const shippingEncrypted = encryptJson(
			address.raw,
			bindings.submissionShipping(user.id, submission.id)
		);
		await tx
			.update(submissions)
			.set({ shippingEncrypted })
			.where(eq(submissions.id, submission.id));

		await writeTransition(tx, null, 'pending', user, {
			submissionId: submission.id,
			reason:
				reship || updateDeclaration
					? 'update ship by the participant'
					: 'shipped by the participant',
			metadata: {
				claimedSeconds: claimed,
				newWork,
				...(sinceLastShip !== null ? { sinceLastShip } : {})
			}
		});

		await enqueue(
			{
				effect: 'slack.submission_shipped',
				dedupeKey: `submission:${submission.id}:shipped`,
				payload: { submissionId: submission.id }
			},
			tx
		);
		/* To Ari, where it is reviewed - after the commit, through the outbox,
		   because a network call does not belong in this transaction and a slow
		   Ari must not be able to fail a ship. See lib/server/ari.ts. */
		await enqueue(
			{
				effect: ARI_INGEST_EFFECT,
				dedupeKey: ariIngestDedupeKey(submission.id),
				payload: {
					submissionId: submission.id,
					after: await latestAriShip(project.id, tx),
					origin: await linkOrigin()
				}
			},
			tx
		);

		await recordAudit(
			{
				action: 'submission.shipped',
				actorId: user.id,
				subjectId: user.id,
				metadata: {
					submissionId: submission.id,
					projectId: project.id,
					claimedSeconds: claimed,
					isUpdate: reship,
					declaredUpdate: updateDeclaration !== null
				}
			},
			tx
		);

		return { ok: true, submission: { ...submission, shippingEncrypted } };
	});

	/* Committed, so the Slack notice can go now rather than whenever something
	   next calls the dispatcher. See nudgeOutbox. */
	if (result.ok) nudgeOutbox();
	return result;
}

/* ── change requests ─────────────────────────────────────────────────────── */

export type ReviewResult = { ok: true; submission: Submission } | { ok: false; error: string };

/**
 * The author says the requested changes are made: back to Ari, in the place it
 * had.
 *
 * Not a reship. The submission is the same row and keeps its `createdAt`; on
 * Ari's side, a project sent again after its last ship ended in changes
 * requested keeps that ship's old place in its queue. What it does take is the
 * project as it stands now, since the changes were made to the working copy -
 * all of it: the name, the description, the links, the screenshot, the kind,
 * the Hackatime projects (with the claim counted again from them), the AI
 * declaration, the update declaration and the notes are frozen onto the
 * submission again. A change request can be about any of those, so the
 * author can fix any of them.
 *
 * Change requests are Ari's and have no deadline: the project stays open for
 * editing until it is sent back.
 */
export async function resumeAfterChanges(input: {
	user: SessionUser;
	projectNumber: number;
	note: string | null;
}): Promise<ReviewResult> {
	const { user } = input;
	const note = input.note?.trim() || null;

	const [project] = await db
		.select({
			id: projects.id,
			repoUrl: projects.repoUrl,
			hackatimeProjects: projects.hackatimeProjects
		})
		.from(projects)
		.where(and(eq(projects.number, input.projectNumber), eq(projects.userId, user.id)))
		.limit(1);
	if (!project) return { ok: false, error: 'That project does not exist.' };

	/* The Hackatime projects can change while changes are requested - the
	   whole project is the author's to fix - so the claim is counted again
	   from what is linked now, outside the transaction like a ship counts it.
	   The transaction refuses if the links moved after this count. */
	const names = parseProjectNames(project.hackatimeProjects);
	if (names.length === 0) {
		return { ok: false, error: 'Link at least one Hackatime project first.' };
	}
	let claimed: number | null;
	try {
		claimed = await fetchHackatimeSeconds(user.id, names);
	} catch {
		return {
			ok: false,
			error: 'Could not reach Hackatime to count your hours. Try again in a moment.'
		};
	}
	if (claimed === null) {
		return { ok: false, error: 'Reconnect your Hackatime account - we could not read your hours.' };
	}

	/* The ship's two refusals that need a lookup, made before the transaction
	   for the same reason a ship makes them there. */
	if (!user.slackId) {
		return {
			ok: false,
			error:
				'Link a Slack account to your Hack Club account first - reviewers need it to reach you.'
		};
	}
	if ((await repoVisibility(project.repoUrl)) === 'missing') {
		return {
			ok: false,
			error:
				"Your repository is private or doesn't exist. Make it public on GitHub, then try again."
		};
	}

	const result = await db.transaction(async (tx): Promise<ReviewResult> => {
		/* The ship's lock order: the user's claims, then the project's row. */
		await lockClaims(tx, user.id);
		const locked = await lockProject(tx, project.id);
		if (!locked) return { ok: false, error: 'That project does not exist.' };

		const latest = await latestSubmission(project.id, tx);
		const [row] = latest
			? await tx
					.select()
					.from(submissions)
					.where(eq(submissions.id, latest.id))
					.for('update')
					.limit(1)
			: [];
		if (!row || row.state !== 'changes_requested') {
			return { ok: false, error: 'No changes are waiting on this project.' };
		}

		const [current] = await tx.select().from(projects).where(eq(projects.id, project.id)).limit(1);
		if (!current) return { ok: false, error: 'That project does not exist.' };
		/* The ship's own refusals, since what is frozen here is what a ship
		   would freeze. */
		if (!current.name.trim()) return { ok: false, error: 'Give your project a name.' };
		if (!current.description?.trim()) return { ok: false, error: 'Add a description.' };
		if (!current.repoUrl) return { ok: false, error: 'Add a repository URL.' };
		if (!current.demoUrl) return { ok: false, error: 'Add a demo URL.' };
		if (!current.screenshotUrl) return { ok: false, error: 'Add a screenshot.' };
		if (!isStillImageUrl(current.screenshotUrl)) {
			return { ok: false, error: `${NOT_STILL_IMAGE} Replace it, then send it back.` };
		}
		if (current.repoUrl !== project.repoUrl) {
			return { ok: false, error: 'Your repository changed. Try again.' };
		}

		/* The links the claim was counted from, still - and still free of the
		   author's other projects, checked under the same claims lock a ship
		   takes. */
		if (current.hackatimeProjects !== project.hackatimeProjects) {
			return { ok: false, error: 'Your linked Hackatime projects changed. Try again.' };
		}
		const taken = await claimedElsewhere(user.id, project.id, current.hackatimeProjects, tx);
		if (taken.length > 0) return { ok: false, error: claimedElsewhereError(taken) };
		/* An answer about AI, as a ship asks for. */
		if (!current.aiDeclaration?.trim()) {
			return { ok: false, error: 'Say what you used AI for, or confirm that you did not.' };
		}

		const now = new Date();
		const repoMoved = current.repoUrl !== row.repoUrl;
		const linksMoved = repoMoved || current.demoUrl !== row.demoUrl;

		const [updated] = await tx
			.update(submissions)
			.set({
				state: 'pending',
				stateAt: now,
				changesDueAt: null,
				reviewerId: null,
				approverId: null,
				awardedSeconds: null,
				publicMessage: null,
				justification: null,
				name: current.name,
				description: current.description,
				repoUrl: current.repoUrl,
				demoUrl: current.demoUrl,
				screenshotUrl: current.screenshotUrl,
				kind: current.kind ?? row.kind,
				/* The rest of what the author could fix: the time it claims, and
				   what the reviewer reads beside it. */
				hackatimeProjects: current.hackatimeProjects,
				claimedSeconds: claimed,
				aiDeclaration: current.aiDeclaration,
				updateDeclaration: current.updateDeclaration,
				notesForReviewer: current.notesForReviewer
			})
			.where(and(eq(submissions.id, row.id), eq(submissions.state, 'changes_requested')))
			.returning();
		if (!updated) return { ok: false, error: 'That submission changed. Reload and try again.' };

		await writeTransition(tx, 'changes_requested', 'pending', user, {
			reason: note ?? 'changes marked done',
			submissionId: row.id,
			metadata: { changesDone: true, repoMoved, linksMoved }
		});

		/* Back to Ari as the project's next version. A fresh key per send: the
		   first send's row is spent, and a key that collides with it is a send
		   that never happens. `after` is the Ari ship this one follows, which is
		   how the effect tells "already sent" from "not yet" if it has to retry
		   - see lib/server/ari.ts. */
		await enqueue(
			{
				effect: ARI_INGEST_EFFECT,
				dedupeKey: ariIngestDedupeKey(row.id, now),
				payload: {
					submissionId: row.id,
					after: await latestAriShip(project.id, tx),
					origin: await linkOrigin()
				}
			},
			tx
		);

		await recordAudit(
			{
				action: 'submission.changes_done',
				actorId: user.id,
				subjectId: user.id,
				metadata: { submissionId: row.id, projectId: project.id, repoMoved, linksMoved }
			},
			tx
		);

		return { ok: true, submission: updated };
	});

	if (result.ok) nudgeOutbox();
	return result;
}

/* ── history ─────────────────────────────────────────────────────────────── */

/* A comment moves nothing, so it takes no state's tone. */
const COMMENT_BADGE = { label: 'comment' };

/** Every comment left on a project from the old review desk, oldest first,
 *  as history entries. Reviewer-only: callers decide whether the reader may
 *  see them. */
export async function projectComments(projectId: string): Promise<LogEntry[]> {
	const rows = await db
		.select({
			id: submissionComments.id,
			body: submissionComments.body,
			createdAt: submissionComments.createdAt,
			authorHandle: users.slackUsername,
			authorAvatarUrl: users.avatarUrl
		})
		.from(submissionComments)
		.leftJoin(users, eq(users.id, submissionComments.authorId))
		.where(eq(submissionComments.projectId, projectId))
		.orderBy(submissionComments.createdAt);
	return rows.map((row) => ({
		id: row.id,
		actor: {
			name: row.authorHandle ? `@${row.authorHandle}` : 'phantom',
			avatarUrl: row.authorAvatarUrl
		},
		badge: COMMENT_BADGE,
		kind: 'comment',
		internal: row.body,
		at: row.createdAt
	}));
}

const HOLD_BADGES = {
	'project.fraud_hold': { label: 'fraud hold', tone: 'is-bad' },
	'project.fraud_cleared': { label: 'hold cleared', tone: 'is-good' }
} as const;

/**
 * Every fraud hold placed on or cleared from a project while holds were
 * Phantom's, oldest first, as history entries. Read from the audit trail,
 * which is the only record of when a hold happened and who placed it.
 *
 * Internal, like comments: projectLog only asks for these for a reader who
 * may see the internal side, and a hold is never shown to its author.
 */
export async function projectHoldEvents(projectId: string): Promise<LogEntry[]> {
	const rows = await db
		.select({
			id: auditEvents.id,
			action: auditEvents.action,
			createdAt: auditEvents.createdAt,
			actorHandle: users.slackUsername,
			actorAvatarUrl: users.avatarUrl
		})
		.from(auditEvents)
		.leftJoin(users, eq(users.id, auditEvents.actorId))
		.where(
			and(
				inArray(auditEvents.action, Object.keys(HOLD_BADGES)),
				sql`${auditEvents.metadata}->>'projectId' = ${projectId}`
			)
		)
		.orderBy(auditEvents.createdAt);
	return rows.map((row) => ({
		id: row.id,
		actor: {
			name: row.actorHandle ? `@${row.actorHandle}` : 'phantom',
			avatarUrl: row.actorAvatarUrl
		},
		badge: HOLD_BADGES[row.action as keyof typeof HOLD_BADGES],
		kind: row.action === 'project.fraud_hold' ? 'fraud_hold' : 'fraud_cleared',
		at: row.createdAt
	}));
}

/* ── shared writes ───────────────────────────────────────────────────────── */

export async function lockSubmission(tx: DbHandle, id: string): Promise<Submission | null> {
	if (!isUuid(id)) return null;
	const [owner] = await tx
		.select({ userId: submissions.userId })
		.from(submissions)
		.where(eq(submissions.id, id))
		.limit(1);
	if (!owner) return null;
	await lockClaims(tx, owner.userId);
	const [row] = await tx
		.select()
		.from(submissions)
		.where(eq(submissions.id, id))
		.for('update')
		.limit(1);
	return row ?? null;
}

/**
 * Who made a move: a person here (the participant shipping, or a reviewer Ari
 * named who has an account), or nobody - Ari itself, or a reviewer of Ari's
 * with no Phantom account. Ari's own record of the reviewer rides in the
 * transition's metadata either way.
 */
export type TransitionActor = { id: string; role: UserRole } | null;

export async function writeTransition(
	tx: DbHandle,
	fromState: SubmissionState | null,
	toState: SubmissionState,
	actor: TransitionActor,
	input: {
		submissionId: string;
		reason: string;
		internalNote?: string | null;
		metadata?: JsonObject;
	}
): Promise<void> {
	await tx.insert(submissionTransitions).values({
		submissionId: input.submissionId,
		fromState,
		toState,
		actorId: actor?.id ?? null,
		actorRole: actor?.role ?? null,
		reason: input.reason,
		internalNote: input.internalNote ?? null,
		metadata: input.metadata ?? null
	});
}

/* ── reading ─────────────────────────────────────────────────────────────── */

export async function submissionById(id: string): Promise<Submission | null> {
	if (!isUuid(id)) return null;
	const [row] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
	return row ?? null;
}

export async function submissionsForProject(projectId: string): Promise<Submission[]> {
	return db
		.select()
		.from(submissions)
		.where(eq(submissions.projectId, projectId))
		.orderBy(desc(submissions.createdAt));
}

export async function transitionsForSubmission(submissionId: string) {
	return db
		.select()
		.from(submissionTransitions)
		.where(eq(submissionTransitions.submissionId, submissionId))
		.orderBy(submissionTransitions.createdAt);
}

/* The submission's first-pass reviewer, joined alongside the actor who made
   each move. Two rows from `users` in one query, which is why the alias exists:
   an approval is MOVED by an approver but SPOKEN by the reviewer whose message
   it carries forward, and the author's log names the second of those. */
const reviewerUser = alias(users, 'reviewer_user');

/**
 * Every move every submission of a project has made, oldest first, with who
 * made it and the submission's figures - the material of the history log.
 *
 * The actor's email is deliberately not among the columns. This log is drawn
 * for the AUTHOR as well as for reviewers, and it names every reviewer and
 * administrator who touched the project - so a staff member who had not set a
 * display name had their private address rendered into a participant's page by
 * a fallback that looked like nothing more than a missing-name default. There
 * is no participant-facing reason to know it, so it is not fetched: the page
 * cannot leak a column it was never given.
 */
export async function projectHistory(projectId: string) {
	return db
		.select({
			id: submissionTransitions.id,
			submissionId: submissionTransitions.submissionId,
			fromState: submissionTransitions.fromState,
			toState: submissionTransitions.toState,
			reason: submissionTransitions.reason,
			internalNote: submissionTransitions.internalNote,
			metadata: submissionTransitions.metadata,
			createdAt: submissionTransitions.createdAt,
			actorHandle: users.slackUsername,
			actorAvatarUrl: users.avatarUrl,
			reviewerId: submissions.reviewerId,
			reviewerHandle: reviewerUser.slackUsername,
			reviewerAvatarUrl: reviewerUser.avatarUrl,
			claimedSeconds: submissions.claimedSeconds,
			awardedSeconds: submissions.awardedSeconds,
			changelog: submissions.changelog
		})
		.from(submissionTransitions)
		.innerJoin(submissions, eq(submissions.id, submissionTransitions.submissionId))
		.leftJoin(users, eq(users.id, submissionTransitions.actorId))
		.leftJoin(reviewerUser, eq(reviewerUser.id, submissions.reviewerId))
		.where(eq(submissions.projectId, projectId))
		.orderBy(submissionTransitions.createdAt);
}
