import { dev } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { requireUser } from '$lib/server/auth/session';

/**
 * The welcome step: orientation, no input.
 *
 * The only guard it needs is the first-time-only one. `finish` and its
 * preconditions live on the last step, where the button that fires them is -
 * this page has nothing to POST.
 */
export const load: PageServerLoad = ({ url }) => {
	const user = requireUser();
	const preview = dev && url.searchParams.has('preview');

	/* Already done, and not looking on purpose: out to the home they have
	   unlocked. The preview flag is the one thing that holds them here, and only
	   in a dev build. */
	if (user.onboardedAt && !preview) redirect(303, '/home');

	return { preview };
};
