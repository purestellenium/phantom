import { and, eq, inArray, ne } from 'drizzle-orm';

import { PROVIDER_TIMEOUT_MS, readJsonObject } from '$lib/server/auth/oauth';
import { bindings, decryptToken, encryptToken } from '$lib/server/crypto';
import { db } from '$lib/server/db/client';
import { isUniqueViolation, violatedConstraint } from '$lib/server/db/errors';
import { providerAccounts, submissions } from '$lib/server/db/schema';
import { redirectUri } from '$lib/server/auth/origin';
import { requireProvider } from '$lib/server/env';
import { staging, STAGING_HACKATIME_PROJECTS, stagingHackatimeLink } from '$lib/server/staging';
import {
	isJsonArray,
	isJsonObject,
	parseJson,
	readArray,
	readId,
	readNumber,
	readObject,
	readString,
	type JsonObject
} from '$lib/json';

/**
 * Hackatime, linked as a SECOND account and never as a way to sign in.
 *
 * That distinction is the whole design of this file. A local user always exists
 * before any of this runs, and every entry point takes the user's id from the
 * live session rather than from anything Hackatime says. If linking could also
 * create a user, then a Hackatime account would be a login credential for this
 * platform - and Hackatime is a time tracker, not an identity provider, with a
 * different threat model and a different account recovery story.
 *
 * The wiki's rules for this integration are the other half: store the access
 * token encrypted, keep the provider account ID separate from any other
 * identifier, persist the granted scope and expiry, and never send the token to
 * a browser or to a reviewer's client. A bare reusable token with no scope, no
 * expiry and no refresh gives no warning before the service starts rejecting
 * it.
 */

/**
 * `profile` to identify the account, `read` to list projects later.
 *
 * The same set OneKey and Stasis use, and no more. There is no write scope here
 * because nothing in this program should ever change a user's Hackatime data.
 */
export const HACKATIME_SCOPES = 'profile read';

/**
 * Hackatime's OAuth paths.
 *
 * These are the Doorkeeper defaults, which is what Hackatime runs. They are
 * written down rather than discovered because Hackatime is an OAuth 2.0
 * provider and not an OIDC one - there is no `.well-known` document to read,
 * so there is nothing to discover from. THIS IS THE ONE PLACE IN THIS
 * SUBSYSTEM WHERE A PATH IS A GUESS: the wiki records the scopes, the
 * authenticated profile endpoint and the fact that PKCE works, but not the
 * authorize and token paths. If a login here 404s, this constant is the first
 * thing to look at.
 */
const AUTHORIZE_PATH = '/oauth/authorize';
const TOKEN_PATH = '/oauth/token';

/** The profile endpoint the wiki does record, and the source of the account
 *  ID we store. */
const ME_PATH = '/api/v1/authenticated/me';

export class HackatimeError extends Error {
	readonly status: number | null;

	constructor(message: string, options?: { status?: number | null; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = 'HackatimeError';
		this.status = options?.status ?? null;
	}
}

/* ── authorization ───────────────────────────────────────────────────────── */

/**
 * PKCE is unconditional here.
 *
 * Unlike HCA, where support is unproven and the challenge is sent only if
 * discovery advertises it, Hackatime is known to accept S256 - Stasis links it
 * through a PKCE flow and Lapse uses PKCE against the same family of service.
 * So there is no negotiation and no fallback: a flow without a verifier is a
 * flow where a leaked authorization code is enough on its own, and we know we
 * do not have to accept that here.
 *
 * Async only because the callback address is read from the request being
 * served rather than from a variable; there is still no discovery document to
 * await.
 */
export async function hackatimeAuthorizeUrl(input: {
	state: string;
	codeChallenge: string;
}): Promise<string> {
	const config = requireProvider('hackatime');

	const url = new URL(`${config.host}${AUTHORIZE_PATH}`);
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', await redirectUri('hackatime'));
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', HACKATIME_SCOPES);
	url.searchParams.set('state', input.state);
	url.searchParams.set('code_challenge', input.codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');

	return url.toString();
}

/* ── tokens ──────────────────────────────────────────────────────────────── */

export type HackatimeTokenSet = {
	accessToken: string;
	refreshToken: string | null;
	/** As granted. Hackatime may hand back fewer scopes than we asked for, and a
	 *  later call that assumes `read` was granted would fail at the call site
	 *  with a 403 instead of here with an explanation. */
	scope: string | null;
	expiresAt: Date | null;
};

export async function exchangeHackatimeCode(input: {
	code: string;
	codeVerifier: string;
}): Promise<HackatimeTokenSet> {
	const config = requireProvider('hackatime');

	let response: Response;
	try {
		response = await fetch(`${config.host}${TOKEN_PATH}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json'
			},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code: input.code,
				/* Byte-identical to the one sent at authorize time, because Doorkeeper
           compares them. Both come from the same helper reading the same
           request, so they cannot drift. */
				redirect_uri: await redirectUri('hackatime'),
				client_id: config.clientId,
				client_secret: config.clientSecret,
				code_verifier: input.codeVerifier
			}),
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HackatimeError("Could not reach Hackatime's token endpoint.", {
			cause
		});
	}

	if (!response.ok) {
		let code = 'no error code';
		try {
			const body = await readJsonObject(response, 'Hackatime code exchange');
			code = readString(body, 'error') ?? code;
		} catch {
			/* Non-JSON error body; the status is still informative. */
		}
		throw new HackatimeError(`Hackatime refused the code exchange: ${response.status} (${code}).`, {
			status: response.status
		});
	}

	const payload = await readJsonObject(response, 'Hackatime code exchange');

	const accessToken = readString(payload, 'access_token');
	if (!accessToken) {
		throw new HackatimeError('Hackatime returned no access_token.');
	}

	const expiresIn = readNumber(payload, 'expires_in');

	return {
		accessToken,
		refreshToken: readString(payload, 'refresh_token'),
		scope: readString(payload, 'scope'),
		expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000)
	};
}

/* ── the account ─────────────────────────────────────────────────────────── */

export type HackatimeAccount = {
	/**
	 * Hackatime's own stable identifier for the account.
	 *
	 * Stored in `provider_account_id`, on its own, and never conflated with a
	 * Slack ID or with the email below. The wiki calls this out twice, and
	 * Hackatime's trust-factor endpoint is queried by Slack ID in one program and
	 * by Hackatime user ID in another - a discrepancy that exists precisely
	 * because somebody let two identifier namespaces share a column.
	 */
	accountId: string;

	/**
	 * The email Hackatime knows, which legitimately differs from the HCA one.
	 *
	 * Kept as a display detail in the profile snapshot and never used to match
	 * accounts. Stasis explicitly permits different provider emails, and matching
	 * on this would either refuse a legitimate link or, worse, attach the wrong
	 * account.
	 */
	email: string | null;

	/** The raw payload, for support and for showing the user which account they
	 *  linked. Never read for authorization. */
	profile: JsonObject;
};

/**
 * Pull the account ID out of the profile response.
 *
 * Tolerant about nesting because Rails APIs of this vintage return either the
 * record at the top level or wrapped in `user`/`data`, and the wiki documents
 * the endpoint's existence rather than its envelope. Numeric IDs are coerced to
 * a string here and nowhere else, so the column holds one representation - a
 * mix of `42` and `"42"` in a text column is a lookup that silently misses.
 */
function readAccountId(payload: JsonObject): string | null {
	const direct = readId(payload, 'id') ?? readId(payload, 'user_id');
	if (direct) return direct;

	for (const key of ['user', 'data']) {
		const nested = readObject(payload, key);
		const id = nested === null ? null : readId(nested, 'id');
		if (id) return id;
	}
	return null;
}

function readAccountEmail(payload: JsonObject): string | null {
	const direct = readString(payload, 'email');
	if (direct) return direct;

	for (const key of ['user', 'data']) {
		const nested = readObject(payload, key);
		const value = nested === null ? null : readString(nested, 'email');
		if (value) return value;
	}
	return null;
}

export async function fetchHackatimeAccount(accessToken: string): Promise<HackatimeAccount> {
	const config = requireProvider('hackatime');

	let response: Response;
	try {
		response = await fetch(`${config.host}${ME_PATH}`, {
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: 'application/json'
			},
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HackatimeError('Could not reach Hackatime.', { cause });
	}

	if (response.status === 401) {
		throw new HackatimeError(
			'Hackatime rejected the access token immediately after issuing it. The ' +
				'link cannot be completed; ask the user to try again.',
			{ status: 401 }
		);
	}
	if (!response.ok) {
		throw new HackatimeError(`Hackatime's profile endpoint returned ${response.status}.`, {
			status: response.status
		});
	}

	const payload = await readJsonObject(response, 'Hackatime profile');

	const accountId = readAccountId(payload);
	if (!accountId) {
		throw new HackatimeError(
			`Hackatime's ${ME_PATH} response contained no account id, so there is ` +
				'nothing stable to link to. Refusing to store a partial link.'
		);
	}

	return {
		accountId,
		email: readAccountEmail(payload),
		profile: payload
	};
}

/* ── linking ─────────────────────────────────────────────────────────────── */

export type LinkOutcome =
	| { ok: true; relinked: boolean }
	/** The Hackatime account is already attached to a different local user. */
	| { ok: false; reason: 'already_linked' }
	/** A different account than the one linked, from a user whose linked
	 *  account's time is already shipped - see `hackatimeLocked`. */
	| { ok: false; reason: 'locked' };

/**
 * Whether this user's Hackatime link is fixed where it is.
 *
 * True once any of their submissions has claimed Hackatime time and not been
 * rejected - shipped, first-passed or approved. A link is keyed on one
 * Hackatime account per user and one user per account, and nothing remembers
 * an account after it is unlinked: so moving away from an account whose time
 * was already shipped would free it for somebody else to link and ship the
 * same heartbeats again. Holding the link in place is what stops that.
 *
 * Reconnecting the SAME account is always allowed - that is how an expired or
 * refused token is repaired. A person whose Hackatime account genuinely
 * changed has to ask an organiser.
 */
export async function hackatimeLocked(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: submissions.id })
		.from(submissions)
		.where(
			and(
				eq(submissions.userId, userId),
				/* Revoked too: its claim stays consumed against this account. And a
				   change request, which is a review still open. */
				inArray(submissions.state, [
					'pending',
					'first_passed',
					'approved',
					'revoked',
					'changes_requested'
				])
			)
		)
		.limit(1);
	return row !== undefined;
}

/**
 * Whether a database error is the unique-index violation we expect.
 *
 * The constraint name distinguishes "this user already has a Hackatime row"
 * (which the upsert handles) from "this Hackatime account belongs to somebody
 * else" (which is the case worth an explanation). Getting that wrong turns a
 * clear message back into a 500.
 */
function isAccountTakenViolation(cause: unknown): boolean {
	if (!isUniqueViolation(cause)) return false;

	/* If the driver told us nothing about which constraint fired, assume the
     worst of the two. Reporting "already linked" for a conflict we cannot
     identify is a wrong-but-safe message; letting it escape as a 500 is not. */
	const constraint = violatedConstraint(cause);
	return constraint === null || constraint === 'provider_accounts_provider_account_idx';
}

/**
 * Attach a Hackatime account to a local user.
 *
 * Two guards against the same problem, because they fail differently. The
 * SELECT gives a clear answer in the ordinary case - somebody trying to link an
 * account their friend already linked - and the catch handles the race where
 * two people complete a link for the same Hackatime account at the same instant.
 * The database constraint is the actual guarantee; the SELECT just makes the
 * common path explicable. Without the index this would be the first way anyone
 * would try to claim someone else's hours once hours are worth something.
 *
 * Relinking is an UPDATE of the existing row rather than a second row: the
 * schema's per-user-per-provider index says so, and the alternative is a pile
 * of dead credentials sitting next to the live one.
 */
export async function linkHackatimeAccount(input: {
	userId: string;
	account: HackatimeAccount;
	tokens: HackatimeTokenSet;
}): Promise<LinkOutcome> {
	const [taken] = await db
		.select({ userId: providerAccounts.userId })
		.from(providerAccounts)
		.where(
			and(
				eq(providerAccounts.provider, 'hackatime'),
				eq(providerAccounts.providerAccountId, input.account.accountId),
				ne(providerAccounts.userId, input.userId)
			)
		)
		.limit(1);

	if (taken) return { ok: false, reason: 'already_linked' };

	const existing = await getLinkedHackatime(input.userId);
	if (
		existing &&
		existing.accountId !== input.account.accountId &&
		(await hackatimeLocked(input.userId))
	) {
		return { ok: false, reason: 'locked' };
	}

	const values = {
		userId: input.userId,
		provider: 'hackatime' as const,
		providerAccountId: input.account.accountId,
		accessTokenEncrypted: encryptToken(
			input.tokens.accessToken,
			bindings.providerToken(input.userId, 'hackatime', 'access_token')
		),
		refreshTokenEncrypted: input.tokens.refreshToken
			? encryptToken(
					input.tokens.refreshToken,
					bindings.providerToken(input.userId, 'hackatime', 'refresh_token')
				)
			: null,
		scope: input.tokens.scope,
		accessTokenExpiresAt: input.tokens.expiresAt,
		profile: input.account.profile
	};

	try {
		await db
			.insert(providerAccounts)
			.values(values)
			.onConflictDoUpdate({
				target: [providerAccounts.userId, providerAccounts.provider],
				set: {
					providerAccountId: values.providerAccountId,
					accessTokenEncrypted: values.accessTokenEncrypted,
					refreshTokenEncrypted: values.refreshTokenEncrypted,
					scope: values.scope,
					accessTokenExpiresAt: values.accessTokenExpiresAt,
					profile: values.profile,
					updatedAt: new Date()
				}
			});
	} catch (error) {
		if (isAccountTakenViolation(error)) {
			return { ok: false, reason: 'already_linked' };
		}
		throw error;
	}

	return { ok: true, relinked: existing !== null };
}

/**
 * What is linked, for the UI.
 *
 * Note what this returns and what it does not: an account id, a granted scope
 * and a date. No token, encrypted or otherwise. Anything this function returns
 * can end up in a server component's props and travel to the browser, so the
 * shape of the return type is itself the control.
 */
export async function getLinkedHackatime(
	userId: string
): Promise<{ accountId: string; scope: string | null; linkedAt: Date } | null> {
	if (staging) return stagingHackatimeLink();

	const [row] = await db
		.select({
			accountId: providerAccounts.providerAccountId,
			scope: providerAccounts.scope,
			linkedAt: providerAccounts.linkedAt
		})
		.from(providerAccounts)
		.where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, 'hackatime')))
		.limit(1);

	return row ?? null;
}

/**
 * The access token for a user's Hackatime account, or null.
 *
 * There is no refresh here, unlike HCA. Doorkeeper may or may not have issued a
 * refresh token, the wiki records no rotation contract for this service, and
 * the simple approach - use it until it is refused, then ask the user to relink -
 * is the honest one given what is actually known. A caller that gets a 401 from
 * Hackatime should surface "reconnect Hackatime" rather than retry.
 */
export async function getHackatimeAccessToken(userId: string): Promise<string | null> {
	const [row] = await db
		.select({ encrypted: providerAccounts.accessTokenEncrypted })
		.from(providerAccounts)
		.where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, 'hackatime')))
		.limit(1);

	if (!row?.encrypted) return null;
	return decryptToken(row.encrypted, bindings.providerToken(userId, 'hackatime', 'access_token'));
}

/** Remove the link entirely. The user is asking for the credential to be gone,
 *  so it goes - this is the one case where deleting the row is the correct
 *  reading of the request. Refused (false) once the link is locked, for the
 *  reason `hackatimeLocked` gives: unlinking then linking elsewhere is the
 *  same move as relinking elsewhere. */
export async function unlinkHackatime(userId: string): Promise<boolean> {
	if (await hackatimeLocked(userId)) return false;
	const removed = await db
		.delete(providerAccounts)
		.where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, 'hackatime')))
		.returning({ id: providerAccounts.id });

	return removed.length > 0;
}

/* ── project time ────────────────────────────────────────────────────────── */

/** Lists the user's projects with their tracked totals; needs the `read` scope. */
const PROJECTS_PATH = '/api/v1/authenticated/projects';

/**
 * The first moment Hackatime time counts toward Phantom, midnight UTC on
 * August 6, 2026. Anything logged before it is not Phantom work, however long
 * the project has existed. (It was January 1 until 2026-10-01; claims frozen
 * on submissions shipped before then were counted from January 1 - see
 * `grantCap` in projects/review.ts for how an update is measured across the
 * change.)
 *
 * Applied by Hackatime rather than by us: `start_date` makes the projects
 * endpoint total only the heartbeats from this instant on (ProjectStatsQuery,
 * in hackatime's app/services). So every figure this module returns - the
 * picker, the dashboard, and the claim frozen onto a submission - is already
 * the post-cutoff one, and a project with no time since then is absent from
 * the list rather than listed at zero.
 */
export const HACKATIME_COUNTS_FROM = '2026-08-06T00:00:00Z';

export type HackatimeProjectSummary = { name: string; totalSeconds: number };

/** What /api/projects/hackatime answers the new-project flow's picker with.
 *  Not linked and failed-to-load kept apart - see that endpoint. */
export type HackatimeChoices =
	| { state: 'unlinked' }
	| { state: 'error' }
	| { state: 'ok'; projects: (HackatimeProjectSummary & { disabled: boolean })[] };

/**
 * The user's Hackatime projects with their tracked totals since
 * HACKATIME_COUNTS_FROM.
 *
 * Returns null when we cannot ask - no linked account, or the token was refused
 * (relink) - for the same reason `fetchHackatimeProjectSeconds` does: null is not
 * zero, and a caller needs to tell "could not ask" from "asked, and there is
 * nothing there". Shared by that function and by the project form's dropdown, so
 * there is exactly one place that talks to `PROJECTS_PATH` and parses its shape.
 *
 * Tolerant about the response envelope - this family of Rails APIs returns the
 * list at the top level or wrapped in `data`/`projects`.
 */
export async function listHackatimeProjects(
	userId: string
): Promise<HackatimeProjectSummary[] | null> {
	if (staging) return STAGING_HACKATIME_PROJECTS;

	const accessToken = await getHackatimeAccessToken(userId);
	if (!accessToken) return null;

	const config = requireProvider('hackatime');

	const url = new URL(`${config.host}${PROJECTS_PATH}`);
	url.searchParams.set('start_date', HACKATIME_COUNTS_FROM);

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HackatimeError('Could not reach Hackatime to read projects.', { cause });
	}

	/* A refused token is a relink, not a failure to retry - same reading as the
	   profile endpoint. Surfaced as null so the caller says "reconnect Hackatime". */
	if (response.status === 401) return null;
	if (!response.ok) {
		throw new HackatimeError(`Hackatime's projects endpoint returned ${response.status}.`, {
			status: response.status
		});
	}

	const body = parseJson(await response.text());
	if (body === undefined) {
		throw new HackatimeError('Hackatime returned a projects body that is not JSON.');
	}

	const list = isJsonArray(body)
		? body
		: isJsonObject(body)
			? (readArray(body, 'data') ?? readArray(body, 'projects') ?? [])
			: [];

	const out: HackatimeProjectSummary[] = [];
	for (const entry of list) {
		if (!isJsonObject(entry)) continue;
		const name = readString(entry, 'name');
		if (name === null) continue;
		const totalSeconds =
			readNumber(entry, 'total_seconds') ?? readNumber(entry, 'totalSeconds') ?? 0;
		out.push({ name, totalSeconds: Math.max(0, Math.round(totalSeconds)) });
	}

	return out;
}

export type HackatimeDay = { active: boolean; seconds: number };

/**
 * Whether a user logged any heartbeat in the named projects on one UTC day,
 * and how much time it added up to.
 *
 * The same endpoint as the list above, narrowed with `projects` and an
 * inclusive `start_date`..`end_date` window. Hackatime leaves a project out of
 * the answer when it had no heartbeats in the window, so any row coming back
 * means the user was active that day - even a row whose seconds round to zero.
 *
 * Null when we cannot ask, as everywhere else in this module: no linked
 * account, or a refused token.
 */
export async function fetchHackatimeDay(
	userId: string,
	projectNames: string[],
	day: string
): Promise<HackatimeDay | null> {
	if (projectNames.length === 0) return { active: false, seconds: 0 };
	if (staging) return stagingHackatimeDay(userId, day);

	const accessToken = await getHackatimeAccessToken(userId);
	if (!accessToken) return null;
	return projectsBetween(accessToken, projectNames, `${day}T00:00:00Z`, `${day}T23:59:59Z`);
}

/**
 * Seconds per Hackatime project between `since` and now, for the named
 * projects - or, with `projectNames` null, every project the account has.
 *
 * What "time since your last ship" is counted from, the way Ari counts an
 * update: every linked project, newly linked ones included, only from the
 * previous ship's date (see projects/window.ts). A project with no time in the
 * window is absent from the map rather than zero.
 *
 * Null when we cannot ask (no linked account, or a refused token), as
 * everywhere in this module; a transport failure or a 5xx throws.
 */
export async function fetchHackatimeSecondsSince(
	userId: string,
	projectNames: string[] | null,
	since: Date
): Promise<Map<string, number> | null> {
	if (projectNames?.length === 0) return new Map();
	const now = new Date();
	if (since >= now) return new Map();
	if (staging) return new Map((projectNames ?? []).map((name) => [name, 1800]));

	const accessToken = await getHackatimeAccessToken(userId);
	if (!accessToken) return null;
	return projectSecondsBetween(accessToken, projectNames, since.toISOString(), now.toISOString());
}

async function projectsBetween(
	accessToken: string,
	projectNames: string[],
	startIso: string,
	endIso: string
): Promise<HackatimeDay | null> {
	const perProject = await projectSecondsBetween(accessToken, projectNames, startIso, endIso);
	if (perProject === null) return null;
	let seconds = 0;
	for (const value of perProject.values()) seconds += value;
	return { active: perProject.size > 0, seconds };
}

async function projectSecondsBetween(
	accessToken: string,
	projectNames: string[] | null,
	startIso: string,
	endIso: string
): Promise<Map<string, number> | null> {
	const config = requireProvider('hackatime');

	const url = new URL(`${config.host}${PROJECTS_PATH}`);
	url.searchParams.set('start_date', startIso);
	url.searchParams.set('end_date', endIso);
	if (projectNames) url.searchParams.set('projects', projectNames.join(','));

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HackatimeError('Could not reach Hackatime to read a day of activity.', { cause });
	}

	if (response.status === 401) return null;
	if (!response.ok) {
		throw new HackatimeError(`Hackatime's projects endpoint returned ${response.status}.`, {
			status: response.status
		});
	}

	const body = parseJson(await response.text());
	if (body === undefined) {
		throw new HackatimeError('Hackatime returned a projects body that is not JSON.');
	}

	const list = isJsonArray(body)
		? body
		: isJsonObject(body)
			? (readArray(body, 'data') ?? readArray(body, 'projects') ?? [])
			: [];

	/* Filtered here as well as by Hackatime, so a server that ignored the
	   `projects` parameter could not count an unlinked project as activity. */
	const wanted = projectNames ? new Set(projectNames) : null;
	const perProject = new Map<string, number>();
	for (const entry of list) {
		if (!isJsonObject(entry)) continue;
		const name = readString(entry, 'name');
		if (name === null || (wanted && !wanted.has(name))) continue;
		const seconds = Math.max(0, Math.round(readNumber(entry, 'total_seconds') ?? 0));
		perProject.set(name, (perProject.get(name) ?? 0) + seconds);
	}
	return perProject;
}

/** A made-up but stable answer for staging: about two days in three active,
 *  varying by user and day, so the console's chart has a shape to draw. */
function stagingHackatimeDay(userId: string, day: string): HackatimeDay {
	let hash = 0;
	for (const char of `${userId}:${day}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	const roll = Math.abs(hash) % 3;
	return roll === 0 ? { active: false, seconds: 0 } : { active: true, seconds: roll * 1800 };
}

/**
 * Total Hackatime seconds across the named projects for a user.
 *
 * Returns null when we cannot ask - no linked account, or the token was refused
 * (relink). Null is deliberately not zero: the ship path must tell "we could not
 * count" apart from "linked, and the total really is zero", the same distinction
 * eligibility keeps between `unavailable` and a real answer. A transport or 5xx
 * failure throws, so the caller can fail the ship closed rather than guess.
 */
export async function fetchHackatimeProjectSeconds(
	userId: string,
	projectNames: string[]
): Promise<number | null> {
	if (projectNames.length === 0) return 0;

	const list = await listHackatimeProjects(userId);
	if (list === null) return null;

	const wanted = new Set(projectNames);
	let total = 0;
	for (const project of list) {
		if (wanted.has(project.name)) total += project.totalSeconds;
	}
	return total;
}
