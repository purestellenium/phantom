import type { PageServerLoad } from './$types';

import { pageWindow, splitPage } from '$lib/paging';
import { requireCapability } from '$lib/server/auth/authorize';
import { projectStatusCounts, searchProjects } from '$lib/server/projects/projects';

/**
 * Every project, including the ones nothing else can see.
 *
 * The gap this fills: a project with no submissions appeared on exactly one
 * screen in the whole application - its owner's own list. The review queue is
 * built from open submissions, explore from approved ones, and the console had
 * no projects section at all, so a draft was reachable only by somebody who
 * already knew its number. "How many people have started something and not
 * shipped it" was not a question anyone could ask.
 *
 * Gated on `view_audit`, the same capability the reviewer board uses and for
 * the same reason: a read-only oversight surface over what participants and
 * reviewers have done, mutating nothing. Deliberately NOT `review_submissions`
 * - that one is not in CONSOLE_CAPABILITIES, so a page gated on it would sit
 * inside a console layout that refuses the same reader. Reviewers have /review;
 * this is the console's view of the same material.
 *
 * The search is a GET form, so a result set is a URL somebody can send.
 */

/** The filter tabs, in the order an operator works through them. `all` is not a
 *  status but the absence of one, which is why it is written here rather than
 *  in `ProjectStatus`. */
const TABS = [
	{ value: '', label: 'all', key: 'all' },
	{ value: 'draft', label: 'drafts', key: 'draft' },
	{ value: 'review', label: 'in review', key: 'review' },
	{ value: 'approved', label: 'approved', key: 'approved' },
	{ value: 'rejected', label: 'rejected', key: 'rejected' }
] as const;

/**
 * Rows per page.
 *
 * Fifty rather than the card grid's eighteen: these are single-line rows, and
 * eighteen of them is a short page with a screen of nothing under it. Fifty
 * fills a tall window and still bounds both the query and the document.
 */
const PER_PAGE = 50;

/** `?page=` as a 1-based page number. Anything that is not one - a word, a
 *  negative, a decimal, an absent parameter - is page one, for the same reason
 *  an unrecognised `status` is "all": this is a URL people edit and send. */
function parsePage(raw: string | null): number {
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

export const load: PageServerLoad = async ({ url }) => {
	requireCapability('view_audit');

	const term = url.searchParams.get('q')?.trim() || null;
	/* Unvalidated on purpose: `searchProjects` treats anything it does not
	   recognise as "all", so a stale or mistyped bookmark shows everything
	   rather than erroring. `status` comes back out so the tabs can mark
	   themselves without re-reading the URL on the client. */
	const status = url.searchParams.get('status') || null;
	const page = parsePage(url.searchParams.get('page'));

	const [window, counts] = await Promise.all([
		/* One row more than the page draws - that extra row IS "is there a next
		   page", and it costs nothing next to the second `count(*)` the honest
		   alternative would need. See lib/paging.ts. */
		searchProjects({ term, status, ...pageWindow((page - 1) * PER_PAGE, PER_PAGE) }),
		projectStatusCounts()
	]);
	const { rows, more } = splitPage(window, PER_PAGE);

	return {
		term,
		status,
		page,
		rows,
		more,
		/* Where this page starts in the list, so the rows can be numbered from
		   something other than one and "51-100 of 112" is sayable. */
		offset: (page - 1) * PER_PAGE,
		tabs: TABS.map((tab) => ({ value: tab.value, label: tab.label, count: counts[tab.key] }))
	};
};
