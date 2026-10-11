import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordEvent } from '$lib/server/analytics';
import { requireOnboarded } from '$lib/server/auth/session';
import { PROJECT_ERROR_STEP, readFlow } from '$lib/server/projects/flow';
import { projectsPage } from '$lib/server/projects/pages';
import { archivedCount, createProject, ProjectError } from '$lib/server/projects/projects';

/**
 * A participant's projects, and the fullscreen flow that starts one.
 *
 * The figure on each project is the time Hackatime has tracked for it - see
 * projectsPage. It replaced the latest submission's state, which the project's
 * own page still shows.
 */
export const load: PageServerLoad = async () => {
	const user = requireOnboarded();
	/* One screenful; /api/projects serves the rest as the reader scrolls. The
	   query and the badge lookup both live in projectsPage so this page and that
	   endpoint cannot disagree about what a card is. */
	const [page, archived] = await Promise.all([projectsPage(user.id, 0), archivedCount(user.id)]);
	/* Archived projects are off this grid; the count is for the way to them. */
	return { ...page, archived };
};

export const actions: Actions = {
	create: async ({ request }) => {
		const user = requireOnboarded();
		const read = readFlow(await request.formData());
		if (!read.ok) return fail(400, { error: read.error, step: read.step, values: read.values });

		let number: number;
		try {
			number = (await createProject(user.id, read.draft)).number;
		} catch (error) {
			if (error instanceof ProjectError) {
				return fail(400, { error: error.message, step: PROJECT_ERROR_STEP, values: read.values });
			}
			throw error;
		}
		recordEvent('project.created', { kind: read.draft.kind, where: 'projects' });
		redirect(303, `/projects/${number}`);
	}
};
