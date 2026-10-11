import { and, asc, desc, eq, gt, inArray, notExists, sql } from 'drizzle-orm';

import {
	ARI_INGEST_EFFECT,
	AriError,
	ariIngestDedupeKey,
	ariStatus,
	latestAriShip
} from '$lib/server/ari';
import { db } from '$lib/server/db/client';
import { ariDeliveries, ariShips, projects, submissions } from '$lib/server/db/schema';
import { ariConfig } from '$lib/server/env';
import { nudgeOutbox } from '$lib/server/jobs';
import { enqueue } from '$lib/server/outbox';
import { applyWaiting } from '$lib/server/projects/decisions';
import type { JsonObject } from '$lib/json';

/**
 * Keeping Phantom and Ari in step: the two jobs that do it.
 *
 * `ari.backfill` sends Ari every ship that was waiting before review moved
 * there. `ari.reconcile` catches what the webhook alone cannot: approvals that
 * arrived before Ari finished deciding them, ships that never reached Ari,
 * and decisions whose delivery Ari gave up on.
 */

/** Open, as Phantom sees it: waiting on Ari, or on the author. */
const OPEN = ['pending', 'first_passed', 'changes_requested'] as const;

/** How long a ship may take to reach Ari before reconcile calls it missing. */
const SEND_GRACE_MS = 30 * 60_000;

/**
 * Send Ari every pending submission it has not been sent, oldest first, each
 * backdated to when it shipped so Ari's queue keeps their order.
 *
 * Queues the `ari.ingest` effect rather than sending itself, under the same
 * key a ship uses - so a submission that already has a send queued, sent or
 * failed is left alone, and running this twice queues nothing the second time.
 */
export async function backfillAri(): Promise<JsonObject> {
	const waiting = await db
		.select({ id: submissions.id, projectId: submissions.projectId })
		.from(submissions)
		.where(
			and(
				eq(submissions.state, 'pending'),
				notExists(
					db
						.select({ one: sql`1` })
						.from(ariShips)
						.where(eq(ariShips.submissionId, submissions.id))
				)
			)
		)
		.orderBy(asc(submissions.createdAt));

	let queued = 0;
	for (const { id, projectId } of waiting) {
		await db.transaction(async (tx) => {
			await enqueue(
				{
					effect: ARI_INGEST_EFFECT,
					dedupeKey: ariIngestDedupeKey(id),
					payload: {
						submissionId: id,
						after: await latestAriShip(projectId, tx),
						origin: null,
						backdate: true
					}
				},
				tx
			);
		});
		queued += 1;
	}
	if (queued > 0) nudgeOutbox();
	return { pending: waiting.length, queued };
}

/**
 * Compare every open submission with what Ari says about it, and apply the
 * approvals that were waiting on Ari to finish.
 *
 * Repairs only the one thing it can repair safely - a held approval, once Ari
 * says it stands. A ship that never reached Ari, or one Ari has decided while
 * Phantom still shows it open (a delivery Ari gave up on after its retries),
 * is reported with its project number and left for a person: Ari's status
 * says THAT a decision was made, not the hours or the note, and resending
 * the delivery from Ari's review screen is what brings those.
 */
export async function reconcileAri(): Promise<{ counts: JsonObject; needsAttention: boolean }> {
	if (!ariConfig()) return { counts: { configured: false }, needsAttention: false };

	/* ── approvals held until Ari finished deciding ───────────────────────── */
	const held = await db
		.select({ deliveryId: ariDeliveries.deliveryId })
		.from(ariDeliveries)
		.where(eq(ariDeliveries.outcome, 'waiting'))
		.orderBy(asc(ariDeliveries.receivedAt));
	let applied = 0;
	let stillWaiting = 0;
	for (const { deliveryId } of held) {
		/* Ari not answering leaves a held approval held, for the next run -
		   never a reason to stop this one. */
		let outcome;
		try {
			outcome = await applyWaiting(deliveryId);
		} catch (error) {
			if (error instanceof AriError) {
				stillWaiting += 1;
				continue;
			}
			throw error;
		}
		if (outcome === 'applied') applied += 1;
		else if (outcome === 'waiting') stillWaiting += 1;
	}

	/* ── open submissions against Ari ─────────────────────────────────────── */
	const open = await db
		.select({
			id: submissions.id,
			state: submissions.state,
			createdAt: submissions.createdAt,
			stateAt: submissions.stateAt,
			number: projects.number
		})
		.from(submissions)
		.innerJoin(projects, eq(projects.id, submissions.projectId))
		.where(inArray(submissions.state, [...OPEN]))
		.orderBy(asc(submissions.createdAt));

	const notSent: number[] = [];
	const drift: string[] = [];
	let unreachable = 0;
	const cutoff = new Date(Date.now() - SEND_GRACE_MS);

	for (const row of open) {
		const [ship] = await db
			.select({ ariId: ariShips.ariId })
			.from(ariShips)
			.where(eq(ariShips.submissionId, row.id))
			.orderBy(desc(ariShips.createdAt))
			.limit(1);
		if (!ship) {
			if (row.stateAt < cutoff && row.state === 'pending') notSent.push(row.number);
			continue;
		}
		let status;
		try {
			status = await ariStatus({ id: ship.ariId });
		} catch (error) {
			if (error instanceof AriError) {
				unreachable += 1;
				continue;
			}
			throw error;
		}
		const decided = status === null || ['reviewed', 'withdrawn', 'reverted'].includes(status.phase);
		/* Waiting on the author is what Ari calls a decided ship: changes. */
		const agrees =
			row.state === 'changes_requested'
				? status?.phase === 'reviewed' && status.decision === 'changes'
				: !decided;
		if (!agrees && row.stateAt < cutoff) {
			drift.push(
				`#${row.number}: ${row.state} here, ${status ? `${status.phase}/${status.decision ?? '-'}` : 'unknown'} on Ari`
			);
		}
	}

	/* Deliveries recorded as not fitting, in the last day - each one a
	   decision Phantom did not apply, with its reason on the row. */
	const [{ ignored }] = await db
		.select({ ignored: sql<number>`count(*)::int` })
		.from(ariDeliveries)
		.where(
			and(
				eq(ariDeliveries.outcome, 'ignored'),
				gt(ariDeliveries.receivedAt, new Date(Date.now() - 24 * 60 * 60_000))
			)
		);

	return {
		counts: {
			applied,
			stillWaiting,
			open: open.length,
			notSent: notSent.length,
			notSentProjects: notSent.slice(0, 25),
			drift: drift.length,
			driftDetail: drift.slice(0, 25),
			unreachable,
			ignoredToday: ignored
		},
		needsAttention: notSent.length > 0 || drift.length > 0 || ignored > 0
	};
}
