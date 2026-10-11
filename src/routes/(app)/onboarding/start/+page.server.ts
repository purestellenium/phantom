import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordEvent } from '$lib/server/analytics';
import { getLinkedHackatime } from '$lib/server/auth/hackatime';
import { requireUser } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import { completeOnboarding } from '$lib/server/onboarding';
import { PROJECT_ERROR_STEP, readFlow } from '$lib/server/projects/flow';
import { createProject, ProjectError } from '$lib/server/projects/projects';
import { qualifyReferral } from '$lib/server/referrals';

/**
 * The last step: your first project, starting from the idea.
 *
 * The step exists because someone who leaves setup with a project of their own
 * has a reason to come back, and someone who leaves with "make a project" as
 * one card among several mostly does not. So the step IS making one - an idea,
 * then a name - and finishing setup and creating it are one press. There is
 * no skipping it: setup is not finished until the account has a project. (It
 * used to allow a skip, made to feel like the lesser choice; every account
 * leaving setup with a project of its own is the point, so now it is the
 * only way out.)
 *
 * The same screens as the projects page's new-project flow (ProjectSteps), so
 * the first project is made exactly the way every later one is - and read by
 * the same rules (readFlow). The links screen is optional there and here: at
 * the moment somebody has only just thought of what to make, most of it
 * describes work that does not exist yet.
 */
export const load: PageServerLoad = async ({ url }) => {
	const user = requireUser();
	const preview = dev && url.searchParams.has('preview');

	if (user.onboardedAt && !preview) redirect(303, '/home');

	/* Cannot finish without the requirement. A real run that reaches here without
	   Hackatime linked is sent back to the step that links it; a preview shows
	   the screen regardless, since it is here to be looked at. */
	if (!preview && !(await getLinkedHackatime(user.id))) {
		redirect(303, '/onboarding/setup');
	}

	return { preview };
};

/**
 * Finishing - the one mutation the wizard owns, and one way through it: with a
 * project. Every precondition is re-checked here: a form action is a POST
 * endpoint reachable with no page in front of it, so the rule is the code, not
 * the button's absence elsewhere - which is also why a `where=skip` posted by
 * an old tab or by hand is simply read as a project that is missing its
 * fields, and refused like one.
 */
export const actions: Actions = {
	finish: async ({ request, url }) => {
		const user = requireUser();
		const preview = dev && url.searchParams.has('preview');

		const form = await request.formData();
		const read = readFlow(form);
		if (!read.ok) return fail(400, { error: read.error, step: read.step, values: read.values });
		const { draft, values } = read;

		/**
		 * A preview never touches the finish - it exists to look at these screens
		 * from an account that has already finished, and re-stamping would move
		 * the record of when they actually did.
		 *
		 * It DOES create the project, though, because that is the thing on this
		 * step worth testing, and a preview that silently made nothing read as a
		 * broken button. Dev builds only (see `preview`), so the row it makes is a
		 * developer's own project on a development database.
		 */
		if (preview) {
			let number: number;
			try {
				number = (await createProject(user.id, draft)).number;
			} catch (error) {
				if (error instanceof ProjectError) {
					return fail(400, { error: error.message, step: PROJECT_ERROR_STEP, values });
				}
				throw error;
			}
			redirect(303, `/projects/${number}`);
		}

		/* Already done: idempotent, not an error. A double submit or a second tab
		   lands somewhere sensible rather than making a second first project. */
		if (user.onboardedAt) redirect(303, '/projects');

		/* Hackatime is the requirement - nothing to count hours against without
		   it, so an account cannot be marked ready lacking one. */
		const hackatime = await getLinkedHackatime(user.id);
		if (!hackatime) redirect(303, '/onboarding/setup');

		/**
		 * One transaction: setup is done and the project exists, or neither.
		 *
		 * The finish goes first because it is the guard. `completeOnboarding`
		 * only stamps an account that is not already stamped, so of two
		 * concurrent submits the second waits on the first's row lock, then finds
		 * nothing to update and creates nothing - one first project, not two. And
		 * a project that is refused rolls the finish back with it, so the person
		 * is still in setup and still looking at the screen that says what went
		 * wrong.
		 */
		let outcome: { completed: boolean; number: number | null };
		try {
			outcome = await db.transaction(async (tx) => {
				const done = await completeOnboarding(
					{ userId: user.id, hackatimeAccountId: hackatime.accountId },
					tx
				);
				if (!done) return { completed: false, number: null };
				const project = await createProject(user.id, draft, tx);
				return { completed: true, number: project.number };
			});
		} catch (error) {
			if (error instanceof ProjectError) {
				return fail(400, { error: error.message, step: PROJECT_ERROR_STEP, values });
			}
			throw error;
		}

		if (outcome.completed) {
			/* Always true now there is no skip; kept so the event's shape - and
			   anything already counting it - does not change. */
			recordEvent('onboarding.finished', { project: true });
			recordEvent('project.created', { kind: draft.kind, where: 'onboarding' });
			/* Finishing may be what makes somebody an inviter's referral. */
			await qualifyReferral(user.id);
		}

		/* A redirect, so the shell's nav - drawn from onboardedAt - is rebuilt
		   fresh rather than reused across the change. Straight to the project,
		   which is where the next thing to do is. */
		redirect(303, outcome.number !== null ? `/projects/${outcome.number}` : '/projects');
	}
};
