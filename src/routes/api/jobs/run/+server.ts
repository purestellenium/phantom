import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { safeEqual } from '$lib/server/crypto';
import { refuse } from '$lib/server/auth/authorize';
import { JOBS, runJob } from '$lib/server/jobs';
import { cronSecret } from '$lib/server/env';
import type { JsonObject } from '$lib/json';

/**
 * The one way a scheduled job is invoked.
 *
 * There is no timer anywhere in this application. Something outside it - a
 * platform cron, a scheduler, a person with curl - calls here, and the advisory
 * lock in $lib/server/jobs.ts makes concurrent invocations safe. That is the shape the
 * platform baseline asks for: "one authenticated scheduler endpoint backed by
 * database idempotency", rather than an interval started in every web replica.
 *
 *   curl -H "authorization: Bearer $CRON_SECRET" \
 *        "https://…/api/jobs/run?job=outbox.dispatch"
 *
 * Omit `job` to run all of them.
 *
 * The name is a query parameter, which is NOT a contradiction of the rule two
 * paragraphs down: that rule is about the credential, and a job name is not a
 * secret - it is already printed in the console and in this comment. It is the
 * only place the name can go. A scheduled invocation is a GET with no body, so
 * a body would mean the scheduler and a person had two different ways to say
 * one thing.
 *
 * GET and POST are therefore the same call, exported twice rather than written
 * twice.
 */

/* Never prerendered. A prerendered response here would be a job that appears
   to run and does not - which matters more for GET than for POST, because GET
   is the verb the platform's scheduler uses. The no-store header below is the
   same rule for every cache in between. */
export const prerender = false;

/**
 * Read the bearer token, or null.
 *
 * Only the `Authorization` header. Deliberately not a query parameter, which
 * would put the credential in every access log, every referrer and the operator's
 * shell history - and the wiki's telemetry boundary names query strings
 * specifically as a place secrets should not end up.
 */
function bearer(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const [scheme, ...rest] = header.split(' ');
	if (scheme.toLowerCase() !== 'bearer') return null;
	const value = rest.join(' ').trim();
	return value || null;
}

const run: RequestHandler = async ({ request, url }) => {
	const expected = cronSecret();

	/* Not configured means DISABLED, never open - the wiki's rule, and this is
     the deployment where a forgotten variable would otherwise leave the job
     runner briefly reachable by anyone who guesses the path. */
	if (!expected) {
		/* Server-side, because an operator debugging a scheduler that has gone
       silent genuinely needs this and an attacker must not have it. A 503
       saying "not configured" is an advertisement: it confirms the path is
       real, that it is a job runner, and that it is worth trying again after
       the next deploy. */
		console.error('[jobs] refused: CRON_SECRET is not set, so /api/jobs/run is disabled');
		return refuse();
	}

	const presented = bearer(request);
	if (!presented || !safeEqual(presented, expected)) {
		/* One answer for every way of being wrong: no token, malformed token, wrong
       token, and - above - an endpoint that is switched off entirely. Telling
       them apart is how an attacker learns which half of the problem to work
       on. */
		return refuse();
	}

	/* Absent means all of them, which is what an unattended catch-up wants. An
     unrecognised name is not rejected here - runJob answers it with `unknown`,
     so a scheduler entry pointing at a job that has been renamed says so in its
     own response rather than in a 400 nobody reads. */
	const requested = url.searchParams.get('job');
	const names = requested ? [requested] : JOBS.map((job) => job.name);

	/* Sequential. These share one small database, and the reconciliation job in
     particular is a set of aggregate scans - running them in parallel to save a
     second on something a scheduler calls unattended is the wrong trade. */
	/** What one job's turn produced, as the response reports it. */
	type JobReport =
		| { job: string; status: string; result: JsonObject | null; error: string | null }
		| { job: string; status: string; message: string };

	const results: JobReport[] = [];
	for (const name of names) {
		/* triggeredBy is null: this is the scheduler, and the column exists to tell
       an unattended run apart from an operator pressing the button. */
		const outcome = await runJob(name, null);
		results.push(
			outcome.ok
				? {
						job: name,
						status: outcome.run.status,
						result: outcome.run.result,
						error: outcome.run.error
					}
				: { job: name, status: outcome.reason, message: outcome.message }
		);
	}

	/* 200 even when a job failed. The HTTP status answers "did the endpoint
     work"; the body answers "did the jobs". A scheduler that retries on non-2xx
     would otherwise re-run every job in the list because one of them found a
     discrepancy. */
	return json({ ran: results }, { headers: { 'cache-control': 'no-store' } });
};

export const GET = run;
export const POST = run;
