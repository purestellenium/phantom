import { and, desc, eq, inArray, lte, or, sql as raw } from 'drizzle-orm';

import { isUuid } from '$lib/uuid';
import type { DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import { outboxEvents, type OutboxEvent } from '$lib/server/db/schema';
import type { JsonObject } from '$lib/json';

/**
 * The gap between a decision that has committed and an effect that has not.
 *
 * A database transaction cannot roll back a network call, so the two cannot be
 * made atomic and pretending otherwise is where the bugs are. An approval that
 * writes to the database and then calls Airtable, then Slack, inline can fail at
 * the third step with the first two done and nothing durable saying the third
 * is owed; a review that commits and then calls Slack once has no retry at all.
 * Fallout's HCB flow is the one the wiki calls the strongest:
 * commit a pending intent, then call out, and refuse to try again while the
 * result is ambiguous.
 *
 * This is that, generalised. `enqueue` is called INSIDE the caller's
 * transaction, so the row and the decision commit together. A worker claims due
 * rows, runs a handler, and records what happened. Nothing else in this codebase
 * makes a fallible external call inline.
 *
 * The one thing this is not is a queue with ordering guarantees. Effects here
 * are independent - a notification, a projection - and anything that genuinely
 * needs ordering needs a different mechanism and a reason.
 */

/* ── shape ───────────────────────────────────────────────────────────────── */

export type EnqueueInput = {
	/** Which handler. Matched against the registry in lib/effects. */
	effect: string;
	/** What makes this intent unique - `order:<id>:placed`. Two rows with the
	 *  same effect and key are the same intent, and the second is dropped. */
	dedupeKey: string;
	/** References, not contents. See the note on the column: no tokens, no PII,
	 *  and the handler reads the current record when it runs. */
	payload?: JsonObject;
};

/**
 * What a handler is allowed to say happened.
 *
 * `ambiguous` is the one that earns its place and the one a handler must
 * actually use. It means the call went out and we do not know whether it landed
 * - a timeout after the request was written, a 5xx from something that is not
 * idempotent. Retrying that is how one notification becomes four. The row stops
 * and waits for a person.
 */
export type EffectOutcome =
	| { status: 'delivered'; remoteId?: string | null }
	| { status: 'retryable'; error: string }
	| { status: 'failed'; error: string }
	| { status: 'ambiguous'; error: string }
	| { status: 'skipped'; error: string }
	/**
	 * Not yet, and not because anything went wrong.
	 *
	 * The provider this effect needs is not configured, so nothing was attempted
	 * and nothing left the building. That is a fact about the DEPLOYMENT and not
	 * about the event, and it stops being true the moment somebody sets the
	 * variable - which is exactly why it must not be `skipped`. A skipped row is
	 * terminal, so an order placed the hour before Slack was configured would
	 * never be announced, and nothing would ever say so.
	 *
	 * The row goes back to `pending` instead, with its attempt counter untouched
	 * because there was no attempt, and a delay so a permanently unconfigured
	 * provider does not monopolise every batch.
	 */
	| { status: 'deferred'; error: string };

export type EffectHandler = (event: OutboxEvent) => Promise<EffectOutcome>;

/* ── retry policy ────────────────────────────────────────────────────────── */

/**
 * How many times a retryable failure is retried before it becomes a failure.
 *
 * Small on purpose. These are notifications and projections: something that has
 * failed eight times is not going to succeed on the ninth, and a row that
 * retries forever is a row nobody ever looks at.
 */
const MAX_ATTEMPTS = 8;

/** Exponential with a ceiling. The first retry is a minute away, the last is an
 *  hour, and nothing hammers a provider that is already having a bad day. */
function backoffMs(attempts: number): number {
	return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** How long a worker holds a claim. Longer than any handler should take, short
 *  enough that a worker killed mid-flight does not strand the row for an hour.
 *  The row is reclaimable after this, which is why handlers must be safe to
 *  run twice - the lease reduces duplicate work, it does not eliminate it. */
const LEASE_MS = 2 * 60_000;

/** How long a deferred row waits before it is looked at again.
 *
 *  Long enough that an unconfigured provider costs one cheap no-op per row per
 *  five minutes rather than filling every batch - `claimDue` takes the oldest
 *  due rows, so without a delay a backlog of deferred ones would crowd out the
 *  events behind them. Short enough that configuring a provider starts
 *  delivering within a few minutes, with no operator action. */
const DEFER_MS = 5 * 60_000;

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * Record an effect that is owed.
 *
 * Takes a handle rather than defaulting to the pool, and that is not a
 * convenience: an outbox row that commits independently of the decision it
 * belongs to is a notification about something that may not have happened. The
 * signature makes the transaction the obvious thing to pass.
 *
 * `onConflictDoNothing` on (effect, dedupeKey) means a caller's own retry - a
 * server action submitted twice, a transaction replayed - enqueues one effect.
 */
export async function enqueue(input: EnqueueInput, tx: DbHandle): Promise<void> {
	await tx
		.insert(outboxEvents)
		.values({
			effect: input.effect,
			dedupeKey: input.dedupeKey,
			payload: input.payload ?? null
		})
		.onConflictDoNothing({
			target: [outboxEvents.effect, outboxEvents.dedupeKey]
		});
}

/* ── claiming ────────────────────────────────────────────────────────────── */

/**
 * Take up to `limit` due rows, exclusively.
 *
 * One UPDATE with a subquery, because the read and the claim have to be the same
 * statement. A select followed by an update has a window in which two workers
 * both see the same row, and the whole point of the lease is to close it.
 *
 * `for update skip locked` is what makes several workers useful rather than
 * merely safe: a worker that would block on a row another is already claiming
 * steps over it instead and takes the next one.
 *
 * A row is due when it is pending or retryable, its next attempt has arrived,
 * and either nobody holds it or the holder's lease has expired. That last
 * clause is the crash recovery: a worker that dies mid-handler leaves a lease
 * that runs out, and the row comes back on its own rather than needing an
 * operator to notice.
 */
export async function claimDue(limit = 20): Promise<OutboxEvent[]> {
	const now = new Date();
	const leasedUntil = new Date(now.getTime() + LEASE_MS);

	const claimed = await db
		.update(outboxEvents)
		.set({ leasedUntil, updatedAt: now })
		.where(
			inArray(
				outboxEvents.id,
				db
					.select({ id: outboxEvents.id })
					.from(outboxEvents)
					.where(
						and(
							inArray(outboxEvents.status, ['pending', 'retryable']),
							lte(outboxEvents.nextAttemptAt, now),
							or(raw`${outboxEvents.leasedUntil} is null`, lte(outboxEvents.leasedUntil, now))
						)
					)
					.orderBy(outboxEvents.nextAttemptAt)
					.limit(limit)
					.for('update', { skipLocked: true })
			)
		)
		.returning();

	return claimed;
}

/* ── settling ────────────────────────────────────────────────────────────── */

/**
 * Write down what happened to a claimed row.
 *
 * The attempt counter increments on every outcome including success, because
 * "delivered on the fourth try" is a different operational fact from "delivered
 * immediately" and only one of them means the provider is healthy.
 *
 * The lease is cleared in every branch. A settled row holding a lease is a row
 * that looks claimed to the next worker and to every operator reading the
 * table.
 */
export async function settle(event: OutboxEvent, outcome: EffectOutcome): Promise<void> {
	const now = new Date();
	const attempts = event.attempts + 1;

	const base = {
		attempts,
		leasedUntil: null,
		updatedAt: now
	};

	if (outcome.status === 'delivered') {
		await db
			.update(outboxEvents)
			.set({
				...base,
				status: 'delivered',
				remoteId: outcome.remoteId ?? null,
				lastError: null
			})
			.where(eq(outboxEvents.id, event.id));
		return;
	}

	if (outcome.status === 'deferred') {
		/* Back to pending, and `attempts` deliberately not incremented: the counter
       answers "how many times have we tried this", and the answer is still the
       same number. Incrementing would walk an untried row toward MAX_ATTEMPTS
       and give up on something nobody had attempted once. */
		await db
			.update(outboxEvents)
			.set({
				attempts: event.attempts,
				leasedUntil: null,
				updatedAt: now,
				status: 'pending',
				nextAttemptAt: new Date(now.getTime() + DEFER_MS),
				lastError: sanitise(outcome.error)
			})
			.where(eq(outboxEvents.id, event.id));
		return;
	}

	if (outcome.status === 'retryable') {
		/* Out of retries is a failure, not an infinite loop. The error is kept so
       the row explains itself without a log search. */
		const exhausted = attempts >= MAX_ATTEMPTS;
		await db
			.update(outboxEvents)
			.set({
				...base,
				status: exhausted ? 'failed' : 'retryable',
				nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
				lastError: sanitise(
					exhausted ? `gave up after ${attempts} attempts: ${outcome.error}` : outcome.error
				)
			})
			.where(eq(outboxEvents.id, event.id));
		return;
	}

	await db
		.update(outboxEvents)
		.set({
			...base,
			status: outcome.status,
			lastError: sanitise(outcome.error)
		})
		.where(eq(outboxEvents.id, event.id));
}

/**
 * Cut an error down to something safe to store.
 *
 * The wiki's rule for this column is status codes and error names, never bodies
 * and never headers. A provider's error body routinely echoes the request, and
 * the request routinely contains the bearer token that was rejected - which is
 * how a credential ends up in a table support staff read casually. Truncating is
 * a backstop; the real rule is that handlers construct these strings themselves
 * rather than passing a response through.
 */
function sanitise(error: string): string {
	return error.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/* ── operator surfaces ───────────────────────────────────────────────────── */

/** Recent rows, newest first, for the console. */
export async function recentEvents(limit = 100): Promise<OutboxEvent[]> {
	return db.select().from(outboxEvents).orderBy(desc(outboxEvents.createdAt)).limit(limit);
}

/** How many rows are in each state. What an alert would watch: a growing
 *  `failed` count or any `ambiguous` at all is somebody's afternoon. */
export async function outboxCounts(): Promise<Record<string, number>> {
	const rows = await db
		.select({
			status: outboxEvents.status,
			count: raw<number>`count(*)::int`
		})
		.from(outboxEvents)
		.groupBy(outboxEvents.status);

	return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

/**
 * Put a row back in the queue by hand.
 *
 * Deliberately refuses `ambiguous`. That state means we do not know whether the
 * effect already happened, and a retry button that fires anyway is the exact
 * mistake the state exists to prevent - the wiki's rule is that money and
 * registration reconciliation must halt rather than act on an unknown. An
 * ambiguous row is resolved by finding out what actually happened at the far
 * end, and then either marking it delivered or enqueueing a fresh intent.
 */
export async function retryEvent(id: string): Promise<boolean> {
	if (!isUuid(id)) return false;
	const [updated] = await db
		.update(outboxEvents)
		.set({
			status: 'pending',
			nextAttemptAt: new Date(),
			leasedUntil: null,
			updatedAt: new Date()
		})
		.where(
			and(eq(outboxEvents.id, id), inArray(outboxEvents.status, ['failed', 'retryable', 'skipped']))
		)
		.returning({ id: outboxEvents.id });

	return !!updated;
}

/**
 * Give up on a row, by hand, for good: an effect that cannot happen and never
 * will - a Slack message to someone Slack has banned, a record for a person
 * who has since been deleted. It becomes `skipped`, the terminal state for an
 * effect deliberately not delivered, which is not counted as needing
 * attention. The operator's reason is kept on the row.
 *
 * For a failed, retrying or ambiguous row. An ambiguous one is included on
 * purpose: "we do not know whether it landed, and it does not matter" is a
 * real answer, and without this the only ways out were a claim of delivery
 * or another attempt. `retryEvent` still takes a skipped row back if the
 * dismissal was wrong.
 */
export async function dismissEvent(id: string, note: string): Promise<boolean> {
	if (!isUuid(id)) return false;
	const [updated] = await db
		.update(outboxEvents)
		.set({
			status: 'skipped',
			lastError: sanitise(`dismissed by operator: ${note}`),
			leasedUntil: null,
			updatedAt: new Date()
		})
		.where(
			and(
				eq(outboxEvents.id, id),
				inArray(outboxEvents.status, ['failed', 'retryable', 'ambiguous'])
			)
		)
		.returning({ id: outboxEvents.id });

	return !!updated;
}

/** Settle an ambiguous row by hand, once an operator has established what
 *  happened at the far end. The remote id is the evidence and is required for
 *  a delivered verdict - a claim that it landed with nothing to point at is a
 *  guess wearing a resolution. */
export async function resolveAmbiguous(
	id: string,
	verdict: { delivered: true; remoteId: string } | { delivered: false; note: string }
): Promise<boolean> {
	if (!isUuid(id)) return false;
	const [updated] = await db
		.update(outboxEvents)
		.set(
			verdict.delivered
				? {
						status: 'delivered',
						remoteId: verdict.remoteId,
						lastError: null,
						leasedUntil: null,
						updatedAt: new Date()
					}
				: {
						status: 'pending',
						nextAttemptAt: new Date(),
						lastError: sanitise(`reopened by operator: ${verdict.note}`),
						leasedUntil: null,
						updatedAt: new Date()
					}
		)
		.where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, 'ambiguous')))
		.returning({ id: outboxEvents.id });

	return !!updated;
}
