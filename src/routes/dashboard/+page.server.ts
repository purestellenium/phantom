import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Where the home page used to live.
 *
 * The route moved to /home when the tab did, and this is the forwarding
 * address: the old path is in bookmarks, and it was the default `redirectTo`
 * of both OAuth flows, so a sign-in that was already in the air when the route
 * moved comes back to it. Permanent rather than 303 - the page did move, and
 * nothing is going to move back.
 *
 * Outside the (app) group on purpose. A redirect has nothing to load, and the
 * group's gates would make it fetch a session to decide where to send somebody
 * it is sending to a gated page anyway.
 */
export const load: PageServerLoad = () => redirect(308, '/home');
