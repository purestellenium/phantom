import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { hcaAuthorizeUrl, hcaUsesPkce } from '$lib/server/auth/hca';
import {
	redirectWith,
	rememberStateInBrowser,
	safeRedirectPath,
	startOauthFlow
} from '$lib/server/auth/oauth';
import { recordEvent } from '$lib/server/analytics';
import { refuse } from '$lib/server/auth/authorize';
import { clientIpFrom, getSession, toIpPrefix } from '$lib/server/auth/session';
import { ConfigError, missingProviderVars, providerConfigured } from '$lib/server/env';
import { launchAllows } from '$lib/server/launch';
import { staging } from '$lib/server/staging';

/**
 * Begin a sign-in.
 *
 * Everything that can be decided without leaving our own origin is decided
 * here, before the browser is handed to HCA. That ordering is the point of the
 * route: a user who is going to be refused should be refused in one redirect,
 * not after a consent screen, a callback, and a token exchange.
 */

/** Where a sign-in lands when nothing else asked for somewhere specific. */
const SIGNED_IN_HOME = '/home';

export const GET: RequestHandler = async ({ request, url }) => {
	/* Staging mode has already signed this browser in (hooks.server.ts), so
	   there is no provider to send it to - straight on to where it was going. */
	if (staging) redirect(303, safeRedirectPath(url.searchParams.get('redirectTo'), SIGNED_IN_HOME));

	/* Fail closed and legibly when the provider is not set up. lib/env.ts is
     built so that the rest of the app runs without HCA credentials - this is
     the boundary where their absence becomes an error, and it names the
     variables rather than the values. */
	if (!providerConfigured('hca')) {
		/* The missing variable names go to the log, not to the browser. To a
       real operator this is the same information either way; to anyone
       else, the old response confirmed the route existed, named the
       provider, and listed exactly which secrets this deployment had not
       been given yet. Not found is what an unconfigured door looks like. */
		console.error(
			`[auth] hca is not configured. Missing: ${missingProviderVars('hca').join(', ')}`
		);
		return refuse();
	}

	/* The dashboard, not the front door. `/` forwards a signed-in visitor onward
     only when the launch gate would admit them, so a sign-in that defaulted
     here would either take an extra hop or - for anyone the gate refuses -
     finish the whole round trip and put the user back on the page they pressed
     the button on. Somebody who started from a deeper page still gets that
     page: the query parameter wins, and this is only what happens without
     one. */
	const redirectTo = safeRedirectPath(url.searchParams.get('redirectTo'), SIGNED_IN_HOME);

	/**
	 * The launch gate, evaluated here and never in the callback.
	 *
	 * The subtle part is what "here" can actually know. If the browser already
	 * carries a session, we know the user's role and can refuse immediately -
	 * which spares an ordinary participant being walked through the entire OAuth
	 * round trip only to have the freshly created session DELETED out from under
	 * them.
	 *
	 * If there is no session, we cannot know the role yet, and refusing would
	 * lock staff out of their own closed site: signing in is precisely how
	 * someone demonstrates they have bypass. So the flow proceeds, the callback
	 * creates a real session, and the gate is enforced on the pages - which is
	 * where it belongs. The session created by a login is never destroyed to
	 * enforce this.
	 */
	const session = getSession();
	if (session && !(await launchAllows(session.user, undefined, session.launched))) {
		return redirectWith('/', { closed: '1' });
	}

	try {
		/* Discovery happens before the state row is written, so an unreachable
       provider does not leave a trail of rows for flows that never started. */
		const usePkce = await hcaUsesPkce();

		const { state, codeChallenge } = await startOauthFlow({
			ipPrefix: toIpPrefix(clientIpFrom(request.headers)),
			provider: 'hca',
			usePkce,
			redirectTo
		});

		await rememberStateInBrowser('hca', state);

		/* The denominator. `hinted` says whether an address came from the landing
       field, which is the only thing that distinguishes the two ways in - it
       is a boolean about the request, not about the person. */
		recordEvent('signin.started', {
			hinted: Boolean(url.searchParams.get('email'))
		});

		const authorizeUrl = await hcaAuthorizeUrl({
			state,
			codeChallenge,
			/* Straight from the front page's form, which is a plain GET so it
         works with scripting off. Nothing is stored and nothing is trusted:
         hcaAuthorizeUrl drops it unless it is shaped like an address, and HCA
         decides on its own whether an account exists behind it. */
			email: url.searchParams.get('email')
		});

		/* 302, and Cache-Control on the way out. This response carries a Set-Cookie
       that is valid for exactly one flow; a proxy or a browser that cached it
       would hand the same state value to the next person through. */
		return new Response(null, {
			status: 302,
			headers: {
				location: authorizeUrl,
				'cache-control': 'no-store, no-cache, must-revalidate'
			}
		});
	} catch (error) {
		if (error instanceof ConfigError) {
			/* Same rule as the unconfigured branch above, and this one was the hole:
         a ConfigError's message names the variable and says what is wrong with
         it, which is the most useful sentence an operator could read and a free
         report to anyone else. It goes to the log; the caller gets nothing. */
			console.error(`[auth] hca start refused: ${error.message}`);
			return refuse();
		}

		/* Discovery failures and anything else upstream. Logged with detail for an
       operator, and reduced to a code for the user: the message can name hosts
       and configuration and does not belong in a query string. */
		console.error('hca sign-in could not start', error);
		return redirectWith('/', { auth_error: 'provider_unavailable' });
	}
};
