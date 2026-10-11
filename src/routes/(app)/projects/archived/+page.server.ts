import type { PageServerLoad } from './$types';

import { requireOnboarded } from '$lib/server/auth/session';
import { projectsPage } from '$lib/server/projects/pages';

/**
 * The projects someone has put away - see `archiveProject`. Off their projects
 * page and out of "logged" on home, and kept here so they are never lost: each
 * one opens its own page, where it can be brought back.
 *
 * One page of them. Archiving is for the few that went nowhere, not a filing
 * system, so this does not scroll on.
 */
export const load: PageServerLoad = async () => {
	const user = requireOnboarded();
	return projectsPage(user.id, 0, 'archived');
};
