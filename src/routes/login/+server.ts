import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getSession } from '$lib/server/auth/session';
import { canBypassLaunch, isLaunched } from '$lib/server/launch';

/**
 * The staff door while the site is closed.
 *
 * The landing page offers nothing but the waiting list before launch; this
 * path, reached by typing it, is the one way in. It sends the visitor through
 * Hack Club and back here, and here is where the answer is given: staff go on
 * to the dashboard, anyone else gets a 403 and nothing more. Once the site is
 * open it is simply the sign-in link.
 */
export const GET: RequestHandler = async () => {
	if (await isLaunched()) redirect(303, '/api/auth/hca/start');

	const session = getSession();
	if (!session) redirect(303, '/api/auth/hca/start?redirectTo=/login');
	if (canBypassLaunch(session.user)) redirect(303, '/home');
	error(403, 'not for you');
};
