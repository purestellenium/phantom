import { and, asc, eq, inArray, like, lt, or, sql } from 'drizzle-orm';

import {
	AriError,
	ariStatus,
	readAriEvent,
	type AriEvent,
	type AriReview,
	type AriSnapshot,
	isHyperChroma
} from '$lib/server/ari';
import { recordAudit, type DbHandle } from '$lib/server/audit';
import { fetchHackatimeSeconds, HackatimeError } from '$lib/server/auth/hackatime';
import { db } from '$lib/server/db/client';
import {
	ariDeliveries,
	ariShips,
	ledgerEntries,
	outboxEvents,
	projects,
	providerAccounts,
	submissions,
	users,
	type Submission,
	type SubmissionState
} from '$lib/server/db/schema';
import { nudgeOutbox } from '$lib/server/jobs';
import { postEntry, reverseEntry } from '$lib/server/ledger';
import { payoutSeconds } from '$lib/fragments';
import { enqueue, type EffectOutcome } from '$lib/server/outbox';
import { claimedElsewhere, parseProjectNames } from '$lib/server/projects/projects';
import {
	linkOrigin,
	lockProject,
	lockSubmission,
	grantCap,
	writeTransition,
	type TransitionActor
} from '$lib/server/projects/review';
import { refreshShowcase } from '$lib/server/projects/showcase';
import { ariJustification, ariJustificationFields } from '$lib/justification';
import { isUuid } from '$lib/uuid';
import type { JsonObject } from '$lib/json';

/**
 * Applying what Ari decided.
 *
 * Every review decision is made on Ari now, and arrives here as a verified
 * delivery to /api/ari/webhook (see lib/server/ari.ts for the verifying). This
 * module turns each event into the same moves the on-platform review used to
 * make, with the same effects the participant already knows: the hours land
 * in their balance, the DM arrives, the project page and the history say what
 * happened, and an approval is filed to the YSWS base.
 *
 * Three rules hold throughout.
 *
 * - A delivery is applied at most once. Its row in `ari_deliveries` is written
 *   in the same transaction as the move it makes, so a retry (same delivery
 *   id) finds it and stops. A manual resend from Ari is a NEW delivery id, so
 *   that alone is not enough: every move also guards on the state it expects
 *   to leave, and an approval that arrives for a submission already approved
 *   moves nothing.
 *
 * - Ari's approved minutes are the grant, exactly. Phantom's own count is
 *   frozen at the ship, while Ari counts up to the day it reviews, so the two
 *   differ by whatever was logged in between - and Ari's is the decision.
 *
 * - An approval only mints once Ari itself says the ship is decided and
 *   approved. Before minting, Ari's status endpoint is asked; an approval that
 *   arrives while Ari is still deciding the ship is held
 *   (`waiting`) and applied by `ari.reconcile` once Ari says it is done.
 *
 * A delivery that does not fit - a decision for a ship Phantom has no record
 * of, or one that arrives in a state it cannot leave from - is recorded as
 * `ignored` with a reason and answered 200, so Ari does not retry it for hours
 * for nothing, and an operator can read why.
 */

/* ── states ──────────────────────────────────────────────────────────────── */

/** Where a decision can be made from: waiting on Ari, or waiting on the author
 *  after a change request (a reviewer can pick it up again). */
const DECIDABLE: readonly SubmissionState[] = ['pending', 'first_passed', 'changes_requested'];

/** Where Ari can take a decision back from. */
const DECIDED: readonly SubmissionState[] = ['approved', 'rejected', 'changes_requested'];

/** The decision DMs and operator messages, which a taken-back decision makes
 *  untrue. Matched on the submission's dedupe-key prefix. */
const DECISION_EFFECTS = [
	'slack.submission_approved',
	'slack.submission_rejected',
	'slack.dm_approved',
	'slack.dm_rejected',
	'slack.dm_changes_requested',
	'airtable.submission_approved'
];

const RECOUNT_EFFECT = 'ari.recount';

export type Applied = {
	outcome: 'applied' | 'ignored' | 'waiting';
	detail: string | null;
	submissionId: string | null;
};

/* ── finding the submission ──────────────────────────────────────────────── */

/**
 * The submission an event is about: by Ari's ship id first - a submission sent
 * back after changes has more than one - and otherwise by `external_id`, the
 * project's id, taking its latest submission. The second covers a decision
 * that beats the ingest effect to recording Ari's id, which Ari's automatic
 * rejections can.
 */
async function findSubmission(event: AriEvent, handle: DbHandle): Promise<string | null> {
	const [mapped] = await handle
		.select({ submissionId: ariShips.submissionId })
		.from(ariShips)
		.where(eq(ariShips.ariId, event.id))
		.limit(1);
	if (mapped) return mapped.submissionId;
	if (!isUuid(event.externalId)) return null;
	const [latest] = await handle
		.select({ id: submissions.id })
		.from(submissions)
		.where(eq(submissions.projectId, event.externalId))
		.orderBy(sql`${submissions.createdAt} desc`)
		.limit(1);
	return latest?.id ?? null;
}

/** The reviewer as a Phantom account, matched by Slack id, with their Slack
 *  handle. Null for Ari's own automatic decisions and for a reviewer with no
 *  account here. */
async function reviewerAccount(
	review: AriReview | null,
	handle: DbHandle
): Promise<{ actor: TransitionActor; name: string | null }> {
	const slackId = review?.reviewer?.slackId;
	if (!slackId) return { actor: null, name: null };
	const [row] = await handle
		.select({ id: users.id, role: users.role, handle: users.slackUsername })
		.from(users)
		.where(eq(users.slackId, slackId))
		.limit(1);
	return row
		? { actor: { id: row.id, role: row.role }, name: row.handle }
		: { actor: null, name: null };
}

function isAutomatic(review: AriReview | null): boolean {
	return review?.reviewer?.email === 'system@ari';
}

/** What a transition's metadata records about who decided, on Ari. Slack id
 *  only - the transition is drawn to the author too, and a reviewer's email
 *  has no business on their page. */
function ariMeta(event: AriEvent, deliveryId: string): JsonObject {
	return {
		ari: {
			id: event.id,
			deliveryId,
			reviewerSlackId: event.review?.reviewer?.slackId ?? null,
			automatic: isAutomatic(event.review)
		}
	};
}

/* ── the snapshot ────────────────────────────────────────────────────────── */

/**
 * Take a reviewer's corrections onto the submission.
 *
 * Every review delivery carries Ari's current snapshot of the ship, and
 * `ship.updated` carries it the moment a reviewer edits it - so whichever
 * arrives first, the submission ends up as Ari has it, and the explore page
 * and the YSWS record show the corrected project. The project's working copy
 * is the owner's and keeps their own words; two things are written to it as
 * well, because they are facts about the project rather than wording: its
 * kind, and its Hackatime projects (which also have to match for the owner to
 * send it back after changes).
 *
 * A Hackatime correction re-counts the claim (`ari.recount`) rather than
 * trusting the old figure, and is refused - and said so - when a name is
 * already claimed by another of the owner's projects, which would count the
 * same tracked time twice.
 */
async function applySnapshot(
	tx: DbHandle,
	submission: Submission,
	snapshot: AriSnapshot | null
): Promise<{ changed: string[]; refused: string | null }> {
	if (!snapshot) return { changed: [], refused: null };
	const set: Partial<typeof submissions.$inferInsert> = {};
	const changed: string[] = [];
	let refused: string | null = null;

	if (snapshot.title !== undefined && snapshot.title !== submission.name) {
		set.name = snapshot.title;
		changed.push('title');
	}
	if (
		snapshot.description !== undefined &&
		snapshot.description !== (submission.description ?? '')
	) {
		set.description = snapshot.description;
		changed.push('description');
	}
	if (snapshot.thumbnailUrl && snapshot.thumbnailUrl !== submission.screenshotUrl) {
		set.screenshotUrl = snapshot.thumbnailUrl;
		changed.push('thumbnail_url');
	}
	if (snapshot.repoUrl && snapshot.repoUrl !== submission.repoUrl) {
		set.repoUrl = snapshot.repoUrl;
		changed.push('repo_url');
	}
	if (snapshot.demoUrl !== undefined && snapshot.demoUrl !== submission.demoUrl) {
		set.demoUrl = snapshot.demoUrl;
		changed.push('demo_url');
	}
	if (snapshot.track && snapshot.track !== submission.kind) {
		set.kind = snapshot.track;
		changed.push('track');
	}

	let recount = false;
	if (snapshot.hackatimeProjects && snapshot.hackatimeProjects.length > 0) {
		const before = parseProjectNames(submission.hackatimeProjects).sort().join(',');
		const after = [...new Set(snapshot.hackatimeProjects)].sort();
		if (after.join(',') !== before) {
			const list = after.join(', ');
			const taken = await claimedElsewhere(submission.userId, submission.projectId, list, tx);
			if (taken.length > 0) {
				refused = `Hackatime correction not applied: ${taken.join(', ')} already counted for another of the owner's projects`;
			} else {
				set.hackatimeProjects = list;
				changed.push('hackatime_projects');
				recount = true;
			}
		}
	}

	if (changed.length === 0) return { changed, refused };

	await tx.update(submissions).set(set).where(eq(submissions.id, submission.id));
	const projectSet: Partial<typeof projects.$inferInsert> = {};
	if (set.kind) projectSet.kind = set.kind;
	if (set.hackatimeProjects) projectSet.hackatimeProjects = set.hackatimeProjects;
	if (Object.keys(projectSet).length > 0) {
		await tx
			.update(projects)
			.set({ ...projectSet, updatedAt: new Date() })
			.where(eq(projects.id, submission.projectId));
	}
	if (recount) {
		await enqueue(
			{
				effect: RECOUNT_EFFECT,
				dedupeKey: `submission:${submission.id}:recount:${Date.now()}`,
				payload: { submissionId: submission.id }
			},
			tx
		);
	}
	if (submission.state === 'approved') await refreshShowcase(submission.projectId, tx);

	await recordAudit(
		{
			action: 'submission.corrected_on_ari',
			actorId: null,
			subjectId: submission.userId,
			metadata: { submissionId: submission.id, fields: changed }
		},
		tx
	);
	return { changed, refused };
}

/* ── the ledger ──────────────────────────────────────────────────────────── */

const awardPrefix = (submissionId: string) => `submission:${submissionId}:award`;

/** The award entries a submission has had, oldest first, each with whether it
 *  has been reversed. More than one only when Ari requeued an approval and
 *  approved it again. */
async function awardsFor(tx: DbHandle, submissionId: string) {
	const prefix = awardPrefix(submissionId);
	const rows = await tx
		.select()
		.from(ledgerEntries)
		.where(
			and(
				eq(ledgerEntries.entryType, 'submission_award'),
				or(
					eq(ledgerEntries.idempotencyKey, prefix),
					like(ledgerEntries.idempotencyKey, `${prefix}:%`)
				)
			)
		)
		.orderBy(asc(ledgerEntries.createdAt));
	if (rows.length === 0) return [];
	const reversals = await tx
		.select({ reverses: ledgerEntries.reversesEntryId })
		.from(ledgerEntries)
		.where(
			inArray(
				ledgerEntries.reversesEntryId,
				rows.map((row) => row.id)
			)
		);
	const reversed = new Set(reversals.map((row) => row.reverses));
	return rows.map((entry) => ({ entry, reversed: reversed.has(entry.id) }));
}

/** Take back a submission's standing award, if it has one. Returns the seconds
 *  taken back. */
async function reverseAward(
	tx: DbHandle,
	submission: Submission,
	reason: string,
	actorId: string | null
): Promise<number> {
	const standing = (await awardsFor(tx, submission.id)).filter((award) => !award.reversed);
	let total = 0;
	for (const { entry } of standing) {
		await reverseEntry(
			{
				userId: submission.userId,
				original: entry,
				reason: `${reason}: ${submission.name}`,
				actorId,
				metadata: { submissionId: submission.id, projectId: submission.projectId }
			},
			tx
		);
		total += entry.amount;
	}
	return total;
}

/**
 * Stop the messages a taken-back decision makes untrue, if they have not gone
 * out. Returns which of them had already gone out, so the caller can tell the
 * author the decision changed - and the Airtable record, if one was filed,
 * stands and is corrected by hand.
 */
async function cancelDecisionEffects(
	tx: DbHandle,
	submissionId: string
): Promise<{ deliveredDm: boolean; filed: boolean }> {
	const prefix = `submission:${submissionId}:`;
	const rows = await tx
		.select({ id: outboxEvents.id, effect: outboxEvents.effect, status: outboxEvents.status })
		.from(outboxEvents)
		.where(
			and(
				inArray(outboxEvents.effect, DECISION_EFFECTS),
				like(outboxEvents.dedupeKey, `${prefix}%`)
			)
		);
	const unsent = rows
		.filter((row) => row.status === 'pending' || row.status === 'retryable')
		.map((row) => row.id);
	if (unsent.length > 0) {
		await tx
			.update(outboxEvents)
			.set({
				status: 'skipped',
				lastError: 'the decision was taken back on Ari before this went out',
				leasedUntil: null,
				updatedAt: new Date()
			})
			.where(inArray(outboxEvents.id, unsent));
	}
	const delivered = rows.filter((row) => row.status === 'delivered' || row.status === 'ambiguous');
	return {
		deliveredDm: delivered.some((row) => row.effect.startsWith('slack.dm_')),
		filed: delivered.some((row) => row.effect === 'airtable.submission_approved')
	};
}

/* ── the moves ───────────────────────────────────────────────────────────── */

type MoveInput = {
	tx: DbHandle;
	submission: Submission;
	event: AriEvent;
	deliveryId: string;
	origin: string | null;
};

async function approve(input: MoveInput): Promise<Applied> {
	const { tx, event, deliveryId, origin } = input;
	let submission = input.submission;
	if (!DECIDABLE.includes(submission.state)) {
		return ignored(submission, `approval for a submission that is ${submission.state}`);
	}
	if (!(await lockProject(tx, submission.projectId))) {
		return ignored(submission, 'the project no longer exists');
	}
	const snapshot = await applySnapshot(tx, submission, event.ship);
	if (snapshot.changed.length > 0)
		submission = (await lockSubmission(tx, submission.id)) ?? submission;

	/* The same Hackatime project counted for another of the owner's projects
	   would pay the same tracked time twice - the old desk refused to approve
	   it, and nothing from Ari is allowed to mint it either. Left undecided
	   here, for a person: Ari has approved something Phantom cannot pay. */
	const taken = await claimedElsewhere(
		submission.userId,
		submission.projectId,
		submission.hackatimeProjects,
		tx
	);
	if (taken.length > 0) {
		return ignored(
			submission,
			`approved on Ari, not paid: ${taken.join(', ')} already counted for another of the owner's projects`
		);
	}

	const review = event.review;
	const ariSeconds = Math.max(0, Math.round((review?.approvedMinutes ?? 0) * 60));
	/* The grant is Ari's figure, as decided. What Phantom itself counted is
	   kept beside it on the record, for reading - not to cut Ari's. */
	const newWork = await grantCap(submission, tx);
	const award = ariSeconds;

	const { actor, name } = await reviewerAccount(review, tx);
	const priorApprovals = await tx
		.select({ awarded: submissions.awardedSeconds })
		.from(submissions)
		.where(
			and(
				eq(submissions.projectId, submission.projectId),
				inArray(submissions.state, ['approved', 'revoked']),
				lt(submissions.createdAt, submission.createdAt)
			)
		)
		.orderBy(asc(submissions.createdAt));
	const credit = isAutomatic(review)
		? 'Decided automatically by Ari'
		: `Reviewed on Ari by @${name ?? review?.reviewer?.slackId ?? 'an Ari reviewer'}`;
	const [hackatime] = await tx
		.select({ accountId: providerAccounts.providerAccountId })
		.from(providerAccounts)
		.where(
			and(
				eq(providerAccounts.userId, submission.userId),
				eq(providerAccounts.provider, 'hackatime')
			)
		)
		.limit(1);
	const breakdown: Record<string, number> = {};
	for (const [key, value] of Object.entries(review?.breakdown ?? {})) {
		if (typeof value === 'number') breakdown[key] = value;
	}
	const justificationInput = {
		awardedSeconds: award,
		ariSeconds,
		newWork,
		priorApprovals: priorApprovals.map((row) => row.awarded ?? 0),
		changelog: submission.changelog,
		updateDeclaration: submission.updateDeclaration,
		parts: review?.justification ?? {},
		auditNote: review?.auditNote ?? null,
		checks: review?.fields ?? [],
		breakdown,
		hackatimeAccountId: hackatime?.accountId ?? null,
		credit
	};
	const justification = ariJustification(justificationInput);
	/* The base's own justification fields, fixed at the decision like the rest
	   of the approval, for the Airtable effect to file - see
	   effects/airtable.ts. */
	const justificationFields = ariJustificationFields(justificationInput);

	/* Hyper-chroma: a ticked box marks the ship; an unticked one leaves a mark
	   it already has alone. Its owner may already have been told it is
	   hyper-chroma, and bonuses promised for it, so taking the mark off is a
	   person's decision on Phantom - never the side effect of a re-approval
	   that forgot the box. A mark already there keeps when it was made and
	   by whom. See projects/hyper-chroma.ts. */
	const ticked = isHyperChroma(review);
	const hyperChroma = ticked || submission.hyperChroma;

	const now = new Date();
	const [updated] = await tx
		.update(submissions)
		.set({
			state: 'approved',
			stateAt: now,
			changesDueAt: null,
			reviewerId: actor?.id ?? null,
			approverId: actor?.id ?? null,
			awardedSeconds: award,
			publicMessage: review?.noteToMaker ?? null,
			justification,
			...(ticked && !submission.hyperChroma
				? { hyperChroma: true, hyperChromaAt: now, hyperChromaById: actor?.id ?? null }
				: {})
		})
		.where(and(eq(submissions.id, submission.id), inArray(submissions.state, [...DECIDABLE])))
		.returning();
	if (!updated) return ignored(submission, 'the submission changed while this was applied');

	/* The mint. One award per approval, keyed on the submission - the first
	   with the key every approval before Ari used, and a numbered one after a
	   requeue took an earlier one back. The submission keeps Ari's exact
	   minutes (`awardedSeconds`, which the YSWS base files); what is credited
	   is that rounded down to a whole fragment - see $lib/fragments. Under a fragment
	   mints nothing: the ledger refuses a zero entry, and there is nothing to
	   record. */
	const payout = payoutSeconds(award);
	if (payout > 0) {
		const earlier = await awardsFor(tx, submission.id);
		const key =
			earlier.length === 0
				? awardPrefix(submission.id)
				: `${awardPrefix(submission.id)}:${earlier.length + 1}`;
		await postEntry(
			{
				userId: submission.userId,
				amount: payout,
				entryType: 'submission_award',
				reason: submission.name,
				idempotencyKey: key,
				actorId: actor?.id ?? null,
				metadata: {
					submissionId: submission.id,
					projectId: submission.projectId,
					claimedSeconds: submission.claimedSeconds,
					awardedSeconds: award,
					creditedSeconds: payout,
					ariSeconds,
					ariId: event.id
				}
			},
			tx
		);
	}

	await writeTransition(tx, submission.state, 'approved', actor, {
		submissionId: submission.id,
		reason: review?.noteToMaker ?? 'approved',
		internalNote: review?.auditNote ?? null,
		metadata: {
			awardedSeconds: award,
			ariSeconds,
			newWork,
			justificationFields,
			...ariMeta(event, deliveryId)
		}
	});

	await refreshShowcase(submission.projectId, tx);

	const key = `submission:${submission.id}`;
	await enqueue(
		{
			effect: 'slack.submission_approved',
			dedupeKey: `${key}:approved:${deliveryId}`,
			payload: { submissionId: submission.id, origin }
		},
		tx
	);
	/* The DM reads hyper-chroma off the submission when it is sent, so a mark
	   taken off by hand before then is not announced. */
	await enqueue(
		{
			effect: 'slack.dm_approved',
			dedupeKey: `${key}:dm:approved:${deliveryId}`,
			payload: { submissionId: submission.id, origin }
		},
		tx
	);
	/* Filed to the YSWS base only when hours were granted - a zero-hour
	   approval has nothing to file. */
	if (award > 0) {
		await enqueue(
			{
				effect: 'airtable.submission_approved',
				dedupeKey: `${key}:airtable:${deliveryId}`,
				payload: { submissionId: submission.id }
			},
			tx
		);
	}

	await recordAudit(
		{
			action: 'submission.approved',
			actorId: actor?.id ?? null,
			subjectId: submission.userId,
			metadata: {
				submissionId: submission.id,
				awardedSeconds: award,
				ariSeconds,
				ariId: event.id,
				hyperChroma
			}
		},
		tx
	);

	return applied(submission, snapshot.refused);
}

async function reject(input: MoveInput): Promise<Applied> {
	const { tx, event, deliveryId, origin } = input;
	const { submission } = input;
	if (!DECIDABLE.includes(submission.state)) {
		return ignored(submission, `rejection for a submission that is ${submission.state}`);
	}
	const snapshot = await applySnapshot(tx, submission, event.ship);
	const review = event.review;
	const { actor } = await reviewerAccount(review, tx);

	const [updated] = await tx
		.update(submissions)
		.set({
			state: 'rejected',
			stateAt: new Date(),
			changesDueAt: null,
			reviewerId: actor?.id ?? null,
			awardedSeconds: null,
			publicMessage: review?.noteToMaker ?? null,
			justification: review?.auditNote ?? null
		})
		.where(and(eq(submissions.id, submission.id), inArray(submissions.state, [...DECIDABLE])))
		.returning({ id: submissions.id });
	if (!updated) return ignored(submission, 'the submission changed while this was applied');

	await writeTransition(tx, submission.state, 'rejected', actor, {
		submissionId: submission.id,
		reason: review?.noteToMaker ?? 'rejected',
		internalNote: review?.auditNote ?? null,
		metadata: ariMeta(event, deliveryId)
	});

	const key = `submission:${submission.id}`;
	await enqueue(
		{
			effect: 'slack.submission_rejected',
			dedupeKey: `${key}:rejected:${deliveryId}`,
			payload: { submissionId: submission.id, origin }
		},
		tx
	);
	await enqueue(
		{
			effect: 'slack.dm_rejected',
			dedupeKey: `${key}:dm:rejected:${deliveryId}`,
			payload: { submissionId: submission.id, origin }
		},
		tx
	);

	await recordAudit(
		{
			action: 'submission.rejected',
			actorId: actor?.id ?? null,
			subjectId: submission.userId,
			metadata: { submissionId: submission.id, ariId: event.id, automatic: isAutomatic(review) }
		},
		tx
	);
	return applied(submission, snapshot.refused);
}

/**
 * A reviewer asked for changes. The project opens for editing, the author is
 * told what to change, and "changes are done" sends it back to Ari - which
 * keeps its old place in Ari's queue. No deadline: change requests are Ari's.
 */
async function requestChanges(input: MoveInput): Promise<Applied> {
	const { tx, event, deliveryId, origin } = input;
	const { submission } = input;
	if (submission.state !== 'pending' && submission.state !== 'first_passed') {
		return ignored(submission, `change request for a submission that is ${submission.state}`);
	}
	const snapshot = await applySnapshot(tx, submission, event.ship);
	const review = event.review;
	const { actor } = await reviewerAccount(review, tx);

	const [updated] = await tx
		.update(submissions)
		.set({
			state: 'changes_requested',
			stateAt: new Date(),
			changesDueAt: null,
			reviewerId: actor?.id ?? null,
			awardedSeconds: null,
			publicMessage: review?.noteToMaker ?? null,
			justification: review?.auditNote ?? null
		})
		.where(
			and(
				eq(submissions.id, submission.id),
				inArray(submissions.state, ['pending', 'first_passed'])
			)
		)
		.returning({ id: submissions.id });
	if (!updated) return ignored(submission, 'the submission changed while this was applied');

	await writeTransition(tx, submission.state, 'changes_requested', actor, {
		submissionId: submission.id,
		reason: review?.noteToMaker ?? 'changes requested',
		internalNote: review?.auditNote ?? null,
		metadata: ariMeta(event, deliveryId)
	});

	await enqueue(
		{
			effect: 'slack.dm_changes_requested',
			dedupeKey: `submission:${submission.id}:dm:changes:${deliveryId}`,
			payload: { submissionId: submission.id, origin }
		},
		tx
	);

	await recordAudit(
		{
			action: 'submission.changes_requested',
			actorId: actor?.id ?? null,
			subjectId: submission.userId,
			metadata: { submissionId: submission.id, ariId: event.id, automatic: isAutomatic(review) }
		},
		tx
	);
	return applied(submission, snapshot.refused);
}

/**
 * Ari took a decision back. Both kinds undo what the decision did - Ari's own
 * instruction - so an approval's hours come back off the balance (and stay
 * shippable: neither state is a baseline), unsent messages about it are
 * stopped, and explore stops showing a project with nothing approved.
 *
 * `review.requeued` puts the ship back on Ari's queue: `pending` again, in
 * review. `review.reverted` leaves it closed: `reverted`, and the project can
 * be shipped again.
 */
async function takeBack(input: MoveInput, to: 'pending' | 'reverted'): Promise<Applied> {
	const { tx, event, deliveryId, origin } = input;
	const { submission } = input;
	const from = submission.state;
	const allowed: readonly SubmissionState[] =
		to === 'pending' ? DECIDED : [...DECIDED, 'pending', 'first_passed'];
	if (!allowed.includes(from)) {
		return ignored(submission, `${event.event} for a submission that is ${from}`);
	}
	if (!(await lockProject(tx, submission.projectId))) {
		return ignored(submission, 'the project no longer exists');
	}
	const { actor } = await reviewerAccount(event.review, tx);

	const reversedSeconds =
		from === 'approved'
			? await reverseAward(
					tx,
					submission,
					to === 'pending' ? 'Back in review' : 'Approval taken back',
					actor?.id ?? null
				)
			: 0;
	const { deliveredDm, filed } = await cancelDecisionEffects(tx, submission.id);

	const [updated] = await tx
		.update(submissions)
		.set({
			state: to,
			stateAt: new Date(),
			changesDueAt: null,
			...(to === 'pending'
				? {
						reviewerId: null,
						approverId: null,
						awardedSeconds: null,
						justification: null
						/* Not the hyper-chroma mark: it stops counting while the
						   ship is back in review, and counts again when it is
						   approved, whatever that approval's checkbox says - see
						   `approve`. */
					}
				: {}),
			publicMessage: event.review?.noteToMaker ?? null
		})
		.where(and(eq(submissions.id, submission.id), eq(submissions.state, from)))
		.returning({ id: submissions.id });
	if (!updated) return ignored(submission, 'the submission changed while this was applied');

	await writeTransition(tx, from, to, actor, {
		submissionId: submission.id,
		reason:
			event.review?.noteToMaker ??
			(to === 'pending' ? 'back in review for a fresh look' : 'decision taken back'),
		internalNote: event.review?.auditNote ?? null,
		metadata: { reversedSeconds, ...ariMeta(event, deliveryId) }
	});

	if (from === 'approved') await refreshShowcase(submission.projectId, tx);

	/* The author hears about it when they had heard about the decision, or
	   when hours left their balance. A decision taken back before its DM went
	   out was never news to them. */
	if (deliveredDm || reversedSeconds > 0) {
		await enqueue(
			{
				effect: to === 'pending' ? 'slack.dm_requeued' : 'slack.dm_reverted',
				dedupeKey: `submission:${submission.id}:dm:${to}:${deliveryId}`,
				payload: { submissionId: submission.id, origin, reversedSeconds }
			},
			tx
		);
	}

	await recordAudit(
		{
			action: to === 'pending' ? 'submission.requeued' : 'submission.reverted',
			actorId: actor?.id ?? null,
			subjectId: submission.userId,
			metadata: {
				submissionId: submission.id,
				from,
				reversedSeconds,
				ariId: event.id,
				/* Filed to the YSWS base before it was taken back: that record
				   stands, and is corrected by hand. */
				airtableRecordStands: filed
			}
		},
		tx
	);
	return applied(
		submission,
		filed ? 'its YSWS (Airtable) record was already filed and needs correcting by hand' : null
	);
}

async function correct(input: MoveInput): Promise<Applied> {
	const { changed, refused } = await applySnapshot(input.tx, input.submission, input.event.ship);
	return applied(
		input.submission,
		[changed.length > 0 ? `corrected ${changed.join(', ')}` : 'nothing to change', refused]
			.filter(Boolean)
			.join('; ')
	);
}

function applied(submission: Submission, detail: string | null): Applied {
	return { outcome: 'applied', detail, submissionId: submission.id };
}
function ignored(submission: Submission | null, detail: string): Applied {
	return { outcome: 'ignored', detail, submissionId: submission?.id ?? null };
}

/* ── one delivery ────────────────────────────────────────────────────────── */

/**
 * Whether an approval may mint now, by Ari's own account of the ship.
 *
 * `review.approved` is what Phantom acts on, but the docs do not say whether
 * Ari sends it at a reviewer's decision or once the decision is final.
 * Asking settles it either way: `reviewed` and `approved` mints; a ship
 * anywhere before a final decision waits; anything else - Ari
 * has since taken it back - is not an approval any more.
 */
async function approvalStands(ariId: string): Promise<'yes' | 'wait' | 'no'> {
	const status = await ariStatus({ id: ariId });
	if (!status) return 'no';
	if (status.phase === 'reviewed') return status.decision === 'approved' ? 'yes' : 'no';
	if (
		['processing', 'fraud_review', 'review', 'under_review', 'second_pass'].includes(status.phase)
	) {
		return 'wait';
	}
	return 'no';
}

/**
 * Apply one verified delivery, once.
 *
 * Returns `duplicate` for a delivery id already recorded. Throws when Phantom
 * could not decide what to do - the database, or Ari's status endpoint, out of
 * reach - so the webhook answers 5xx and Ari tries again later.
 */
export async function applyDelivery(
	deliveryId: string,
	body: JsonObject
): Promise<'duplicate' | Applied> {
	const [seen] = await db
		.select({ outcome: ariDeliveries.outcome })
		.from(ariDeliveries)
		.where(eq(ariDeliveries.deliveryId, deliveryId))
		.limit(1);
	if (seen) return 'duplicate';

	const event = readAriEvent(body);
	/* An approval is checked against Ari before anything is locked: it is a
	   network call, and it decides whether this is an approval yet. */
	let gate: 'yes' | 'wait' | 'no' = 'yes';
	if (event?.event === 'review.approved') gate = await approvalStands(event.id);
	const origin = await linkOrigin();

	const result = await db.transaction(async (tx): Promise<'duplicate' | Applied> => {
		const [claimed] = await tx
			.insert(ariDeliveries)
			.values({
				deliveryId,
				event: event?.event ?? 'unreadable',
				ariId: event?.id ?? null,
				externalId: event?.externalId ?? null,
				outcome: 'applied',
				body
			})
			.onConflictDoNothing()
			.returning({ deliveryId: ariDeliveries.deliveryId });
		if (!claimed) return 'duplicate';

		const outcome = await decide(tx, event, deliveryId, gate, origin);
		await tx
			.update(ariDeliveries)
			.set({
				outcome: outcome.outcome,
				detail: outcome.detail,
				submissionId: outcome.submissionId,
				updatedAt: new Date()
			})
			.where(eq(ariDeliveries.deliveryId, deliveryId));
		return outcome;
	});

	if (result !== 'duplicate' && result.outcome === 'applied') nudgeOutbox();
	return result;
}

async function decide(
	tx: DbHandle,
	event: AriEvent | null,
	deliveryId: string,
	gate: 'yes' | 'wait' | 'no',
	origin: string | null
): Promise<Applied> {
	if (!event) return ignored(null, 'the delivery has no event, ship id or external id');
	const submissionId = await findSubmission(event, tx);
	const submission = submissionId ? await lockSubmission(tx, submissionId) : null;
	if (!submission) return ignored(null, `no submission for Ari ship ${event.id}`);

	/* A decision for the version of a ship Phantom sent before the latest one
	   - its change request was answered since - is about something that no
	   longer exists. */
	const latestAri = await tx
		.select({ ariId: ariShips.ariId })
		.from(ariShips)
		.where(eq(ariShips.submissionId, submission.id))
		.orderBy(sql`${ariShips.createdAt} desc`)
		.limit(1);
	if (
		event.event.startsWith('review.') &&
		latestAri[0] &&
		latestAri[0].ariId !== event.id &&
		(await tx.select().from(ariShips).where(eq(ariShips.ariId, event.id)).limit(1)).length > 0
	) {
		return ignored(submission, `${event.event} for ${event.id}, an earlier version of this ship`);
	}

	const input: MoveInput = { tx, submission, event, deliveryId, origin };
	switch (event.event) {
		case 'review.approved':
			if (gate === 'wait') {
				return {
					outcome: 'waiting',
					detail: 'Ari has not finished deciding it; ari.reconcile applies it once it has',
					submissionId: submission.id
				};
			}
			if (gate === 'no') return ignored(submission, 'Ari no longer reports this ship as approved');
			return approve(input);
		case 'review.rejected':
			return reject(input);
		case 'review.changes':
			return requestChanges(input);
		case 'review.requeued':
			return takeBack(input, 'pending');
		case 'review.reverted':
			return takeBack(input, 'reverted');
		case 'ship.updated':
			return correct(input);
		case 'review.fraud':
			return ignored(
				submission,
				'review.fraud is only sent in relay mode, which Phantom does not use'
			);
		default:
			return ignored(submission, `unknown event ${event.event}`);
	}
}

/**
 * Apply an approval that was held because Ari had not finished deciding it,
 * now that it may have. For `ari.reconcile`. Returns what became of it.
 */
export async function applyWaiting(deliveryId: string): Promise<Applied['outcome'] | 'gone'> {
	const [row] = await db
		.select()
		.from(ariDeliveries)
		.where(and(eq(ariDeliveries.deliveryId, deliveryId), eq(ariDeliveries.outcome, 'waiting')))
		.limit(1);
	if (!row) return 'gone';
	const event = readAriEvent(row.body);
	if (!event) return 'gone';
	const gate = await approvalStands(event.id);
	if (gate === 'wait') return 'waiting';

	const result = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ outcome: ariDeliveries.outcome })
			.from(ariDeliveries)
			.where(eq(ariDeliveries.deliveryId, deliveryId))
			.for('update')
			.limit(1);
		if (locked?.outcome !== 'waiting') return null;
		const outcome = await decide(tx, event, deliveryId, gate, null);
		await tx
			.update(ariDeliveries)
			.set({
				outcome: outcome.outcome,
				detail: outcome.detail,
				submissionId: outcome.submissionId,
				updatedAt: new Date()
			})
			.where(eq(ariDeliveries.deliveryId, deliveryId));
		return outcome;
	});
	if (!result) return 'gone';
	if (result.outcome === 'applied') nudgeOutbox();
	return result.outcome;
}

/**
 * Apply again a delivery that did not apply - from the console's Ari page,
 * once whatever stopped it is fixed. Ari resends with the same delivery id,
 * which Phantom has already recorded and so would only call a duplicate;
 * this runs the stored delivery through the same decision instead.
 *
 * Only an `ignored` delivery, and only once at a time (the row lock). An
 * approval still asks Ari whether it stands, exactly as it did the first
 * time: still deciding holds it (`waiting`), taken back ignores it again with
 * the reason, and Ari not answering is a refusal to retry rather than a
 * second skip.
 */
export type RetryResult =
	{ ok: true; outcome: Applied['outcome']; detail: string | null } | { ok: false; error: string };

export async function retryDelivery(deliveryId: string, actorId: string): Promise<RetryResult> {
	const [row] = await db
		.select()
		.from(ariDeliveries)
		.where(and(eq(ariDeliveries.deliveryId, deliveryId), eq(ariDeliveries.outcome, 'ignored')))
		.limit(1);
	if (!row) return { ok: false, error: 'That delivery is not waiting to be retried.' };
	const event = readAriEvent(row.body);
	if (!event) return { ok: false, error: 'That delivery has no event Phantom can read.' };

	let gate: 'yes' | 'wait' | 'no' = 'yes';
	if (event.event === 'review.approved') {
		try {
			gate = await approvalStands(event.id);
		} catch (error) {
			if (error instanceof AriError) {
				return {
					ok: false,
					error: `Ari did not answer, so nothing was retried: ${error.message}`
				};
			}
			throw error;
		}
	}

	const result = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ outcome: ariDeliveries.outcome })
			.from(ariDeliveries)
			.where(eq(ariDeliveries.deliveryId, deliveryId))
			.for('update')
			.limit(1);
		if (locked?.outcome !== 'ignored') return null;
		const outcome = await decide(tx, event, deliveryId, gate, await linkOrigin());
		await tx
			.update(ariDeliveries)
			.set({
				outcome: outcome.outcome,
				detail: outcome.detail,
				submissionId: outcome.submissionId,
				updatedAt: new Date()
			})
			.where(eq(ariDeliveries.deliveryId, deliveryId));
		await recordAudit(
			{
				action: 'ari.delivery_retried',
				actorId,
				metadata: { deliveryId, event: event.event, outcome: outcome.outcome }
			},
			tx
		);
		return outcome;
	});
	if (!result) return { ok: false, error: 'That delivery changed while it was being retried.' };
	if (result.outcome === 'applied') nudgeOutbox();
	return { ok: true, outcome: result.outcome, detail: result.detail };
}

/* ── the recount ─────────────────────────────────────────────────────────── */

/**
 * Count a submission's claim again after a reviewer corrected its Hackatime
 * projects on Ari: the `ari.recount` outbox effect. The claim is what caps the
 * grant, so it has to be about the projects Ari is counting. Only while the
 * submission is still undecided - once decided, the claim is history.
 */
export async function recountClaim(payload: JsonObject | null): Promise<EffectOutcome> {
	const submissionId =
		payload && typeof payload.submissionId === 'string' ? payload.submissionId : null;
	if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };
	const [row] = await db
		.select()
		.from(submissions)
		.where(eq(submissions.id, submissionId))
		.limit(1);
	if (!row) return { status: 'skipped', error: 'that submission no longer exists' };
	if (!DECIDABLE.includes(row.state)) {
		return { status: 'skipped', error: `the submission is ${row.state}` };
	}

	let claimed: number | null;
	try {
		claimed = await fetchHackatimeSeconds(
			row.userId,
			parseProjectNames(row.hackatimeProjects)
		);
	} catch (error) {
		if (error instanceof HackatimeError) return { status: 'retryable', error: error.message };
		throw error;
	}
	if (claimed === null) {
		return { status: 'failed', error: "the owner's Hackatime account could not be read" };
	}

	const [updated] = await db
		.update(submissions)
		.set({ claimedSeconds: claimed })
		.where(
			and(
				eq(submissions.id, submissionId),
				eq(submissions.hackatimeProjects, row.hackatimeProjects ?? ''),
				inArray(submissions.state, [...DECIDABLE])
			)
		)
		.returning({ id: submissions.id });
	if (!updated) return { status: 'skipped', error: 'the submission moved on before the recount' };
	await recordAudit({
		action: 'submission.claim_recounted',
		actorId: null,
		subjectId: row.userId,
		metadata: { submissionId, from: row.claimedSeconds, to: claimed }
	});
	return { status: 'delivered' };
}
