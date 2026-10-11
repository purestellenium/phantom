import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * The profile picture maker lives on pfp.hackclub.com now; the old link still
 * works by sending every visit there.
 *
 * 302, not 301. A permanent redirect is cached by browsers with no way to take
 * it back, and this one may well change again.
 */
export const GET: RequestHandler = () => {
	redirect(302, 'https://pfp.hackclub.com/c/phantom/phantom-1');
};
