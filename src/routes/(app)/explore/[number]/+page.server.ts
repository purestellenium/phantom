import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordEvent } from '$lib/server/analytics';
import { can } from '$lib/server/auth/authorize';
import { requireOnboarded } from '$lib/server/auth/session';
import { approvedShips, showcaseByNumber } from '$lib/server/projects/showcase';
import { hasUpvoted, setUpvote } from '$lib/server/projects/upvotes';

/**
 * One project on explore: what everybody signed in can see about it.
 *
 * Read from the showcase projection, like the gallery, so it shows the project
 * as it was approved rather than its owner's working copy - and nothing about
 * it that the gallery does not already show: no email, no real name, the
 * author by Slack handle. A project that is not on explore is the same 404 as
 * a number nobody has used.
 */

function parseNumber(raw: string): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export const load: PageServerLoad = async ({ params }) => {
	const user = requireOnboarded();
	const number = parseNumber(params.number);
	const project = number === null ? null : await showcaseByNumber(number);
	if (!project) error(404);

	const isOwner = project.ownerId === user.id;
	return {
		project: {
			number: project.number,
			name: project.name,
			description: project.description,
			screenshotUrl: project.screenshotUrl,
			demoUrl: project.demoUrl,
			repoUrl: project.repoUrl,
			kind: project.kind,
			authorUsername: project.authorUsername,
			totalApprovedSeconds: project.totalApprovedSeconds,
			upvotes: project.upvotes,
			ships: await approvedShips(project.projectId),
			hyperChroma: project.hyperChroma,
			approvedAt: project.updatedAt
		},
		isOwner,
		/* Staff who can open anyone's project page (the same check /projects/[n]
		   makes) get a way across to it: the working copy and the full history,
		   which explore deliberately leaves out. */
		canOpenProject: can(user, 'review_submissions'),
		upvoted: isOwner ? false : await hasUpvoted(user.id, project.projectId)
	};
};

export const actions: Actions = {
	/* `up=1` to upvote, anything else to take it back - stated rather than
	   toggled, so a double-submitted form lands where it was meant to. */
	upvote: async ({ params, request }) => {
		const user = requireOnboarded();
		const number = parseNumber(params.number);
		if (number === null) return fail(404, { error: 'That project is not on explore.' });
		const form = await request.formData();
		const result = await setUpvote({ user, projectNumber: number, up: form.get('up') === '1' });
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.upvoted', { up: result.upvoted, where: 'page' });
		return { upvoted: result.upvoted };
	}
};
