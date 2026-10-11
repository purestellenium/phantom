import type { RequestHandler } from './$types';

import { hackatimeAuthorizeUrl } from '$lib/server/auth/hackatime';
import {
	redirectWith,
	rememberStateInBrowser,
	safeRedirectPath,
	startOauthFlow
} from '$lib/server/auth/oauth';
import { refuse } from '$lib/server/auth/authorize';
import { clientIpFrom, getSession, toIpPrefix } from '$lib/server/auth/session';
import { ConfigError, missingProviderVars, providerConfigured } from '$lib/server/env';
import { canBypassLaunch, isLaunched } from '$lib/server/launch';
import { staging } from '$lib/server/staging';

/**
 * Begin linking a Hackatime account.
 *
 * Unlike the HCA start route, this one requires a session up front and refuses
 * without one - because this is not a way to sign in. There is a local user
 * already, and the whole flow exists to attach a second account to that
 * specific user. That is also why the session's id goes into the state row: the
 * callback checks it against the live session, so a link callback completed in
 * a different browser cannot attach the account to whoever happens to be signed
 * in there.
 */

export const GET: RequestHandler = async ({ request, url }) => {
	/* Staging mode links everybody already (lib/server/staging.ts), so there is
	   nothing to start: straight back to where the link was asked for. */
	if (staging) {
		return new Response(null, {
			status: 303,
			headers: { location: safeRedirectPath(url.searchParams.get('redirectTo'), '/home') }
		});
	}

	if (!providerConfigured('hackatime')) {
		/* The missing variable names go to the log, not to the browser. To a
       real operator this is the same information either way; to anyone
       else, the old response confirmed the route existed, named the
       provider, and listed exactly which secrets this deployment had not
       been given yet. Not found is what an unconfigured door looks like. */
		console.error(
			`[auth] hackatime is not configured. Missing: ${missingProviderVars('hackatime').join(', ')}`
		);
		return refuse();
	}

	const session = getSession();
	if (!session) {
		/* No session, no link. Sent to the front door rather than into an HCA
       login, because bouncing through two providers to complete an action the
       user started from a page they can no longer see is disorienting. */
		return redirectWith('/', { auth_error: 'signin_required' });
	}

	/* The launch gate applies here in full, and can be applied here in full,
     because unlike sign-in we already know exactly who this is. A closed site
     does not link accounts for participants. */
	if (!(await isLaunched()) && !canBypassLaunch(session.user)) {
		return redirectWith('/', { closed: '1' });
	}

	const redirectTo = safeRedirectPath(url.searchParams.get('redirectTo'), '/home');

	try {
		/* Always true for Hackatime. See the note in lib/auth/hackatime.ts: PKCE
       support here is proven, so there is nothing to negotiate and no reason to
       run a flow whose authorization code stands alone. */
		const { state, codeChallenge } = await startOauthFlow({
			ipPrefix: toIpPrefix(clientIpFrom(request.headers)),
			provider: 'hackatime',
			usePkce: true,
			userId: session.user.id,
			redirectTo
		});

		if (!codeChallenge) {
			/* Unreachable while `usePkce` is true, and an explicit refusal rather
         than a non-null assertion: if this ever does happen it means the flow
         helper changed shape, and silently linking without PKCE would be the
         wrong way to find that out. */
			throw new Error('Hackatime flow started without a PKCE challenge.');
		}

		await rememberStateInBrowser('hackatime', state);

		return new Response(null, {
			status: 302,
			headers: {
				location: await hackatimeAuthorizeUrl({ state, codeChallenge }),
				'cache-control': 'no-store, no-cache, must-revalidate'
			}
		});
	} catch (error) {
		if (error instanceof ConfigError) {
			/* Same rule as the unconfigured branch above, and this one was the hole:
         a ConfigError's message names the variable and says what is wrong with
         it, which is the most useful sentence an operator could read and a free
         report to anyone else. It goes to the log; the caller gets nothing. */
			console.error(`[auth] hackatime start refused: ${error.message}`);
			return refuse();
		}

		console.error('hackatime link could not start', error);
		return redirectWith(redirectTo, { link_error: 'provider_unavailable' });
	}
};
