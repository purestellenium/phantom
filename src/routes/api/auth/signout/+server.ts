import type { RequestHandler } from './$types';

import { recordEvent } from '$lib/server/analytics';
import { redirectWith } from '$lib/server/auth/oauth';
import { signOutCurrent } from '$lib/server/auth/session';

/**
 * Sign out.
 *
 * POST only, and that is the whole reason this is not a link. A GET that
 * destroys state can be triggered by anything that fetches a URL - a prefetch,
 * an image tag on another site, a link-preview bot in a chat client - and the
 * result is users being signed out by pages they merely visited. A form post
 * cannot be provoked that way, and the session cookie's SameSite=Lax means a
 * cross-site POST arrives without it and so has nothing to end.
 *
 * ## What this does not do
 *
 * It does not revoke the tokens held at HCA or Hackatime. Hack Club Auth
 * documents no client-callable revocation endpoint, so there is nothing to call
 * - the stored access token stays valid upstream until it expires, which for
 * HCA is six months, or until the user revokes the grant through HCA's own
 * interface.
 *
 * That is a real limitation and it is written down here rather than left to be
 * discovered, because the applications this one is modelled on have the same
 * behaviour and do not mention it, which is how "sign out" comes to be read as
 * "disconnect" by everyone including the people maintaining it. Ending a
 * session on a shared machine works exactly as expected; taking away an
 * application's access to an account is a different action in a different
 * place.
 */

export const POST: RequestHandler = async () => {
	/* Revokes the row and clears the cookie, and clears the cookie even when no
     row was found - so a stale or forged value does not survive a sign-out and
     go on producing a database lookup on every later request. */
	await signOutCurrent();

	/* 303, not 302. The browser must follow this with a GET; a 302 after a POST
     is permitted to repeat the method, and a reload of the destination would
     then re-post the sign-out. */
	recordEvent('signout');
	return redirectWith('/', { signed_out: '1' }, 303);
};
