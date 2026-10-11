import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { loginHint } from '$lib/server/auth/hca';
import { missingProviderVars, providerConfigured } from '$lib/server/env';
import { launchAllows, launchSettings } from '$lib/server/launch';
import { staging } from '$lib/server/staging';
import { inviterFor } from '$lib/server/referrals';
import { INVITE_COOKIE, inviteCodeFrom, isInviteCode } from '$lib/referral';

/**
 * The front door.
 *
 * Deliberately not behind the launch gate. Staff are the people who bypass that
 * gate, and they can only be recognised once they have a session - so a sign-in
 * page that is itself closed before launch is a lock with the key inside it.
 *
 * A signed-in visitor goes to the dashboard, but only if the dashboard would
 * have them. The signed-in shell sends anyone the launch gate refuses back here
 * with `closed=1`, so forwarding every session onward would put a participant
 * on a closed site into a redirect loop between the two. The test below is the
 * gate's own, so the two agree by construction rather than by both being
 * remembered.
 *
 * This is the ONLY signed-out surface. The closed-for-launch notice, the
 * refused sign-in and the completed sign-out all land here with a code, and
 * the page turns the code into a sentence. The error page stays separate: it
 * is a framework boundary rather than a landing page, and cannot assume the
 * database is reachable, which this page does.
 */
export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	const session = locals.session;

	/* Onward only if the shell would actually admit them. `launchAllows` is the
	   same call the shell's gate makes, so a visitor can never be forwarded to a
	   page whose only response is to send them straight back here. */
	if (session && (await launchAllows(session.user, undefined, session.launched)))
		redirect(303, '/home');

	/* Past that redirect a session can only be one the gate refused, and that is
	   what closed means for this visitor whether or not they arrived carrying the
	   flag - they reach `/` by typing the domain too. */
	const refused = session !== null;
	const closed = url.searchParams.get('closed') === '1' || refused;

	/* One read, cached for fifteen seconds, that answers both questions this
	   page has for the database: whether the doors are open, which decides what
	   the hero offers, and what the closed page should say. */
	const settings = await launchSettings();

	/* Staging mode signs in without HCA (lib/server/staging.ts), so the log-in
	   button is offered and there is nothing missing to report. */
	const configured = staging || providerConfigured('hca');

	/* The operator's copy of the message the page does not print. The person
	   who has to fix this cannot sign in - HCA being unconfigured is exactly what
	   stops them reaching the console where it is also reported - so the log is
	   the only channel left that is ours and not the visitor's. It is noisy only
	   on a deployment that is already broken. */
	if (!configured) {
		console.error(
			`[auth] sign-in is unavailable. Missing: ${missingProviderVars('hca').join(', ')}`
		);
	}

	/* Who invited them, when they arrived by (or earlier followed) somebody's
	   link. The cookie first: the hook keeps the first code a browser saw, and
	   that is the one the account will be credited to, so it is the one to
	   name. Signed-out visitors only - an account already has its inviter. */
	const code = cookies.get(INVITE_COOKIE) ?? inviteCodeFrom(url);
	const inviter = !session && isInviteCode(code) ? await inviterFor(code) : null;

	/* `?email=` fills the sign-up field, for links from emails and partners that
	   already know the address. Read here rather than in the browser so the
	   field arrives filled with no script, and checked like the HCA hint it
	   becomes, so anything that is not an address leaves the field empty. */
	const email = session ? null : loginHint(url.searchParams.get('email'));

	return {
		inviter,
		email,
		authError: url.searchParams.get('auth_error'),
		closed,
		signedOut: url.searchParams.get('signed_out') === '1',
		prelaunchMessage: closed ? settings.prelaunchMessage : null,
		launched: settings.launched,
		configured,
		signedIn: refused
	};
};
