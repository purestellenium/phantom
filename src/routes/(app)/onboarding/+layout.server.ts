import type { LayoutServerLoad } from './$types';

import { requireUser } from '$lib/server/auth/session';

/**
 * The onboarding wizard's shared frame.
 *
 * `requireUser`, not `requireOnboarded` - this whole subtree is the place
 * `requireOnboarded` sends people, so gating it on being onboarded would be a
 * loop. The session and launch gates are already applied by hooks.server.ts,
 * which keys on the `/(app)` route group these pages still physically live in;
 * only the CHROME is broken out (see +layout@.svelte), not the protection.
 *
 * The dev `?preview` flag each step reads for its own redirect guards is
 * computed in the page loads, not here - a layout load runs alongside its
 * pages rather than before them, so a step cannot lean on this for a decision
 * it makes itself.
 */
export const load: LayoutServerLoad = () => {
	requireUser();
	return {};
};
