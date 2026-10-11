import { and, eq, gt, sql } from 'drizzle-orm';

import { recordAudit, type DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import { ariDeliveries, auditEvents, projects, submissions } from '$lib/server/db/schema';

/**
 * Whether a project was turned down for fraud, and so cannot be shipped again.
 *
 * A fraud rejection arrives as an ordinary `review.rejected`; what marks it
 * is the fixed form of the audit note Ari writes for one. Other rejections
 * are fixable and do not count.
 *
 * Only a rejection that still stands: a fraud rejection Ari later took back
 * (requeued or reverted) moved the submission out of `rejected`, and frees the
 * project again.
 */
/** Where to go about a fraud decision, said after every one Phantom shows:
 *  the ship refusal, the ship panel, and the rejection DM. */
export const FRAUD_SQUAD_NOTE = 'If you think this is a mistake, DM the @Fraud Squad bot on Slack.';

export const FRAUD_REJECTED = `This project was turned down by Hack Club's fraud team, so it can't be shipped again. For more information see https://fraud.hackclub.com. ${FRAUD_SQUAD_NOTE}`;

/** Whether this submission's own rejection was a fraud one - for the
 *  rejection DM, which is about one submission. Same marker as below. */
export async function fraudRejectedSubmission(
	submissionId: string,
	handle: DbHandle = db
): Promise<boolean> {
	const [row] = await handle
		.select({ one: sql<number>`1` })
		.from(ariDeliveries)
		.where(
			and(
				eq(ariDeliveries.submissionId, submissionId),
				eq(ariDeliveries.event, 'review.rejected'),
				sql`(
					${ariDeliveries.body}->'review'->>'audit_note' like 'Fraud-rejected:%'
					or ${ariDeliveries.body}->'review'->>'audit_note' like 'Auto-rejected: Hackatime trust level%'
				)`
			)
		)
		.limit(1);
	return row !== undefined;
}

/** What an operator lifting a fraud block writes to the audit log - and so
 *  what `fraudRejected` looks for. See `liftFraudBlock`. */
export const FRAUD_LIFTED = 'project.fraud_block_lifted';

/**
 * Whether the project is blocked: a standing fraud rejection, newer than the
 * last time an operator lifted the block (`liftFraudBlock`). A fraud
 * rejection after a lift blocks it again.
 */
export async function fraudRejected(projectId: string, handle: DbHandle = db): Promise<boolean> {
	const [row] = await handle
		.select({ at: sql<string | null>`max(${ariDeliveries.receivedAt})` })
		.from(submissions)
		.innerJoin(ariDeliveries, eq(ariDeliveries.submissionId, submissions.id))
		.where(
			and(
				eq(submissions.projectId, projectId),
				eq(submissions.state, 'rejected'),
				eq(ariDeliveries.event, 'review.rejected'),
				sql`(
					${ariDeliveries.body}->'review'->>'audit_note' like 'Fraud-rejected:%'
					or ${ariDeliveries.body}->'review'->>'audit_note' like 'Auto-rejected: Hackatime trust level%'
				)`
			)
		);
	if (!row?.at) return false;
	const rejectedAt = new Date(row.at);

	const [lifted] = await handle
		.select({ one: sql<number>`1` })
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.action, FRAUD_LIFTED),
				sql`${auditEvents.metadata}->>'projectId' = ${projectId}`,
				gt(auditEvents.createdAt, rejectedAt)
			)
		)
		.limit(1);
	return lifted === undefined;
}

/**
 * Let a project turned down for fraud be shipped again - an operator's
 * decision (`manage_fraud`), for when the fraud team's call has been
 * overturned or was wrong. Written to the audit log, which is where the block
 * reads it from: no column to migrate, and a record of who lifted it and why
 * that cannot be edited afterwards. The Ari rejection itself stays as history.
 */
export async function liftFraudBlock(
	projectId: string,
	actorId: string,
	reason: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!(await fraudRejected(projectId))) {
		return { ok: false, error: 'This project is not blocked for fraud.' };
	}
	const [owner] = await db
		.select({ userId: projects.userId })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	await recordAudit({
		action: FRAUD_LIFTED,
		actorId,
		subjectId: owner?.userId ?? null,
		metadata: { projectId, reason: reason?.trim() || null }
	});
	return { ok: true };
}
