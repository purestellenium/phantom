import type { LogEntry } from '$lib/log';
import type { Submission } from '$lib/server/db/schema';
import {
	newWorkFrom,
	projectComments,
	projectHistory,
	projectHoldEvents
} from '$lib/server/projects/review';
import { payoutSeconds } from '$lib/fragments';
import { hours } from '$lib/status';

/* The badge on a history entry: the move, in the reviewer's words. */
const LOG_STATE = {
	pending: { label: 'submitted', tone: 'is-good' },
	first_passed: { label: 'first pass', tone: 'is-good' },
	approved: { label: 'approved', tone: 'is-approved' },
	rejected: { label: 'rejected', tone: 'is-bad' },
	revoked: { label: 'revoked', tone: 'is-bad' },
	changes_requested: { label: 'changes requested', tone: 'is-changes' },
	reverted: { label: 'taken back', tone: 'is-changes' }
} as const;

/* The author answering a change request: back to pending, but not a ship. */
const CHANGES_DONE = { label: 'changes made', tone: 'is-good' } as const;

/* Ari taking a decision back for a fresh look: back to pending, not a ship. */
const REQUEUED = { label: 'back in review', tone: 'is-changes' } as const;

/**
 * A project's history as log entries: every move its submissions made
 * (shipped, first-passed, approved, rejected), and - for a reader who may see
 * the internal side - reviewers' comments, internal notes and fraud holds.
 * Oldest first.
 *
 * Drawn by the project page and by the review desk's History tab. It used to
 * be built inside the project page's load, and the desk, which only had the
 * comments to hand, showed a history with every decision missing from it.
 *
 * `subs` is the project's submissions, newest first, as submissionsForProject
 * returns them. `reveal` is whether the reader is reviewing: false hides first
 * passes, internal notes and comments, as the author must not see them.
 */
export async function projectLog(
	projectId: string,
	subs: Submission[],
	reveal: boolean
): Promise<LogEntry[]> {
	/* The history: one entry per move, oldest first. The author does not see
	   first passes (to them a first-passed submission is still pending) or any
	   internal note; reviewers see everything. Each entry names who did it and
	   what the hours were at that moment. */
	/* Reviewers' comments ride along with the moves - only for a reader who may
	   see the internal side, and never for the author. */
	/* Comments and fraud holds are the internal side: only for a reader who
	   may see it, never the author. */
	const [moves, comments, holds] = await Promise.all([
		projectHistory(projectId),
		reveal ? projectComments(projectId) : Promise.resolve([]),
		reveal ? projectHoldEvents(projectId) : Promise.resolve([])
	]);

	/**
	 * What was new about each submission, measured against what had been
	 * approved BEFORE it.
	 *
	 * It used to measure every row against the project's newest approved
	 * submission, one baseline for the whole list - which is wrong for exactly
	 * the rows that matter most. For an approved submission that baseline IS
	 * itself, so its claim cancelled out and the timeline read "121.3h of 0.0h
	 * approved": a grant measured against nothing. Pending rows looked right,
	 * which is why it survived.
	 *
	 * Walking oldest-first and carrying the last approval forward gives each row
	 * the baseline that was true when it was judged, which is the number the
	 * reviewer was actually looking at. `subs` arrives newest-first.
	 *
	 * It also costs one query fewer. The batched lookup this replaced answered a
	 * question about the project as it stands now, and no historical row is
	 * asking that.
	 */
	const newWorkBySubmission = new Map<string, number>();
	let approvedSoFar: Submission | null = null;
	for (const submission of [...subs].reverse()) {
		newWorkBySubmission.set(submission.id, newWorkFrom(submission, approvedSoFar));
		/* Revoked counts too: its claim stays consumed, so it is the baseline
		   every later ship was measured against. */
		if (submission.state === 'approved' || submission.state === 'revoked') {
			approvedSoFar = submission;
		}
	}
	/* The approval each still-approved ship stands on: its latest move into
	   `approved`. That entry carries the ship - for the hyper-chroma pill, and
	   for the page's control to mark it - and an earlier approval Ari since
	   took back and gave again does not, so the pill appears once per ship. */
	const standing = new Map(
		subs
			.filter((submission) => submission.state === 'approved')
			.map((submission) => [submission.id, submission])
	);
	const standingApproval = new Map<string, string>();
	for (const move of [...moves].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
		if (move.toState === 'approved' && standing.has(move.submissionId)) {
			standingApproval.set(move.submissionId, move.id);
		}
	}

	return moves
		.filter((move) => reveal || move.toState !== 'first_passed')
		.map((move): LogEntry => {
			/* Who the author sees saying this.

			   An approval is made by an approver but SPOKEN by the first-pass
			   reviewer: the second pass copies their message forward word for word
			   rather than writing a new one, and the author never sees the first
			   pass itself. Naming the approver beside somebody else's words made
			   the reviewer who actually read the project invisible and put their
			   sentences in an admin's mouth. On a full review the two are the same
			   person, so this changes nothing there.

			   Only the approval, and only for the author. A rejection's message is
			   the rejecting actor's own words, and a reviewer's log stays a record
			   of who moved what. */
			const speaker =
				!reveal && move.toState === 'approved' && move.reviewerId
					? { handle: move.reviewerHandle, avatarUrl: move.reviewerAvatarUrl }
					: { handle: move.actorHandle, avatarUrl: move.actorAvatarUrl };
			const claimedNew = newWorkBySubmission.get(move.submissionId) ?? move.claimedSeconds;
			const awarded =
				typeof move.metadata?.awardedSeconds === 'number'
					? move.metadata.awardedSeconds
					: (move.awardedSeconds ?? null);
			/* A move back to pending is the ship itself only when it came from
			   nowhere. From a change request it is the author sending it back;
			   from a decision it is Ari taking that decision back. */
			const changesDone =
				move.fromState === 'changes_requested' &&
				move.toState === 'pending' &&
				move.metadata?.changesDone === true;
			const requeued = move.fromState !== null && move.toState === 'pending' && !changesDone;
			const reversed =
				typeof move.metadata?.reversedSeconds === 'number' ? move.metadata.reversedSeconds : 0;
			/* Ari counts an update its own way (see projects/window.ts), so its
			   grant is not "of" Phantom's new-work figure - printing it that way
			   would read as a cut nobody made. */
			const fromAri = move.metadata?.ari !== undefined;
			const takenBack = requeued || move.toState === 'reverted';
			const summary = changesDone
				? null
				: takenBack
					? null
					: move.toState === 'pending'
						? `${hours(claimedNew)} submitted`
						: move.toState === 'first_passed'
							? `${hours(awarded ?? 0)} of ${hours(claimedNew)} proposed`
							: move.toState === 'approved'
								? fromAri
									? `${hours(awarded ?? 0)} approved`
									: `${hours(awarded ?? 0)} of ${hours(claimedNew)} approved`
								: null;
			/* The payout, with the fragment mark: what an approval credited
			   (its time rounded down to whole fragments), or what a taken-back
			   decision took out of the balance. */
			const paid = changesDone
				? null
				: takenBack
					? reversed > 0
						? { seconds: reversed, after: 'taken back' }
						: null
					: move.toState === 'approved'
						? { seconds: payoutSeconds(awarded ?? 0) }
						: move.toState === 'revoked'
							? { seconds: payoutSeconds(awarded ?? 0), after: 'taken back' }
							: null;
			return {
				id: move.id,
				actor: {
					/* Slack handles, never full names - see projectHistory, which
					   fetches no email either. The author reads this log too. */
					name: speaker.handle ? `@${speaker.handle}` : 'phantom',
					avatarUrl: speaker.avatarUrl
				},
				badge: changesDone ? CHANGES_DONE : requeued ? REQUEUED : LOG_STATE[move.toState],
				kind: move.toState,
				summary,
				fragments: paid,
				/* The ship row's reason is boilerplate; the changelog is the message. */
				message:
					move.toState === 'pending' && !changesDone && !requeued
						? move.changelog
						: move.reason || null,
				internal: reveal ? move.internalNote : null,
				ship:
					standingApproval.get(move.submissionId) === move.id
						? {
								submissionId: move.submissionId,
								hyperChroma: standing.get(move.submissionId)?.hyperChroma ?? false
							}
						: null,
				at: move.createdAt
			} satisfies LogEntry;
		})
		.concat(comments, holds)
		.sort((a, b) => a.at.getTime() - b.at.getTime());
}
