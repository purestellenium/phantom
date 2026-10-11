import type { LayoutServerLoad } from './$types';

import { isOperator } from '$lib/server/auth/authorize';
import { requireUser } from '$lib/server/auth/session';

/**
 * The signed-in shell's data: what the nav needs and nothing else.
 *
 * The gates - a session, and the launch switch - are not here. A layout's load
 * runs alongside its pages' loads rather than before them, so they live in
 * hooks.server.ts, keyed on this route group. By the time this runs the hook
 * has already turned an anonymous or refused visitor away.
 */
export const load: LayoutServerLoad = () => {
	const user = requireUser();

	/* The account tab is the person: first name and the Slack picture. */
	const first = (user.displayName ?? user.email.split('@')[0]).trim().split(/\s+/)[0].toLowerCase();

	return {
		onboarded: user.onboardedAt !== null,
		me: { avatarUrl: user.avatarUrl, handle: first },
		/* Whether the console link is drawn, and nothing more. Every page under
		   /admin calls requireCapability for itself - see $lib/server/auth/authorize.ts -
		   so this is presentation rather than a gate. */
		operator: isOperator(user)
	};
};
