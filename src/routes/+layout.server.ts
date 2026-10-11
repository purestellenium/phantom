import type { LayoutServerLoad } from './$types';

import { analyticsConfig } from '$lib/server/analytics';

/**
 * The one thing every page needs from the server: whether analytics are on,
 * and the visitor's segment (lib/analytics/shared.ts). Reads only what the
 * session hook already resolved - no query - so it costs nothing per request.
 * A form action that changes the segment (finishing onboarding) reruns it with
 * the invalidation every action already triggers.
 */
export const load: LayoutServerLoad = ({ locals, url }) => ({
	analytics: analyticsConfig(url.hostname, locals.session?.user)
});
