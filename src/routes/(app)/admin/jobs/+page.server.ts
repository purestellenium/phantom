import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordAudit } from '$lib/server/audit';
import { requireCapability } from '$lib/server/auth/authorize';
import { cronSecret } from '$lib/server/env';
import { JOBS, isQuiet, lastRunPerJob, recentRuns, runJob } from '$lib/server/jobs';

/**
 * What runs on a schedule, when it last did, and how to make it.
 *
 * The page exists mostly to make scheduler silence visible. A job that has
 * quietly stopped being invoked looks exactly like a job with nothing to do, and
 * the only way to tell them apart is that a run leaves a row - which is why
 * `job_runs` records every attempt including the empty ones.
 */
export const load: PageServerLoad = async () => {
	requireCapability('run_jobs');

	const [last, runs] = await Promise.all([lastRunPerJob(), recentRuns(40)]);

	return {
		configured: cronSecret() !== null,
		jobs: JOBS.map((job) => {
			const run = last.get(job.name);
			return {
				name: job.name,
				description: job.description,
				quiet: isQuiet(run),
				last: run ? { startedAt: run.startedAt, status: run.status } : null
			};
		}),
		runs
	};
};

/**
 * Running a job by hand.
 *
 * The same `runJob` the scheduler endpoint calls, with one difference: the
 * actor's id goes into `job_runs.triggered_by`. That column is the reason this
 * is not just a convenience - a run that appears in the log at an odd hour is
 * either the scheduler misbehaving or a person, and telling them apart without
 * asking is the difference between an incident and a Tuesday.
 *
 * The advisory lock does the rest. Pressing the button while the scheduler is
 * mid-run returns "already running" rather than starting a second copy.
 */
export const actions: Actions = {
	run: async ({ request }) => {
		const actor = requireCapability('run_jobs');
		const form = await request.formData();
		const name = String(form.get('job') ?? '');

		const outcome = await runJob(name, actor.id);
		if (!outcome.ok) return fail(400, { error: outcome.message });

		await recordAudit({
			action: 'job.run',
			actorId: actor.id,
			metadata: { job: name, status: outcome.run.status, result: outcome.run.result }
		});

		redirect(303, '/admin/jobs');
	}
};
