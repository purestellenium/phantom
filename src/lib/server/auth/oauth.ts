import { and, desc, eq, isNull, lt, sql as raw } from 'drizzle-orm';
import { getRequestEvent } from '$app/server';

import { originIsSecure } from '$lib/server/auth/origin';
import { createPkcePair, newStateValue, safeEqual } from '$lib/server/crypto';
import { db } from '$lib/server/db/client';
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from '$lib/json';
import { oauthStates, type ProviderKind } from '$lib/server/db/schema';

/**
 * The mechanics of the authorization-code flow: where the state lives, how a
 * callback is validated, and what counts as a safe place to send someone
 * afterwards.
 *
 * One provider goes through here now that Hackatime is read rather than linked,
 * but the shape is still provider-keyed. That is deliberate and cheap: the
 * state table already carries the column, and the alternative is a second
 * implementation of replay protection the day anything else needs one.
 */

/* The whole budget for a human to get through a consent screen. Ten minutes
   turned out too tight: an HCA sign-in can mean waiting on an emailed code, and
   the browser marker expires with the row, so a slow sign-in came back as "did
   not match anything this browser started" rather than as expired. Thirty is
   still minutes, not hours - the window in which a leaked state value is worth
   anything stays short, and the row is single use regardless. */
const STATE_TTL_MS = 30 * 60 * 1000;

/**
 * How many in-flight flows one browser may have per provider.
 *
 * This number is the entire reason the browser-side marker is a list rather
 * than a single value. With one state cookie, opening a second login tab
 * overwrites the first, and finishing in the original tab fails with a state
 * mismatch that looks like a bug in the provider. Five is more tabs than
 * anyone opens by accident and few enough that the cookie stays small.
 */
const MAX_TRACKED_STATES = 5;

/* ── cookie policy ───────────────────────────────────────────────────────── */

/**
 * The shared shape for every cookie this app sets.
 *
 * `lax` and not `strict`: the OAuth callback is a top-level GET navigation
 * arriving from the provider's origin, and `strict` would withhold the cookie
 * on exactly that request - so the state binding below would fail on every
 * single login. `lax` still withholds it from cross-site POSTs and subresource
 * loads, which is the CSRF surface that matters.
 */
export async function cookieOptions(maxAgeSeconds: number) {
	return {
		httpOnly: true,
		secure: await originIsSecure(),
		sameSite: 'lax' as const,
		path: '/',
		maxAge: maxAgeSeconds
	};
}

/* ── redirect targets ────────────────────────────────────────────────────── */

/**
 * A base to resolve relative paths against, and nothing more.
 *
 * `URL` has no way to parse a path on its own, so normalising `..` segments
 * needs some origin to resolve against. This is deliberately one that cannot
 * exist: `.invalid` is reserved by RFC 2606 precisely so it can never resolve,
 * which means a bug that let this string escape into a Location header would
 * fail loudly in a browser rather than quietly pointing somewhere real. It
 * never appears in a return value - every function below strips it back off.
 */
const PARSE_BASE = 'http://internal.invalid';

/**
 * Reduce a caller-supplied `redirectTo` to something we are willing to send a
 * browser to, or fall back.
 *
 * The value reaches us from a query string, so it is attacker-controlled by
 * definition: anyone can hand out `…/api/auth/hca/start?redirectTo=…`. An open
 * redirect out of a login route is worth more than an ordinary one, because the
 * victim has just been asked to authenticate and is primed to trust whatever
 * page they land on.
 *
 * The checks are layered rather than clever, because every one of them is a
 * shape that has been used to slip past a naive `startsWith("/")`:
 *
 *   //evil.example      a protocol-relative URL - absolute, despite the slash
 *   /\evil.example      browsers normalise backslashes to slashes, so this is
 *                       the same thing wearing a hat
 *   /\/evil.example     and so is this
 *   /foo%0d%0aSet-Cookie a control character smuggled toward a header
 *   https://evil.example the obvious one
 *
 * The last check re-resolves the survivor against our own origin and insists it
 * stayed there, which catches anything the explicit list missed and also
 * normalises `..` segments out of the path.
 */
export function safeRedirectPath(candidate: string | null | undefined, fallback = '/'): string {
	if (!candidate) return fallback;

	/* Nothing legitimate in this app is a kilobyte of path, and an unbounded
     value ends up in a database column and a Location header. */
	if (candidate.length > 512) return fallback;

	if (!candidate.startsWith('/')) return fallback;
	if (candidate.startsWith('//')) return fallback;
	if (candidate.includes('\\')) return fallback;
	/* C0 controls and DEL. CR and LF are the dangerous ones - a Location header
     is assembled by string concatenation somewhere below us - but the whole
     range is refused because none of it belongs in a real path. */
	// eslint-disable-next-line no-control-regex -- the control range is the point
	if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;

	/* Resolved against a fixed base purely to normalise `..` segments and to
     reject anything that escapes the path space. The base is arbitrary and
     never appears in the result: every value that survives the checks above is
     already origin-relative, so which origin it is resolved against cannot
     change the answer. */
	let resolved: URL;
	try {
		resolved = new URL(candidate, PARSE_BASE);
	} catch {
		return fallback;
	}
	if (resolved.origin !== PARSE_BASE) return fallback;

	return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * A redirect to one of our own pages, carrying a short machine-readable code
 * the UI can turn into a sentence. Codes rather than prose so the wording lives
 * with the page and not with the auth plumbing.
 *
 * The `Location` is RELATIVE, which is both simpler and stricter than building
 * an absolute URL. There is no origin to get wrong, nothing to configure, and -
 * the part that matters - no way for a forged Host header to steer one of these
 * off our own site, because a relative Location is resolved by the browser
 * against the address it already has.
 */
export function redirectWith(
	path: string,
	params: Record<string, string> = {},
	/* 302 by default: the OAuth routes are a GET-only flow, and 302 is what
     every intermediary and log parser expects to see there.

     Overridable because one caller genuinely needs something else. A redirect
     that answers a POST must be 303, which tells the browser to follow it with
     a GET; 302 is permitted to repeat the method, so reloading the destination
     after a sign-out would re-post the sign-out. */
	status: 302 | 303 = 302
): Response {
	const url = new URL(safeRedirectPath(path), PARSE_BASE);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	return new Response(null, {
		status,
		headers: {
			location: `${url.pathname}${url.search}`,
			'cache-control': 'no-store'
		}
	});
}

/* ── the state store ─────────────────────────────────────────────────────── */

export type OauthStateRow = typeof oauthStates.$inferSelect;

export type StartedFlow = {
	/** Goes out as the `state` parameter and into the browser marker cookie. */
	state: string;
	/** Goes out as `code_challenge`, or null when the provider has not told us it
	 *  accepts one. */
	codeChallenge: string | null;
};

/**
 * Record an authorization request we are about to send, and return what the
 * provider needs to be told.
 *
 * The row is the flow's identity. Nothing about it round-trips through the
 * provider except the opaque state value, so the redirect target and the owning
 * user cannot be edited in flight - which is the whole reason `redirectTo`
 * lives in a column instead of in the callback URL.
 *
 * A verifier is generated and stored even when PKCE is switched off. The column
 * is NOT NULL, an unused 32-byte string costs nothing, and it means enabling
 * PKCE for a provider later is a change to one boolean rather than a migration.
 */
/**
 * How many unconsumed flows one client may leave lying around.
 *
 * Starting a login is the only unauthenticated write in this application - no
 * session, no credential, one row per request - so the table needs a ceiling.
 * This is that ceiling, and the important part is what happens at it: the
 * OLDEST rows are dropped, and the new flow proceeds.
 *
 * It refused instead, once, and that was wrong in a way worth writing down. A
 * flow is only consumed by a SUCCESSFUL callback, so every failed sign-in
 * leaves a row live for the full ten minutes - which means the fifth failure
 * locked the person out for ten minutes, and the sixth told them nothing,
 * because the refusal is deliberately indistinguishable from a missing route.
 * Someone retrying a login that is broken for an unrelated reason is the single
 * likeliest way to hit a limit like this, and they are exactly the person it
 * must not stop.
 *
 * Evicting bounds the table just as hard - a client can never hold more than
 * this many rows - without ever refusing a person. What it does not do is slow
 * an attacker down, and it is not trying to: that is a rule at the edge, and
 * this is the floor under it.
 *
 * Ten rather than five, because the eviction is now what enforces the bound and
 * the number only has to be past what a real browser could legitimately have
 * open at once.
 */
const MAX_LIVE_FLOWS_PER_CLIENT = 10;

export async function startOauthFlow(input: {
	provider: ProviderKind;
	usePkce: boolean;
	userId?: string | null;
	redirectTo?: string | null;
	ipPrefix?: string | null;
}): Promise<StartedFlow> {
	await pruneOauthStates();

	/* Evicted after the prune, so only genuinely live rows are counted, and only
     when we know who is asking - a platform that reports no address gets the
     benefit of the doubt rather than a shared bucket everyone falls into.

     The newest are kept: a person with several tabs open is finishing the most
     recent one, and the abandoned ones are what should go. */
	if (input.ipPrefix) {
		const keep = await db
			.select({ id: oauthStates.id })
			.from(oauthStates)
			.where(
				and(
					eq(oauthStates.ipPrefix, input.ipPrefix),
					isNull(oauthStates.consumedAt),
					raw`${oauthStates.expiresAt} > now()`
				)
			)
			.orderBy(desc(oauthStates.createdAt))
			.limit(MAX_LIVE_FLOWS_PER_CLIENT - 1);

		await db
			.delete(oauthStates)
			.where(
				and(
					eq(oauthStates.ipPrefix, input.ipPrefix),
					isNull(oauthStates.consumedAt),
					keep.length ? raw`${oauthStates.id} not in ${keep.map((r) => r.id)}` : raw`true`
				)
			);
	}

	const state = newStateValue();
	const { verifier, challenge } = createPkcePair();

	await db.insert(oauthStates).values({
		state,
		codeVerifier: verifier,
		provider: input.provider,
		userId: input.userId ?? null,
		redirectTo: input.redirectTo ? safeRedirectPath(input.redirectTo) : null,
		ipPrefix: input.ipPrefix ?? null,
		expiresAt: new Date(Date.now() + STATE_TTL_MS)
	});

	return { state, codeChallenge: input.usePkce ? challenge : null };
}

/** Why a callback's state was refused. Reported to operators and logged; the
 *  user only ever sees "that sign-in link expired, try again". */
export type StateFailure = 'missing' | 'unknown' | 'replayed' | 'expired' | 'wrong_provider';

export type ConsumedState = { ok: true; row: OauthStateRow } | { ok: false; reason: StateFailure };

/**
 * Spend a state row, exactly once.
 *
 * The accept/reject decision is a single UPDATE with every condition in its
 * WHERE clause, so two callbacks racing the same state value cannot both win:
 * Postgres serialises the row update, the loser matches zero rows, and the
 * replay is refused. A read-then-write would have a window between the two
 * where both look valid, which is precisely the window a replayed callback URL
 * is trying to hit.
 *
 * The follow-up SELECT exists only to say WHY. It runs after the decision has
 * already been made and cannot change it.
 */
export async function consumeOauthState(
	state: string | null | undefined,
	provider: ProviderKind
): Promise<ConsumedState> {
	if (!state) return { ok: false, reason: 'missing' };

	const [row] = await db
		.update(oauthStates)
		.set({ consumedAt: new Date() })
		.where(
			and(
				eq(oauthStates.state, state),
				eq(oauthStates.provider, provider),
				isNull(oauthStates.consumedAt),
				/* now() rather than a timestamp from this process: the expiry was
           written by Postgres's clock and should be judged by it, or a server
           whose clock has drifted will accept or refuse rows the database
           disagrees about. */
				raw`${oauthStates.expiresAt} > now()`
			)
		)
		.returning();

	if (row) return { ok: true, row };

	const [existing] = await db
		.select()
		.from(oauthStates)
		.where(eq(oauthStates.state, state))
		.limit(1);

	if (!existing) return { ok: false, reason: 'unknown' };
	if (existing.provider !== provider) {
		return { ok: false, reason: 'wrong_provider' };
	}
	if (existing.consumedAt) return { ok: false, reason: 'replayed' };
	return { ok: false, reason: 'expired' };
}

/**
 * Delete states that can no longer be spent.
 *
 * Called at the start of each flow rather than from a cron, because this table
 * only grows when someone starts a login and the cheapest moment to tidy it is
 * the moment it grows. It is an indexed range delete over a table that holds
 * minutes of traffic, so the cost is not measurable next to the OAuth round
 * trip it precedes.
 *
 * Expired rows are the same predicate as unusable rows, so nothing a live
 * callback needs can be removed here: `consumeOauthState` would already refuse
 * anything this deletes.
 */
export async function pruneOauthStates(): Promise<void> {
	await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
}

/* ── binding the callback to the browser that started it ─────────────────── */

/**
 * The second half of state validation.
 *
 * The database row proves the flow is one we started. It does not prove the
 * callback is being completed by the browser that started it - an attacker who
 * gets a victim to load their own callback URL can graft their account onto the
 * victim's session (login CSRF), and the row alone cannot tell the difference.
 * A marker in the browser closes that, because the attacker cannot write a
 * cookie into someone else's browser for our origin.
 *
 * It is a list, not a value, so concurrent tabs each keep their own entry. See
 * MAX_TRACKED_STATES above for the bug that motivates it.
 *
 * The separator is `.` because state values are base64url, whose alphabet does
 * not include it - so no value can smuggle a separator into the list.
 */
const STATE_SEPARATOR = '.';

function stateCookieName(provider: ProviderKind): string {
	return `phantom_oauth_${provider}`;
}

async function readTrackedStates(provider: ProviderKind): Promise<string[]> {
	const value = getRequestEvent().cookies.get(stateCookieName(provider));
	if (!value) return [];
	return value.split(STATE_SEPARATOR).filter(Boolean);
}

async function writeTrackedStates(provider: ProviderKind, states: string[]): Promise<void> {
	const { cookies } = getRequestEvent();
	if (states.length === 0) {
		cookies.delete(stateCookieName(provider), { path: '/' });
		return;
	}
	cookies.set(
		stateCookieName(provider),
		states.join(STATE_SEPARATOR),
		await cookieOptions(Math.ceil(STATE_TTL_MS / 1000))
	);
}

/** Note in the browser that this flow started here. */
export async function rememberStateInBrowser(provider: ProviderKind, state: string): Promise<void> {
	const existing = await readTrackedStates(provider);
	/* Newest first, oldest evicted. If someone really does open six tabs, the
     one they abandoned first is the one that stops working. */
	await writeTrackedStates(
		provider,
		[state, ...existing.filter((value) => value !== state)].slice(0, MAX_TRACKED_STATES)
	);
}

/**
 * Whether this browser is the one that started the flow.
 *
 * Compared with the constant-time helper because both sides are secrets the
 * browser holds, and a comparison that returns early leaks how much of a
 * guessed state value was correct.
 */
export async function browserStartedFlow(provider: ProviderKind, state: string): Promise<boolean> {
	const tracked = await readTrackedStates(provider);
	let matched = false;
	for (const candidate of tracked) {
		/* No early return: the loop always runs to the end so its duration does not
       depend on which entry matched. */
		if (safeEqual(candidate, state)) matched = true;
	}
	return matched;
}

/**
 * Why `browserStartedFlow` said no, for the log: whether the browser carried
 * no marker at all (it expired, was blocked, or the sign-in finished in a
 * different browser - an in-app webview, say) or carried markers for other
 * flows (a stale tab, or a callback opened twice). Counts only, never values.
 */
export async function describeStateMismatch(provider: ProviderKind): Promise<string> {
	const tracked = await readTrackedStates(provider);
	return tracked.length === 0
		? 'no marker in this browser'
		: `${tracked.length} other flow${tracked.length === 1 ? '' : 's'} in this browser`;
}

/** Drop one finished flow's marker, leaving any concurrent tabs' markers
 *  alone. */
export async function forgetStateInBrowser(provider: ProviderKind, state: string): Promise<void> {
	const existing = await readTrackedStates(provider);
	await writeTrackedStates(
		provider,
		existing.filter((value) => value !== state)
	);
}

/* ── shared HTTP helpers for talking to providers ────────────────────────── */

/** How long we will wait on a provider's token or profile endpoint. Same
 *  reasoning as the discovery timeout: a user is watching. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * Read a JSON body without trusting that it is JSON.
 *
 * Providers return HTML error pages, empty bodies and proxy timeouts, and
 * `await response.json()` on any of those throws a `SyntaxError` whose message
 * mentions a character position and nothing about which service failed. This
 * turns all of that into one sentence that names the endpoint.
 */
export async function readJson(response: Response, label: string): Promise<JsonValue> {
	const text = await response.text();
	if (!text.trim()) {
		throw new Error(`${label} returned an empty body (${response.status}).`);
	}
	const value = parseJson(text);
	if (value === undefined) {
		throw new Error(`${label} returned ${response.status} with a body that is not JSON.`);
	}
	return value;
}

/**
 * Read a JSON body that has to be an object.
 *
 * Every endpoint here documents an object, and the callers all want the same
 * sentence when one sends an array or a bare string, so the check belongs with
 * the read rather than three lines after it.
 */
export async function readJsonObject(response: Response, label: string): Promise<JsonObject> {
	const body = await readJson(response, label);
	if (!isJsonObject(body)) {
		throw new Error(`${label} returned a non-object body.`);
	}
	return body;
}
