import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { requireOnboarded } from '$lib/server/auth/session';
import { showcasePage } from '$lib/server/projects/pages';
import { readExploreFilters } from '$lib/explore/filters';

/**
 * Pages two and beyond of the explore grid.
 *
 * The first page comes from explore's own load, so this is only ever reached by
 * a reader who has scrolled - which is exactly the point of it existing.
 *
 * `requireOnboarded()` first, and not as a formality. An endpoint that serves
 * the same rows a page serves must be guarded the same way the page is, or the
 * pagination becomes a hole straight through the check the page performs: the
 * gallery is for signed-in participants, and "signed in" cannot be true of the
 * page and untested of the endpoint behind it.
 */
export const GET: RequestHandler = async ({ url }) => {
	const user = requireOnboarded();

	/* Anything unreadable is offset zero. A hand-edited query string is not worth
	   a 400 here - the worst a bad offset can do is serve the first page again,
	   and Number('') is 0 while Number('abc') is NaN, which `|| 0` folds to the
	   same harmless answer. */
	const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset')) || 0));

	/* The same filters the page was loaded with, so page two continues page
	   one's list rather than the unfiltered gallery's. */
	return json(await showcasePage(offset, readExploreFilters(url.searchParams), user.id));
};
