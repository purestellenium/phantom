import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { requireUser } from '$lib/server/auth/session';
import { findGuide } from '$lib/server/guides';

/** One guide, rendered, with the guides either side of it for the pager. */
export const load: PageServerLoad = ({ params }) => {
	requireUser();
	const found = findGuide(params.slug);
	if (!found) error(404, 'there is no guide by that name');
	return found;
};
