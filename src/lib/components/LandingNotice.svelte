<script lang="ts">
	/**
	 * Everything the rest of the application needs to say on the front page.
	 *
	 * Seven routes redirect here carrying a short code - a refused sign-in, a
	 * closed site, a completed sign-out - and this is the one place those codes
	 * become sentences.
	 *
	 * Codes rather than prose in the query string, because the wording belongs
	 * with the page and not with the auth plumbing, and because a message
	 * assembled upstream can name hosts and configuration that have no business
	 * in a URL. Anything unrecognised renders nothing rather than guessing.
	 */
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import Notice from './Notice.svelte';

	/** What a sign-in came back with. The vocabulary is the `Failure` unions in
	 *  the callback routes, plus what the start routes can refuse with. */
	const AUTH_ERRORS = {
		denied: {
			title: 'sign-in cancelled',
			body: "you turned down the request on Hack Club's side. nothing happened."
		},
		signin_required: {
			title: 'sign in first',
			body: 'that page needs a session, and this browser does not have one.'
		},
		expired: {
			title: 'that took too long',
			body: 'the sign-in link expired before it came back. start again.'
		},
		bad_state: {
			title: 'that sign-in could not be verified',
			body: 'it did not match anything this browser started. start again.'
		},
		no_email: {
			title: 'Hack Club released no email address',
			body: 'an account here needs one, so sign-in cannot finish. this is a configuration problem on our side, not yours.'
		},
		provider_error: {
			title: 'Hack Club auth refused the sign-in',
			body: 'nothing is wrong with your account as far as we can tell. try again in a moment.'
		},
		rate_limited: {
			title: 'Hack Club Auth is busy',
			body: 'too many sign-ins at once on their side. wait a minute and try again.'
		},
		provider_unavailable: {
			title: 'Hack Club auth is not reachable',
			body: 'we could not start the sign-in. try again in a moment.'
		}
	} satisfies Record<string, { title: string; body: string }>;

	type AuthErrorCode = keyof typeof AUTH_ERRORS;

	function isAuthErrorCode(code: string): code is AuthErrorCode {
		return Object.hasOwn(AUTH_ERRORS, code);
	}

	let {
		authError,
		closed,
		signedOut,
		prelaunchMessage,
		inviter = null
	}: {
		authError: string | null;
		closed: boolean;
		signedOut: boolean;
		/** Operator-authored, out of site_settings, so opening late or saying why
		 *  is a row in the database rather than a deploy. */
		prelaunchMessage: string | null;
		/** Whoever's invite link brought them, by Slack handle when they have
		 *  one. Null when they came any other way. */
		inviter?: { handle: string | null } | null;
	} = $props();

	/* One notice, not a stack. These arrive one at a time in practice - a
	   redirect carries a single code - and rendering a column of boxes above the
	   controls would bury the thing the page is for. Most specific first. */
	const error = $derived(
		authError && isAuthErrorCode(authError) ? AUTH_ERRORS[authError] : undefined
	);

	/**
	 * Closing one of these, and why it takes the code out of the URL.
	 *
	 * Hiding it in a local variable alone would last until the first reload, and
	 * the URL these arrive on is one people bookmark, share and refresh - so the
	 * message would keep coming back and the × would read as broken. Stripping
	 * the codes is also the honest end of the story: they describe something that
	 * has already happened, and once it has been read the address bar should stop
	 * claiming the visitor just got here that way.
	 *
	 * `replaceState` rather than a navigation: same page, no server round trip,
	 * and no extra history entry for the back button to walk through.
	 *
	 * `closed` is deliberately not in the list. It is not always a code - the
	 * loader also sets it for a signed-in visitor the launch gate refused, who
	 * reaches "/" by typing the domain - so removing the parameter would not
	 * remove the notice, and pressing × would appear to do nothing at all.
	 */
	const CODES = ['auth_error', 'signed_out'];

	let dismissed = $state(false);

	function dismiss() {
		dismissed = true;

		/* Read and rebuilt rather than mutated: `page.url.searchParams` belongs to
		   the router's own URL, and the codes are dropped on the way out into a
		   fresh string instead of being deleted out from under it. */
		const query = [...page.url.searchParams]
			.filter(([key]) => !CODES.includes(key))
			.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
			.join('&');

		/* Rebuilt from `resolve('/')` rather than by editing the current URL in
		   place: this component only ever renders on the front page, that is the
		   route it is putting back, and going through resolve keeps it correct
		   under a base path. The rule below wants to SEE that call as the whole
		   argument and cannot follow it through a template, which is the only
		   reason the query string is appended by hand. */
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		replaceState(`${resolve('/')}${query ? `?${query}` : ''}`, page.state);
	}

	/* Only the two that carry a code get a ×. The closed-for-launch notice is the
	   state of the site rather than news about this visit, and there is nothing
	   for closing it to mean - the doors do not open because somebody pressed ×.
	   It is also the one that can be true with no parameter behind it. */
</script>

{#if !dismissed}
	{#if error}
		<Notice bad title={error.title} body={error.body} ondismiss={dismiss} />
	{:else if closed}
		<Notice
			title="not open yet"
			body={prelaunchMessage?.trim() ||
				'phantom is not open yet. we are still building it - check back soon.'}
		/>
	{:else if signedOut}
		<Notice title="signed out" body="your session on this browser is gone." ondismiss={dismiss} />
	{:else if inviter}
		<!-- Last: good news, but nothing is wrong and nothing happened, so any
		     of the above outranks it. The × only hides it; the ?ref= stays in
		     the address, since it is what credits the invite. -->
		<Notice
			title={inviter.handle
				? `@${inviter.handle} invited you to phantom!`
				: 'a friend invited you to phantom!'}
			body="sign up through Hack Club and you'll count as their referral."
			ondismiss={() => (dismissed = true)}
		/>
	{/if}
{/if}
