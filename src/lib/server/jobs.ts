import { desc, eq } from 'drizzle-orm';

import { recordActivity } from '$lib/server/activity';
import { backfillAri, reconcileAri } from '$lib/server/ari-sync';
import { sweepExpiredSessions } from '$lib/server/auth/session';
import { db, lockSql } from '$lib/server/db/client';
import { jobRuns, type JobRun } from '$lib/server/db/schema';
import { handlerFor } from '$lib/server/effects';
import { syncLoops } from '$lib/server/loops-sync';
import { claimDue, settle } from '$lib/server/outbox';
import { hasFindings, reconcile } from '$lib/server/reconcile';
import type { JsonObject } from '$lib/json';

/**
 * Everything that runs on a schedule, and the machinery that stops it running
 * twice.
 *
 * NOTHING HERE STARTS A TIMER. That is the whole design and it is a correction
 * to something the wiki records: Stasis starts a five-minute overdue-rental
 * notifier from Node instrumentation, which means every web replica runs its own
 * copy - notifications duplicate across replicas, and a restart forgets which
 * ones were already sent because the state was in memory. The platform baseline
 * says it plainly: "do not start process-local intervals from every web
 * replica. Use a durable job queue or one authenticated scheduler endpoint
 * backed by database idempotency."
 *
 * So: one authenticated endpoint (app/api/jobs/run), a Postgres advisory lock
 * per job name, and a row in `job_runs` for every attempt. Two invocations
 * landing at once produce one run and one refusal, whether they came from two
 * replicas, two cron entries, or an operator pressing a button while the
 * scheduler fired.
 */

export type JobResult = {
	/** Whatever this job counted. Ends up in `job_runs.result` verbatim. */
	counts: JsonObject;
	/** True when the job did its work but something in it needs a person. A
	 *  reconciliation that finds a discrepancy has succeeded at its job and
	 *  failed at its purpose, and those are different rows in the log. */
	needsAttention?: boolean;
};

export type Job = {
	name: string;
	/** One line for the console. What it does and why it is on a timer. */
	description: string;
	run: () => Promise<JobResult>;
};

/* ── the jobs ────────────────────────────────────────────────────────────── */

/**
 * Deliver what the outbox owes.
 *
 * The batch is bounded so one run cannot hold the endpoint open indefinitely,
 * and the loop is sequential rather than concurrent: these are notifications to
 * one provider, and firing twenty at once at Slack is how a run gets rate
 * limited into eight retries.
 *
 * A handler that throws is caught and recorded as retryable rather than taking
 * the batch down. One malformed row must not stop every other effect in the
 * queue, which is the failure mode of a loop with no try inside it.
 */
const dispatchOutbox: Job = {
	name: 'outbox.dispatch',
	description: 'Deliver pending outbox effects. Retries with backoff; leaves ambiguous rows alone.',
	run: async () => {
		const events = await claimDue(25);

		let delivered = 0;
		let retryable = 0;
		let failed = 0;
		let ambiguous = 0;
		let skipped = 0;
		let deferred = 0;

		for (const event of events) {
			const handler = handlerFor(event.effect);

			if (!handler) {
				/* A row enqueued by a deploy that knew an effect this one does not.
           Terminal and legible, rather than a retry loop against a handler that
           is never coming back. */
				await settle(event, {
					status: 'failed',
					error: `no handler registered for effect ${event.effect}`
				});
				failed += 1;
				continue;
			}

			try {
				const outcome = await handler(event);
				await settle(event, outcome);
				if (outcome.status === 'delivered') delivered += 1;
				else if (outcome.status === 'retryable') retryable += 1;
				else if (outcome.status === 'failed') failed += 1;
				else if (outcome.status === 'ambiguous') ambiguous += 1;
				else if (outcome.status === 'deferred') deferred += 1;
				else skipped += 1;
			} catch (error) {
				await settle(event, {
					status: 'retryable',
					error: `handler threw: ${error instanceof Error ? error.name : 'unknown'}`
				});
				retryable += 1;
			}
		}

		return {
			counts: {
				claimed: events.length,
				delivered,
				retryable,
				failed,
				ambiguous,
				skipped,
				/* Counted apart from `skipped` because they mean opposite things: one
           is an effect that will never be delivered, the other is one waiting
           for a variable to be set. A run of nothing but deferred rows is an
           unconfigured provider, and the number is how an operator sees that
           without opening the outbox. */
				deferred
			},
			/* Ambiguous rows are the ones that cannot resolve themselves. Failed rows
         have already stopped trying. Either is a reason to look. */
			needsAttention: ambiguous > 0 || failed > 0
		};
	}
};

/** Drop session rows that expired long enough ago to be of no further use. The
 *  function and its grace period live in lib/auth/session.ts; this is the thing
 *  that finally calls it, which until now nothing did. */
const sweepSessions: Job = {
	name: 'sessions.sweep',
	description: 'Delete sessions that expired more than 30 days ago.',
	run: async () => ({ counts: { deleted: await sweepExpiredSessions() } })
};

/**
 * Run the integrity queries and record whether anything was found.
 *
 * It repairs nothing - see lib/reconcile.ts. Its value is that a discrepancy
 * appears in `job_runs` on a schedule rather than being discovered by the
 * participant it happened to.
 */
const reconcileLedger: Job = {
	name: 'ledger.reconcile',
	description: 'Run every ledger and order integrity query. Read-only; reports, never repairs.',
	run: async () => {
		const findings = await reconcile();
		return {
			counts: Object.fromEntries(findings.map((finding) => [finding.id, finding.count])),
			needsAttention: hasFindings(findings)
		};
	}
};

/**
 * Ask Hackatime who was active today, and fill in any past day not yet asked
 * about. What the console's daily-active-users card is counted from; the
 * machinery is in lib/server/activity.ts.
 */
const recordHackatimeActivity: Job = {
	name: 'hackatime.activity',
	description:
		'Record which linked users logged Hackatime heartbeats each day. Backfills from the cutoff.',
	run: recordActivity
};

/**
 * Send Ari every ship that was waiting before review moved there - see
 * lib/server/ari-sync.ts. Run once at the switch; after that every ship sends
 * itself and this finds nothing.
 */
const backfillAriShips: Job = {
	name: 'ari.backfill',
	description: 'Send pending submissions that never reached Ari. Normally finds nothing.',
	run: async () => ({ counts: await backfillAri() })
};

/**
 * Keep Phantom and Ari in step: apply approvals that were waiting on Ari to
 * finish deciding, and report ships that never reached Ari or that Ari decided
 * without Phantom hearing. Asks Ari about every open submission, so a few
 * minutes apart is plenty.
 */
const reconcileWithAri: Job = {
	name: 'ari.reconcile',
	description:
		'Apply approvals held until Ari finished deciding; report ships Ari and Phantom disagree on.',
	run: reconcileAri
};

/**
 * Bring the "Loops - Sign Ups" table in Airtable up to date with every account:
 * one row per email, saying when they signed up and whether they have shipped.
 * Writes only rows that differ, and never deletes - see lib/server/loops-sync.ts.
 */
const syncLoopsSignups: Job = {
	name: 'loops.sync',
	description:
		'Update the Loops sign-up table in Airtable from every account. Writes only what changed.',
	run: syncLoops
};

export const JOBS: Job[] = [
	dispatchOutbox,
	reconcileWithAri,
	syncLoopsSignups,
	sweepSessions,
	reconcileLedger,
	recordHackatimeActivity,
	backfillAriShips
];

export function jobByName(name: string): Job | null {
	return JOBS.find((job) => job.name === name) ?? null;
}

/* ── running one ─────────────────────────────────────────────────────────── */

/**
 * The advisory lock's name for a job.
 *
 * Hashed by Postgres's own `hashtext`, which means the key is derived the same
 * way on every replica without any of them having to agree on a constant. It
 * returns int4, and the advisory lock functions want int8; the cast is what
 * makes the two fit.
 */
function lockName(name: string): string {
	return `phantom.job.${name}`;
}

export type RunOutcome =
	{ ok: true; run: JobRun } | { ok: false; reason: 'unknown' | 'locked'; message: string };

/* One nudge in flight per process. A burst of enqueues should produce one
   dispatch, not one per row - and `runJob` reserves a connection off a pool of
   three for the length of its advisory lock, so unbounded nudges could take the
   pool out from under the request that fired them. The winner drains everything
   due anyway, including whatever the losers enqueued. */
let nudging = false;

/**
 * Ask the dispatcher to run now, and do not wait for it.
 *
 * The outbox is written inside the transaction that decides something and
 * delivered by whatever calls the dispatcher next - which, on a deployment with
 * no scheduler, was nothing at all: effects sat pending for hours with zero
 * attempts because the queue had a writer and no reader. A nudge is the reader
 * arriving immediately instead of eventually.
 *
 * Call it AFTER the transaction commits, never inside one. An effect dispatched
 * before its row lands is an effect about something that may yet roll back, and
 * the whole reason the outbox exists is that a network call cannot be rolled
 * back with it.
 *
 * This is not the timer the top of this file refuses, and the distinction is
 * not a technicality. That rule is about Stasis starting an interval in every
 * web replica, duplicating notifications and losing its place on restart; both
 * halves are already answered here, because the queue is in Postgres and
 * `runJob` takes an advisory lock. That lock is precisely what makes the
 * dispatcher safe to call from anywhere, at any time, by anyone. What this adds
 * is a caller.
 *
 * It does not replace the schedule. A retryable row waits on a backoff and a
 * deferred one waits on a variable, and nothing enqueues at the moment either
 * becomes due - only a scheduled run picks those up, along with the two jobs
 * nothing enqueues at all.
 */
export function nudgeOutbox(): void {
	if (nudging) return;
	nudging = true;
	void runJob('outbox.dispatch', null)
		.catch((error) => console.error('outbox: nudge failed', error))
		.finally(() => {
			nudging = false;
		});
}

/**
 * Run a job, once, with a row to show for it.
 *
 * The advisory lock is session-scoped, and a session is a connection - so the
 * lock is taken and released on ONE connection reserved from the pool for the
 * length of the run, never on whichever connection the pool happens to hand
 * out next. Taken on the pool at large, the unlock landed on a different
 * connection, quietly returned false, and the lock stayed held by an idle one
 * forever: every later run of that job was refused as "already running" until
 * the process restarted. The job's own queries still go through the pool, and
 * the reserved connection comes from a separate one (`lockSql`): reserved from
 * the application's own pool, three jobs at once took every connection and
 * then waited on each other forever.
 *
 * A transaction-scoped lock (`pg_advisory_xact_lock`) would release itself,
 * but it would also require the whole job to run inside one transaction, and
 * these jobs make external calls. A network call inside a transaction is a
 * transaction held open for the length of somebody else's outage.
 *
 * `try` rather than a blocking acquire: a second invocation should be told the
 * job is already running, not queue up behind it and run again a minute later
 * against a queue the first one already drained.
 */
export async function runJob(name: string, triggeredBy: string | null): Promise<RunOutcome> {
	const job = jobByName(name);
	if (!job) {
		return { ok: false, reason: 'unknown', message: `No job named ${name}.` };
	}

	const lock = await lockSql.reserve();
	try {
		const [acquired] = await lock<{ locked: boolean }[]>`
			select pg_try_advisory_lock(hashtext(${lockName(name)})::bigint) as locked
		`;

		if (!acquired?.locked) {
			return {
				ok: false,
				reason: 'locked',
				message: `${name} is already running.`
			};
		}

		try {
			return await record(name, triggeredBy, job);
		} finally {
			await lock`select pg_advisory_unlock(hashtext(${lockName(name)})::bigint)`;
		}
	} finally {
		lock.release();
	}
}

/** The run itself, with a `job_runs` row on either side of it. */
async function record(name: string, triggeredBy: string | null, job: Job): Promise<RunOutcome> {
	const [run] = await db
		.insert(jobRuns)
		.values({ name, status: 'running', triggeredBy })
		.returning();

	try {
		const result = await job.run();

		const [finished] = await db
			.update(jobRuns)
			.set({
				status: result.needsAttention ? 'partial' : 'succeeded',
				result: result.counts,
				finishedAt: new Date()
			})
			.where(eq(jobRuns.id, run.id))
			.returning();

		return { ok: true, run: finished };
	} catch (error) {
		/* The name, not the message. A job's error goes into a column operators
       read casually, and a stack or a provider's error body is the wrong thing
       to put there - the same rule as the outbox's `lastError`. */
		const [failed] = await db
			.update(jobRuns)
			.set({
				status: 'failed',
				error:
					error instanceof Error
						? `${error.name}: ${error.message}`.slice(0, 300)
						: 'unknown error',
				finishedAt: new Date()
			})
			.where(eq(jobRuns.id, run.id))
			.returning();

		return { ok: true, run: failed };
	}
}

/* ── reading the log ─────────────────────────────────────────────────────── */

/**
 * How long a job may go without running before that is silence rather than a
 * schedule.
 *
 * Generous, because none of these is urgent and a threshold that cries wolf is
 * one people learn to ignore. The wiki's alert list names scheduler silence
 * directly, and this is the number that decides it.
 */
export const QUIET_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a job has gone quiet. A job that has NEVER run counts, because
 * "never" and "not since Tuesday" are the same operational problem.
 *
 * Here rather than in the pages that show it for two reasons. It is domain
 * logic - how long is too long is a property of the jobs, not of a layout - and
 * reading the clock inside a React render is impure, so a component that called
 * `Date.now()` in its body would be a lint error and, more to the point, a
 * component whose output depends on when it happened to re-render.
 */
export function isQuiet(run: JobRun | undefined, now = Date.now()): boolean {
	if (!run) return true;
	return now - run.startedAt.getTime() > QUIET_MS;
}

/** How many of the registered jobs have gone quiet. What the console's overview
 *  puts a number on. */
export function quietCount(last: Map<string, JobRun>): number {
	const now = Date.now();
	return JOBS.filter((job) => isQuiet(last.get(job.name), now)).length;
}

export async function recentRuns(limit = 50): Promise<JobRun[]> {
	return db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(limit);
}

/**
 * The last run of each job.
 *
 * What answers "is the scheduler still alive". A job whose last run was three
 * days ago is the wiki's "scheduler silence" alert, and it is invisible in a
 * flat list of recent runs - the noisy jobs fill the page and the silent one is
 * the one that has stopped.
 *
 * Through the query builder, not raw SQL. This was `db.execute<JobRun>(...)`,
 * and that type argument was a cast rather than a mapping: raw rows arrive with
 * the database's own column names and its own value types, so every row came
 * back with `started_at` and no `startedAt` at all. Nothing complained -
 * TypeScript had been told what the rows were - until `isQuiet` called
 * `.getTime()` on undefined and took the whole console page down with it. The
 * builder knows the schema, so the names and the Dates are real.
 */
export async function lastRunPerJob(): Promise<Map<string, JobRun>> {
	const rows = await db
		.selectDistinctOn([jobRuns.name])
		.from(jobRuns)
		.orderBy(jobRuns.name, desc(jobRuns.startedAt));

	return new Map(rows.map((row) => [row.name, row]));
}
