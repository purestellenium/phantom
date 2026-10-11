import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { requireOnboarded } from '$lib/server/auth/session';
import { projectsPage } from '$lib/server/projects/pages';

/**
 * Pages two and beyond of your own projects grid.
 *
 * The user id comes from the SESSION and never from the query string, which is
 * the only thing keeping this from being a way to read somebody else's
 * projects. An `?user=` parameter here would be an authorisation bug wearing a
 * pagination costume - the page it feeds shows one person their own work, and
 * the endpoint behind it has to be incapable of doing anything else.
 */
export const GET: RequestHandler = async ({ url }) => {
	const user = requireOnboarded();

	const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset')) || 0));

	return json(await projectsPage(user.id, offset));
};
