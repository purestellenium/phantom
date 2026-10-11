import { and, eq } from 'drizzle-orm';

import { recordAudit } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import { submissions } from '$lib/server/db/schema';
import { enqueue } from '$lib/server/outbox';
import { linkOrigin } from '$lib/server/projects/review';
import { isUuid } from '$lib/uuid';

/**
 * Hyper-chroma: a project marked exceptionally good.
 *
 * The mark lives on a ship rather than on the project, so there is always a
 * record of which ship earned it - which is what a bonus for it, when there is
 * one, will be keyed on. A project is hyper-chroma while any of its APPROVED
 * ships is marked: a mark on a ship that was since reverted or revoked counts
 * for nothing, because the approval it sat on no longer stands.
 *
 * Two ways in. Ari's reviewers tick the `hyper_chroma` review field, and the
 * approval sets the mark from it (see `approve` in projects/decisions.ts and
 * `isHyperChroma` in ari.ts). And people who can approve submissions can mark
 * or unmark an approved ship by hand, here, for ships Ari approved before the
 * checkbox existed or without it ticked.
 *
 * Ari can add the mark but never take it off. An approval with the box
 * unticked - a ship requeued and approved again by a reviewer who forgot it,
 * say - leaves the mark as it was, because its owner may already have been
 * told and promised bonuses. Only a person removing it here takes it off.
 */

export type HyperChromaResult = { ok: true } | { ok: false; error: string };

/** Mark or unmark one approved ship of a project, by hand. Refused for a ship
 *  that is not approved - a mark there would count for nothing, and would
 *  come back to life unannounced if it were approved again. Audited either
 *  way it goes. */
export async function setHyperChroma(input: {
	projectId: string;
	submissionId: string;
	on: boolean;
	actorId: string;
}): Promise<HyperChromaResult> {
	const { projectId, submissionId, on, actorId } = input;
	/* It arrives from a form field, and Postgres throws on a malformed uuid
	   rather than matching nothing. */
	if (!isUuid(submissionId)) return { ok: false, error: 'That ship is not on this project.' };
	/* Read now, inside the request, for the DM's link - see linkOrigin. */
	const origin = on ? await linkOrigin() : null;
	return db.transaction(async (tx) => {
		/* One conditional update rather than a read and a write: the state
		   check and the change land together, so an Ari revert arriving between
		   them cannot leave a mark on a ship that is no longer approved. */
		const [updated] = await tx
			.update(submissions)
			.set({
				hyperChroma: on,
				hyperChromaAt: on ? new Date() : null,
				hyperChromaById: on ? actorId : null
			})
			.where(
				and(
					eq(submissions.id, submissionId),
					eq(submissions.projectId, projectId),
					eq(submissions.state, 'approved'),
					eq(submissions.hyperChroma, !on)
				)
			)
			.returning({ userId: submissions.userId });
		if (!updated) {
			const [current] = await tx
				.select({ state: submissions.state, hyperChroma: submissions.hyperChroma })
				.from(submissions)
				.where(and(eq(submissions.id, submissionId), eq(submissions.projectId, projectId)))
				.limit(1);
			if (!current) return { ok: false, error: 'That ship is not on this project.' };
			if (current.state !== 'approved') {
				return { ok: false, error: 'Only an approved ship can be marked hyper-chroma.' };
			}
			return {
				ok: false,
				error: on ? 'That ship is already hyper-chroma.' : 'That ship is not hyper-chroma.'
			};
		}
		/* The owner hears about a mark made by hand - the approval DM went out
		   before it, without the line. Once per ship: the key does not change,
		   so taking the mark off and putting it back does not send it twice. */
		if (on) {
			await enqueue(
				{
					effect: 'slack.dm_hyper_chroma',
					dedupeKey: `submission:${submissionId}:dm:hyper_chroma`,
					payload: { submissionId, origin }
				},
				tx
			);
		}
		await recordAudit(
			{
				action: on ? 'submission.hyper_chroma_marked' : 'submission.hyper_chroma_removed',
				actorId,
				subjectId: updated.userId,
				metadata: { submissionId, projectId }
			},
			tx
		);
		return { ok: true };
	});
}
