import { and, desc, eq, gt, inArray, lt, notExists, sql } from 'drizzle-orm';

import { ariReviewUrl } from '$lib/server/ari';
import { db } from '$lib/server/db/client';
import {
	ariDeliveries,
	ariShips,
	jobRuns,
	outboxEvents,
	projects,
	submissions,
	type JobRun
} from '$lib/server/db/schema';
import { ariConfig, ariWebhookSecret } from '$lib/server/env';

/**
 * What the console's Ari page shows: where Phantom and Ari stand with each
 * other, and the things only a person can settle.
 *
 * Three kinds of trouble, each with a cause written on its row rather than
 * left for someone to dig out of the database:
 *
 * - Deliveries that did not fit (`ignored`) - a decision Phantom did not
 *   apply, with the reason - and approvals still held for Ari's second pass
 *   (`waiting`), which `ari.reconcile` applies once Ari says they stand.
 * - Ships that never reached Ari: pending, with no Ari ship, past the grace
 *   a send normally needs - with what the send effect last said.
 * - What the last `ari.reconcile` run found, including ships Ari decided
 *   that Phantom never heard about.
 */

/** How long a ship may take to reach Ari before it counts as stuck. */
const SEND_GRACE_MS = 30 * 60_000;

/** How far back the delivery figures look. */
const RECENT_MS = 7 * 24 * 60 * 60_000;

export type ConsoleDelivery = {
	deliveryId: string;
	event: string;
	outcome: string;
	detail: string | null;
	receivedAt: Date;
	projectNumber: number | null;
	projectName: string | null;
	ariUrl: string | null;
};

export type StuckShip = {
	projectNumber: number;
	projectName: string;
	shippedAt: Date;
	sendStatus: string | null;
	sendError: string | null;
	sendAttempts: number;
};

export type AriConsole = {
	configured: { ingest: boolean; webhook: boolean };
	counts: {
		/** Deliveries in the last week, by what became of them. */
		recent: Record<string, number>;
		ships: number;
		open: number;
	};
	attention: ConsoleDelivery[];
	stuck: StuckShip[];
	lastReconcile: JobRun | null;
};

export async function ariConsole(): Promise<AriConsole> {
	const since = new Date(Date.now() - RECENT_MS);
	const cutoff = new Date(Date.now() - SEND_GRACE_MS);

	const [byOutcome, [{ ships }], [{ open }], attentionRows, stuckRows, [lastReconcile]] =
		await Promise.all([
			db
				.select({ outcome: ariDeliveries.outcome, count: sql<number>`count(*)::int` })
				.from(ariDeliveries)
				.where(gt(ariDeliveries.receivedAt, since))
				.groupBy(ariDeliveries.outcome),
			db.select({ ships: sql<number>`count(*)::int` }).from(ariShips),
			db
				.select({ open: sql<number>`count(*)::int` })
				.from(submissions)
				.where(inArray(submissions.state, ['pending', 'first_passed', 'changes_requested'])),
			db
				.select({
					deliveryId: ariDeliveries.deliveryId,
					event: ariDeliveries.event,
					outcome: ariDeliveries.outcome,
					detail: ariDeliveries.detail,
					receivedAt: ariDeliveries.receivedAt,
					ariId: ariDeliveries.ariId,
					projectNumber: projects.number,
					projectName: projects.name
				})
				.from(ariDeliveries)
				.leftJoin(submissions, eq(submissions.id, ariDeliveries.submissionId))
				.leftJoin(projects, eq(projects.id, submissions.projectId))
				.where(inArray(ariDeliveries.outcome, ['ignored', 'waiting']))
				.orderBy(desc(ariDeliveries.receivedAt))
				.limit(100),
			db
				.select({
					id: submissions.id,
					projectNumber: projects.number,
					projectName: projects.name,
					shippedAt: submissions.stateAt
				})
				.from(submissions)
				.innerJoin(projects, eq(projects.id, submissions.projectId))
				.where(
					and(
						eq(submissions.state, 'pending'),
						lt(submissions.stateAt, cutoff),
						notExists(
							db
								.select({ one: sql`1` })
								.from(ariShips)
								.where(eq(ariShips.submissionId, submissions.id))
						)
					)
				)
				.orderBy(submissions.stateAt)
				.limit(200),
			db
				.select()
				.from(jobRuns)
				.where(and(eq(jobRuns.name, 'ari.reconcile'), sql`${jobRuns.finishedAt} is not null`))
				.orderBy(desc(jobRuns.startedAt))
				.limit(1)
		]);

	/* What the send effect last said about each stuck ship - the newest
	   `ari.ingest` row keyed on its submission. One query for the lot. */
	const sends = stuckRows.length
		? await db
				.select({
					dedupeKey: outboxEvents.dedupeKey,
					status: outboxEvents.status,
					lastError: outboxEvents.lastError,
					attempts: outboxEvents.attempts,
					createdAt: outboxEvents.createdAt
				})
				.from(outboxEvents)
				.where(
					and(
						eq(outboxEvents.effect, 'ari.ingest'),
						sql`${outboxEvents.dedupeKey} similar to ${`submission:(${stuckRows.map((row) => row.id).join('|')}):ari%`}`
					)
				)
				.orderBy(desc(outboxEvents.createdAt))
		: [];
	const lastSend = new Map<string, (typeof sends)[number]>();
	for (const send of sends) {
		const id = send.dedupeKey.split(':')[1];
		if (id && !lastSend.has(id)) lastSend.set(id, send);
	}

	return {
		configured: { ingest: ariConfig() !== null, webhook: ariWebhookSecret() !== null },
		counts: {
			recent: Object.fromEntries(byOutcome.map((row) => [row.outcome, row.count])),
			ships,
			open
		},
		attention: attentionRows.map((row) => ({
			deliveryId: row.deliveryId,
			event: row.event,
			outcome: row.outcome,
			detail: row.detail,
			receivedAt: row.receivedAt,
			projectNumber: row.projectNumber,
			projectName: row.projectName,
			ariUrl: row.ariId ? ariReviewUrl(row.ariId) : null
		})),
		stuck: stuckRows.map((row) => {
			const send = lastSend.get(row.id);
			return {
				projectNumber: row.projectNumber,
				projectName: row.projectName,
				shippedAt: row.shippedAt,
				sendStatus: send?.status ?? null,
				sendError: send?.lastError ?? null,
				sendAttempts: send?.attempts ?? 0
			};
		}),
		lastReconcile: lastReconcile ?? null
	};
}

/** How many things on the Ari page want a person, for the console's card. */
export async function ariAttentionCount(): Promise<number> {
	const cutoff = new Date(Date.now() - SEND_GRACE_MS);
	const [[{ held }], [{ stuck }]] = await Promise.all([
		db
			.select({ held: sql<number>`count(*)::int` })
			.from(ariDeliveries)
			.where(inArray(ariDeliveries.outcome, ['ignored', 'waiting'])),
		db
			.select({ stuck: sql<number>`count(*)::int` })
			.from(submissions)
			.where(
				and(
					eq(submissions.state, 'pending'),
					lt(submissions.stateAt, cutoff),
					notExists(
						db
							.select({ one: sql`1` })
							.from(ariShips)
							.where(eq(ariShips.submissionId, submissions.id))
					)
				)
			)
	]);
	return held + stuck;
}

/**
 * Mark an ignored delivery as seen: a person has read why it did not apply
 * and dealt with it (or decided it needs nothing). It leaves the list, and
 * `ari.reconcile` stops counting it. The delivery itself is kept.
 */
export async function acknowledgeDelivery(deliveryId: string): Promise<boolean> {
	const [row] = await db
		.update(ariDeliveries)
		.set({ outcome: 'acknowledged', updatedAt: new Date() })
		.where(and(eq(ariDeliveries.deliveryId, deliveryId), eq(ariDeliveries.outcome, 'ignored')))
		.returning({ deliveryId: ariDeliveries.deliveryId });
	return row !== undefined;
}
