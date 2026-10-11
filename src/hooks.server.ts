import {
	error,
	redirect,
	type Handle,
	type HandleServerError,
	type ServerInit
} from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

import { IMAGE_TOO_LARGE } from '$lib/images';
import { cookieOptions } from '$lib/server/auth/oauth';
import { readSession, SESSION_COOKIE } from '$lib/server/auth/session';
import {
	INVITE_COOKIE,
	REFERRAL_COOKIE,
	REFERRAL_MAX_AGE,
	inviteCodeFrom,
	referralFrom
} from '$lib/referral';
import { stagingSession } from '$lib/server/auth/staging-session';
import { recordEvent } from '$lib/server/analytics';
import { keepWarm } from '$lib/server/db/client';
import { isGatedApi, isPublicApi, launchAllows, refreshLaunch } from '$lib/server/launch';
import { staging } from '$lib/server/staging';

export const init: ServerInit = async () => {
	await Promise.all([
		keepWarm().catch((cause) => console.error('init: database not warm', cause)),
		refreshLaunch()
	]);
};

/** Anything slower than this is logged with its route, so a regression on the
 *  request path is a line in the log rather than a complaint. */
const SLOW_MS = 250;

/**
 * Everything that has to happen to a request before a page or an action sees
 * it, in the order it happens.
 *
 * SvelteKit runs a layout's `load` and its page's `load` concurrently, so a
 * gate written in a layout does not run before the page it wraps. The two
 * gates the signed-in shell needs - a session, and the launch switch - live
 * here for that reason, keyed on the route group rather than on a path prefix
 * that could drift from where the pages actually are.
 *
 * The launch half reaches past the group to the endpoints under /api, which
 * have no group to be keyed on: see `gates`.
 */

/**
 * The signed-in route group. A page moved out of `(app)` into a new group is
 * outside every gate below until the group is named here.
 */
function signedIn(route: string): boolean {
	return route.startsWith('/(app)');
}

/** Gate zero: who is asking. One query per request, and every load, action
 *  and route reads the answer off `locals` rather than asking again. */
const session: Handle = async ({ event, resolve }) => {
	event.locals.session = await readSession(event.cookies);
	/* Staging mode signs the developer in wherever a session is wanted: the
	   signed-in shell, and the log-in route, which then forwards onward. Not
	   everywhere, so the landing page is still reachable signed out. See
	   lib/server/staging.ts. */
	const route = event.route.id ?? '';
	if (staging && (signedIn(route) || route === '/api/auth/hca/start')) {
		event.locals.session = await stagingSession(event, event.locals.session);
	}
	return resolve(event);
};

/**
 * The signed-in shell's two gates, and the launch half of them for /api.
 *
 * Gate one: a session. Redirects to "/" when there is none, so nothing under
 * the group has to consider the signed-out case.
 *
 * Gate two: launch. Read after the user, because the answer depends on who is
 * asking - staff work on the site while it is closed, which is the entire point
 * of the flag. Refusal goes to the landing page carrying the reason, and
 * `launchAllows` is also what that page asks before it forwards a session here.
 * One function, consulted by both ends of the redirect, is what stops them
 * disagreeing and bouncing a visitor between them forever.
 *
 * Gate three - onboarding - is deliberately NOT here. It lives in
 * `requireOnboarded()`, which each page inside the group calls for itself;
 * /onboarding is then simply the page that does not call it. The console's own
 * gate is the same shape, in its layout and on every page under it.
 */
export const gates: Handle = async ({ event, resolve }) => {
	if (signedIn(event.route.id ?? '')) {
		const active = event.locals.session;
		if (!active) redirect(303, '/');
		if (!(await launchAllows(active.user, undefined, active.launched))) redirect(303, '/?closed=1');
		return resolve(event);
	}

	/* The same launch gate for the endpoints those pages read from. They are not
	   in the route group - /api has no group - so keying only on `/(app)` left
	   /api/projects and /api/showcase answering an onboarded participant while
	   the page above them redirected that same participant to a closed sign.
	   `isGatedApi` is the allowlist; a new endpoint is behind this by default.

	   Not found rather than a redirect, and not `?closed=1`: this answers a
	   fetch, not a navigation, and there is nothing useful for a client to
	   follow. It is the same refusal `requireCapability` gives, for the same
	   reason - a distinct status here would tell an unauthorised caller which
	   endpoints exist. */
	if (isGatedApi(event.route.id ?? '')) {
		const active = event.locals.session;
		/* A public endpoint waits for launch like everything else and asks for
		   nobody. The session is still passed when there is one, so a staff
		   member's bypass reaches it before launch the same as anywhere else;
		   with none, `launchAllows` reads the switch itself. See isPublicApi for
		   why this is its own case rather than a third entry in UNGATED_API. */
		if (isPublicApi(event.route.id ?? '')) {
			if (!(await launchAllows(active?.user ?? null, undefined, active?.launched))) error(404);
		} else if (!active || !(await launchAllows(active.user, undefined, active.launched))) {
			error(404);
		}
	}
	return resolve(event);
};

/**
 * The headers that are not the content security policy.
 *
 * The policy itself is in vite.config.ts, where SvelteKit can attach a nonce to
 * its own inline scripts and so drop 'unsafe-inline' from script-src. These
 * four have no such dependency and are the same on every response.
 */
const headers: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	/* The console has one-click destructive actions, so frame-ancestors in the
	   CSP is the one that matters most; this is the same rule for browsers that
	   predate it. */
	response.headers.set('x-frame-options', 'DENY');
	response.headers.set('x-content-type-options', 'nosniff');
	/* URLs here carry order ids and ?reveal=1, so the path must not travel in a
	   Referer header to another origin. */
	response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	/* Two years, subdomains included. No preload: that is effectively
	   irreversible and belongs to whoever owns the apex domain. */
	response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
	return response;
};

/** Timing, around everything else. */
const timing: Handle = async ({ event, resolve }) => {
	const started = performance.now();
	try {
		return await resolve(event);
	} finally {
		const took = performance.now() - started;
		if (took > SLOW_MS) {
			console.warn(
				`[slow] ${event.request.method} ${event.url.pathname} ${took.toFixed(0)}ms (${event.route.id ?? 'no route'})`
			);
		}
	}
};

/**
 * Remember a partner's referral from the link somebody arrived by, before
 * anything else can redirect them - a signed-out visitor to a gated page is
 * sent to the landing page, and the query string with them would be lost.
 * First touch: an arrival already carrying a source keeps it. Signed-in
 * visitors are skipped; they have an account, and a source is recorded on
 * the account only when it is created. See lib/referral.ts.
 */
const referral: Handle = async ({ event, resolve }) => {
	const source = event.request.method === 'GET' ? referralFrom(event.url) : null;
	if (source && !event.cookies.get(REFERRAL_COOKIE) && !event.cookies.get(SESSION_COOKIE)) {
		event.cookies.set(REFERRAL_COOKIE, source, await cookieOptions(REFERRAL_MAX_AGE));
		recordEvent('referral.arrived', { via: 'partner', source });
	}
	/* A participant's invite, signed-out only too, but last touch: the link
	   somebody followed most recently is the friend who finally got them to
	   sign up, so a newer code replaces an older one. Following the same link
	   again changes nothing and is not a second arrival. */
	const code = event.request.method === 'GET' ? inviteCodeFrom(event.url) : null;
	if (code && code !== event.cookies.get(INVITE_COOKIE) && !event.cookies.get(SESSION_COOKIE)) {
		event.cookies.set(INVITE_COOKIE, code, await cookieOptions(REFERRAL_MAX_AGE));
		/* Not the code: it names the inviter. See lib/server/analytics.ts. */
		recordEvent('referral.arrived', { via: 'invite' });
	}
	return resolve(event);
};

export const handle = sequence(timing, referral, session, gates, headers);

/**
 * What the reader is told when a render throws.
 *
 * The message is replaced with a generic one so nothing sensitive leaks to the
 * browser, and the id is the only string that ties what someone is looking at
 * to the line in our logs that explains it. A support conversation that starts
 * with that id is five minutes; one that starts with "it broke" is an
 * afternoon.
 */
export const handleError: HandleServerError = ({ error: thrown, event, status, message }) => {
	if (status === 404) return { message };

	/* A body over BODY_SIZE_LIMIT is refused while it is still being read, so no
	   action ever runs and no form can carry the refusal back. The screenshot
	   picker already turns an over-size file away before it is sent; this is the
	   submit that got past it - javascript off, or a browser that ignored the
	   input. The reader is told what happened rather than shown a ghost, and it
	   is not logged with an id because nothing broke. */
	if (status === 413) return { message: IMAGE_TOO_LARGE };

	const id = crypto.randomUUID();
	console.error(`[${id}] ${event.request.method} ${event.url.pathname}`, thrown);
	return { message: 'you found a ghost', id };
};
