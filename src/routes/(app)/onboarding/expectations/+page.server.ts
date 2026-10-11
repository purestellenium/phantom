import { dev } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { getLinkedHackatime } from '$lib/server/auth/hackatime';
import { requireUser } from '$lib/server/auth/session';

/**
 * What a project is held to, read before the last step.
 *
 * The acknowledgement itself is client-side - a checkbox that unlocks "next"
 * (see the page). Nothing is written here: understanding the bar is not a
 * database fact, and the bar is actually enforced at review, not at sign-up.
 * This load only keeps the step in its place in the order.
 */
export const load: PageServerLoad = async ({ url }) => {
	const user = requireUser();
	const preview = dev && url.searchParams.has('preview');

	if (user.onboardedAt && !preview) redirect(303, '/home');

	/* Reached only after setup, so Hackatime is the standing requirement -
	   someone who has not linked it is sent back to the step that does. A preview
	   shows the page regardless, since it is here to be looked at. */
	if (!preview && !(await getLinkedHackatime(user.id))) redirect(303, '/onboarding/setup');

	return { preview };
};
