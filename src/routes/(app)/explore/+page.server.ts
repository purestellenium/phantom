import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordEvent } from '$lib/server/analytics';
import { requireOnboarded } from '$lib/server/auth/session';
import { hyperChromaCards, showcasePage } from '$lib/server/projects/pages';
import { setUpvote } from '$lib/server/projects/upvotes';
import { readExploreFilters } from '$lib/explore/filters';

/** The public-ish gallery of approved projects, read from the showcase
 *  projection rather than the live tables - so it is cheap and shows each project
 *  as it was when approved.
 *
 *  One screenful, not the whole gallery. The rest arrives from /api/showcase as
 *  the reader scrolls; the query was never the expensive part, the sixty cards
 *  and sixty screenshots it returned were. See $lib/paging.ts. */
export const load: PageServerLoad = async ({ url }) => {
	const user = requireOnboarded();
	const filters = readExploreFilters(url.searchParams);
	/* The hyper-chroma panel rides with the first page only: it sits above the
	   grid, so /api/showcase, which serves the pages after, never needs it. */
	const [page, featured] = await Promise.all([
		showcasePage(0, filters, user.id),
		hyperChromaCards(user.id)
	]);
	return { ...page, featured, filters };
};

export const actions: Actions = {
	/* The upvote on a card - the same rule as the project's own page (see
	   projects/upvotes.ts). `up=1` to upvote, anything else to take it back,
	   stated rather than toggled so a double-submit lands where it meant to. */
	upvote: async ({ request }) => {
		const user = requireOnboarded();
		const form = await request.formData();
		const number = Number(form.get('number'));
		if (!Number.isInteger(number) || number <= 0) {
			return fail(404, { error: 'That project is not on explore.' });
		}
		const result = await setUpvote({ user, projectNumber: number, up: form.get('up') === '1' });
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('project.upvoted', { up: result.upvoted, where: 'grid' });
		return { upvoted: result.upvoted };
	}
};
