import type { RequestHandler } from './$types';

import { recordEvent } from '$lib/server/analytics';
import { recordAudit } from '$lib/server/audit';
import {
	exchangeHackatimeCode,
	fetchHackatimeAccount,
	HackatimeError,
	linkHackatimeAccount
} from '$lib/server/auth/hackatime';
import {
	browserStartedFlow,
	consumeOauthState,
	describeStateMismatch,
	forgetStateInBrowser,
	redirectWith,
	safeRedirectPath
} from '$lib/server/auth/oauth';
import { getSession } from '$lib/server/auth/session';

/**
 * The Hackatime link callback.
 *
 * The same shape as the sign-in callback - a run of refusals, then one commit -
 * but with an extra check that sign-in cannot have: there is already a local
 * user, so this route must prove the callback belongs to *them*.
 *
 * That proof is three separate things, and dropping any one of them opens a
 * different hole. The browser cookie says this is the tab that started the
 * flow. The state row says the flow is ours and has not been spent. And the
 * flow's `userId` checked against the live session says the person finishing it
 * is the person who began it - without which, a link callback opened in a
 * browser where somebody else is signed in attaches the Hackatime account to
 * whoever that happens to be.
 *
 * Nothing here is a sign-in. A failure sends the user back to a page they are
 * already entitled to see, never into an HCA login.
 */

/** Short codes the onboarding and account pages turn into a sentence. The
 *  detail goes to the server log; a query string is not a place for provider
 *  error prose. */
type Failure =
	| 'denied'
	| 'bad_state'
	| 'expired'
	| 'wrong_user'
	| 'already_linked'
	| 'locked'
	| 'provider_error';

export const GET: RequestHandler = async ({ url }) => {
	const params = url.searchParams;

	/* Where to land on the way out. Resolved before anything can fail so that
     every exit below goes somewhere sensible, and defaulted to onboarding
     because that is the only place linking is compulsory - someone who was
     linking from the account page is simply sent back a step further than they
     started, which is harmless. */
	const fallback = '/onboarding';

	const session = getSession();
	if (!session) {
		/* The session expired while the user was away at Hackatime. The state row
       is left to expire on its own: consuming it would need a user to attribute
       the link to, and there is none. */
		return redirectWith('/', { auth_error: 'signin_required' });
	}

	/* The user pressed "no" on Hackatime's consent screen, or Hackatime refused
     the request outright. Not an error on our side, and the state row is again
     left alone rather than spent - we did not get a callback whose identity we
     can trust. */
	const providerError = params.get('error');
	if (providerError === 'access_denied') {
		/* Their choice, not a fault - see the same branch in the HCA callback. */
		console.info('hackatime link declined at the consent screen');
		return redirectWith(fallback, { link_error: 'denied' satisfies Failure });
	}
	if (providerError) {
		console.warn(
			`hackatime callback returned an error: ${providerError} ` +
				`(${params.get('error_description') ?? 'no description'})`
		);
		return redirectWith(fallback, { link_error: 'provider_error' satisfies Failure });
	}

	const state = params.get('state');
	const code = params.get('code');
	if (!state || !code) {
		return redirectWith(fallback, { link_error: 'bad_state' satisfies Failure });
	}

	if (!(await browserStartedFlow('hackatime', state))) {
		console.warn(
			`hackatime callback: state did not match any flow this browser started ` +
				`(${await describeStateMismatch('hackatime')})`
		);
		return redirectWith(fallback, { link_error: 'bad_state' satisfies Failure });
	}

	const consumed = await consumeOauthState(state, 'hackatime');

	/* Cleared whether or not the row turned out to be spendable. Leaving a dead
     marker in the browser only means the next replay of this URL gets one step
     further before being refused. */
	await forgetStateInBrowser('hackatime', state);

	if (!consumed.ok) {
		console.warn(`hackatime callback: state rejected (${consumed.reason})`);
		return redirectWith(fallback, {
			link_error: (consumed.reason === 'expired' ? 'expired' : 'bad_state') satisfies Failure
		});
	}

	const flow = consumed.row;
	const redirectTo = safeRedirectPath(flow.redirectTo, fallback);

	/**
	 * The check that only a link flow needs.
	 *
	 * The start route wrote the session's user into the row; this compares it
	 * against whoever is signed in now. They differ when someone signed out and
	 * back in as a different person mid-flow, or when the callback URL was opened
	 * in a browser belonging to somebody else - and in the second case, without
	 * this, the account would silently attach to the wrong user.
	 */
	if (flow.userId !== session.user.id) {
		console.warn('hackatime callback: flow belongs to a different user than the live session');
		return redirectWith(redirectTo, {
			link_error: 'wrong_user' satisfies Failure
		});
	}

	try {
		const tokens = await exchangeHackatimeCode({
			code,
			codeVerifier: flow.codeVerifier
		});

		/* The account id comes from Hackatime rather than from anything the browser
       sent, and it is what the row is keyed on. Hackatime accounts legitimately
       carry a different email from the HCA identity they are being attached to,
       so matching on email here would attach evidence to the wrong person the
       first time somebody used two addresses. */
		const account = await fetchHackatimeAccount(tokens.accessToken);

		const outcome = await linkHackatimeAccount({
			userId: session.user.id,
			account,
			tokens
		});

		if (!outcome.ok) {
			/* Someone else got there first, or this account's time is shipped
         and the link cannot move. Worth an explanation rather than a generic
         failure, because the honest resolution is a conversation with an
         organiser and not a retry. */
			await recordAudit({
				action: 'provider.link_refused',
				actorId: session.user.id,
				subjectId: session.user.id,
				metadata: {
					provider: 'hackatime',
					reason: outcome.reason,
					accountId: account.accountId
				}
			});

			recordEvent('hackatime.link_failed', { reason: outcome.reason });
			return redirectWith(redirectTo, {
				link_error: outcome.reason satisfies Failure
			});
		}

		await recordAudit({
			action: outcome.relinked ? 'provider.relinked' : 'provider.linked',
			actorId: session.user.id,
			subjectId: session.user.id,
			metadata: {
				provider: 'hackatime',
				accountId: account.accountId,
				/* Granted, not requested - the record of what we actually hold is what
           lets a later 403 from Hackatime explain itself. */
				grantedScope: tokens.scope
			}
		});

		recordEvent('hackatime.linked', { relinked: outcome.relinked });

		return redirectWith(redirectTo, { linked: 'hackatime' });
	} catch (error) {
		/* The link is a single upsert, so there is no half-written state to undo
       here and specifically no partial credential to clean up. */
		console.error('hackatime callback failed', error);

		if (error instanceof HackatimeError && error.status === 401) {
			/* Hackatime rejected the token the moment we tried to use it - an
         expired code, a revoked grant, or an application that has been
         deactivated. Relinking is the only cure, which is where this lands. */
			recordEvent('hackatime.link_failed', { reason: 'expired' });
			return redirectWith(redirectTo, {
				link_error: 'expired' satisfies Failure
			});
		}

		recordEvent('hackatime.link_failed', { reason: 'provider_error' });
		return redirectWith(redirectTo, {
			link_error: 'provider_error' satisfies Failure
		});
	}
};
