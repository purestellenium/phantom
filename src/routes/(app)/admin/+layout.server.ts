import type { LayoutServerLoad } from './$types';

import { CONSOLE_CAPABILITIES, requireAnyCapability } from '$lib/server/auth/authorize';

/**
 * The console's own gate.
 *
 * It refuses anyone with no operator capability at all, which keeps the whole
 * subtree off the map for ordinary participants. What it explicitly DOES NOT
 * do is authorise anything specific: a layout cannot know which page is being
 * rendered - and its load runs alongside the page's rather than before it - so
 * a gate here could only ever check the weakest condition that covers every
 * child.
 *
 * So every page below calls `requireCapability` for the thing it actually
 * shows, and every action calls it again for the thing it actually does. This
 * is the outermost of three checks and the least important of them: a
 * convenience that stops the console appearing to exist for people it does not
 * exist for.
 */
export const load: LayoutServerLoad = () => {
	requireAnyCapability(CONSOLE_CAPABILITIES);
	return {};
};
