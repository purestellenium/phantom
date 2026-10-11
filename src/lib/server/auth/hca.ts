import { and, eq } from 'drizzle-orm';

import { rememberCountry } from '$lib/server/address';
import { recordAudit } from '$lib/server/audit';
import { discoverHca, supportsPkceS256 } from '$lib/server/auth/discovery';
import { PROVIDER_TIMEOUT_MS, readJson, readJsonObject } from '$lib/server/auth/oauth';
import { bindings, decryptToken, encryptToken } from '$lib/server/crypto';
import { db } from '$lib/server/db/client';
import {
	providerAccounts,
	type IdentityCheckResult,
	type ProviderAccount,
	type VerificationStatus
} from '$lib/server/db/schema';
import { redirectUri } from '$lib/server/auth/origin';
import { providerHost, requireProvider } from '$lib/server/env';
import { staging, STAGING_ADDRESSES } from '$lib/server/staging';
import {
	isJsonObject,
	readBoolean,
	readNumber,
	readString,
	type JsonObject,
	type JsonValue
} from '$lib/json';

/**
 * Everything this app knows how to say to Hack Club Identity.
 *
 * No endpoint path appears in this file except the one HCA does not publish
 * through discovery - the public identity check, which lives outside the OIDC
 * surface. Everything else is read from the discovery document, because the
 * issuer varies by environment and a hardcoded path is a 404 waiting for a
 * staging deploy.
 */

/**
 * What we ask for, and nothing more.
 *
 * `birthdate` IS requested, and it is requested for exactly one thing: the
 * YSWS records base has a `Birthday` column and the submission record is
 * incomplete without it. OneKey fills the same column from the same claim.
 *
 * What it is NOT is an input to eligibility, and the distinction is the whole
 * reason this paragraph is longer than the others. The risk is feeding this
 * claim to the eligibility decision as well, so that when the identity check
 * errors it falls back to an age computed locally from the date - an upstream
 * outage quietly promoting the weaker signal into the deciding one.
 * lib/auth/eligibility.ts refuses that by construction: `deriveEligibility`
 * is handed `birthdate: null` and cannot reach for the column. Requesting the
 * scope does not change that and must not; if a future rule genuinely needs to
 * gate on age, that is a new ELIGIBILITY_RULE version and a deliberate
 * decision, not a value that leaks into the existing one because it happens to
 * be in the row now.
 *
 * It is HQ-tier PII, which is the other reason it stayed out until something
 * actually needed it.
 *
 * `address` IS requested - shipping a project needs a postal address for the
 * YSWS/Airtable record, and per HCA's API reference `address` is the scope that
 * makes /api/v1/me include the mailing-address list (see fetchHcaAddresses). It
 * is HQ-tier, which is why this depends on the client being HQ-official.
 *
 * `basic_info` is deliberately NOT requested. HCA's reference says it bundles
 * "email, name, verification status, birthday, phone" - every part of which we
 * already read from the identity scopes above (email, profile,
 * verification_status), and the address's own phone rides on `address`. So it
 * buys nothing, and requesting a scope this client is not granted makes HCA
 * reject the whole authorize request with "invalid scope" - which breaks
 * sign-in for everyone, not just shipping.
 *
 * These are what we REQUEST. What we were GRANTED comes back on the token
 * response and is what gets stored; a Program's configuration may be narrower
 * than this string, and code that assumes otherwise fails later with a
 * confusing 403.
 *
 * Do NOT try to narrow this against the discovery document's
 * `scopes_supported`. That array advertises `openid profile phone birthdate`
 * and omits `email`, `slack_id` and `verification_status` even though all three
 * are real, grantable scopes that shipped clients request today. Filtering
 * against it would silently drop `email` - and this file treats a missing email
 * as a fatal sign-in error, so the whole platform would stop letting anyone in.
 */
export const HCA_SCOPES = 'openid profile email slack_id verification_status address birthdate';

/* ── errors ──────────────────────────────────────────────────────────────── */

export class HcaError extends Error {
	/** The upstream HTTP status, when there was one. Null for transport
	 *  failures, which are a different operational problem. */
	readonly status: number | null;

	constructor(message: string, options?: { status?: number | null; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = 'HcaError';
		this.status = options?.status ?? null;
	}
}

/**
 * A 401 from HCA, which the wiki says to treat as revocation, expiry, or an
 * inactive program - never as a transient error worth retrying.
 *
 * Its own class because the correct response is different from every other
 * failure: the grant is gone and the user has to link again. Retrying would
 * loop, and swallowing it would leave the app holding a credential it believes
 * in and upstream does not.
 */
export class HcaGrantRejected extends HcaError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, { status: 401, cause: options?.cause });
		this.name = 'HcaGrantRejected';
	}
}

/**
 * HCA released no email address.
 *
 * Its own class because the operator fix is specific and unrelated to every
 * other failure here - the client's configured scopes in HCA do not include
 * `email` - and because the callback needs to tell the user something
 * different from "try again", which would loop forever.
 */
export class HcaMissingEmail extends HcaError {
	constructor(message: string) {
		super(message);
		this.name = 'HcaMissingEmail';
	}
}

/* ── rate limiting ───────────────────────────────────────────────────────── */

/**
 * When HCA last told us to slow down, and until when we listen.
 *
 * HCA blocks a client that keeps asking after a 429, so a 429 from any of the
 * calls made outside a login stops ALL of them for a while rather than letting
 * every page load keep knocking. Per process, which is enough: the point is to
 * stop hammering, not to coordinate perfectly.
 */
const DEFAULT_BACKOFF_MS = 60_000;
let backoffUntil = 0;

/** Whether we are currently holding off HCA after a 429. */
export function hcaBackingOff(): boolean {
	return Date.now() < backoffUntil;
}

/** The wait a 429 asked for, in milliseconds, or null when it named none. */
function retryAfterMs(response: Response): number | null {
	const retryAfter = Number(response.headers.get('retry-after'));
	return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
}

function noteRateLimit(response: Response): void {
	if (response.status !== 429) return;
	const wait = retryAfterMs(response) ?? DEFAULT_BACKOFF_MS;
	backoffUntil = Math.max(backoffUntil, Date.now() + wait);
	console.warn(`hca: rate limited, holding off for ${Math.round(wait / 1000)}s`);
}

/**
 * The longest a sign-in will wait out a 429 on the code exchange before giving
 * up. A person is watching the tab, so only a short Retry-After is worth it;
 * anything longer goes back to them as "busy, try again".
 */
const EXCHANGE_RETRY_CEILING_MS = 3_000;

/* ── authorization ───────────────────────────────────────────────────────── */

/**
 * Whether to send PKCE to HCA on this flow.
 *
 * The honest state of the world: HCA's Doorkeeper configuration does not force
 * PKCE, and whether it ACCEPTS a code challenge is unproven - the forcing
 * option is commented out in its source, which says nothing about how the
 * server treats the parameter when a client sends one anyway. Sending a
 * challenge to a server that ignores it costs nothing; sending one to a server
 * that rejects unknown parameters breaks every login on the platform.
 *
 * So discovery decides. If HCA advertises S256 it has told us it understands
 * the parameter, and we send it. If it does not, we proceed on state alone,
 * which is what every shipped Hack Club client does today. The moment HCA
 * starts advertising it, this turns itself on with no deploy.
 */
export async function hcaUsesPkce(): Promise<boolean> {
	return supportsPkceS256(await discoverHca());
}

/**
 * An address the user typed, if it is worth forwarding as `login_hint`.
 *
 * HCA is passwordless, so the same authorize URL both signs someone in and
 * signs them up - the difference is only whether the address already has an
 * identity behind it. Forwarding the one they just typed means they do not type
 * it a second time on the other side, which is the whole of the "sign up"
 * path's mechanics.
 *
 * Validated rather than passed through. It arrives from a query string, it goes
 * into a URL we hand to a browser, and a hint that is not an address is not a
 * hint - it is somebody testing what this parameter will carry. The landing
 * page's `?email=` goes through the same check before it fills the field.
 */
export function loginHint(candidate: string | null | undefined): string | null {
	if (!candidate) return null;
	const value = candidate.trim();
	/* Long enough for any real address, short enough that this cannot be used to
     pad a URL out to something an intermediary will refuse. */
	if (value.length === 0 || value.length > 254) return null;
	/* Deliberately loose - the authority on whether an address exists is HCA, and
     a stricter pattern here would only reject unusual-but-valid addresses. What
     this rules out is whitespace and anything that is not shaped like an
     address at all. */
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
	return value;
}

/** Where to send the browser to begin a sign-in. */
export async function hcaAuthorizeUrl(input: {
	state: string;
	codeChallenge: string | null;
	/** The address typed on the landing page, forwarded so HCA can skip asking
	 *  for it again. Ignored unless it looks like one. */
	email?: string | null;
}): Promise<string> {
	const config = requireProvider('hca');
	const document = await discoverHca();

	const url = new URL(document.authorizationEndpoint);
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', await redirectUri('hca'));
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', HCA_SCOPES);
	url.searchParams.set('state', input.state);

	const hint = loginHint(input.email);
	if (hint) url.searchParams.set('login_hint', hint);

	if (input.codeChallenge) {
		url.searchParams.set('code_challenge', input.codeChallenge);
		url.searchParams.set('code_challenge_method', 'S256');
	}

	/* No `nonce`. A nonce is only meaningful if something later verifies it
     against the ID token, and this flow never inspects the ID token: the code
     is exchanged server-to-server over TLS against the discovered token
     endpoint, so the response is already bound to a channel we authenticated,
     and the claims we act on come from userinfo rather than from a JWT we
     decoded. A nonce nobody checks is decoration that reads like a control. */

	return url.toString();
}

/* ── tokens ──────────────────────────────────────────────────────────────── */

export type HcaTokenSet = {
	accessToken: string;
	/** Null if HCA declined to issue one. The wiki says refresh tokens are
	 *  enabled, so this being null is worth noticing rather than assuming. */
	refreshToken: string | null;
	/** As GRANTED. May be narrower than HCA_SCOPES. */
	scope: string | null;
	/** Absolute, derived from `expires_in` at the moment of the response.
	 *  Six months, per the wiki - which is why refresh matters less here than the
	 *  401 handling does. */
	expiresAt: Date | null;
};

function parseTokenSet(payload: JsonObject, label: string): HcaTokenSet {
	const accessToken = readString(payload, 'access_token');
	if (!accessToken) {
		/* Deliberately does not echo the body. A token response that failed still
       frequently contains a token for a different grant, and this string ends
       up in logs. */
		throw new HcaError(`${label} returned no access_token.`);
	}

	const expiresIn = readNumber(payload, 'expires_in');
	const expiresAt = expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000);

	return {
		accessToken,
		refreshToken: readString(payload, 'refresh_token'),
		scope: readString(payload, 'scope'),
		expiresAt
	};
}

async function postToTokenEndpoint(
	form: URLSearchParams,
	label: string,
	retryRateLimit = false
): Promise<HcaTokenSet> {
	const document = await discoverHca();

	let response: Response;
	try {
		response = await fetch(document.tokenEndpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json'
			},
			body: form,
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HcaError(`${label} could not reach HCA's token endpoint.`, {
			cause
		});
	}

	/* The token endpoint shares HCA's limit with everything else we ask it, and
	   a sign-in is the call that matters most. So a 429 here holds off the
	   background calls too, leaving what budget there is to the people signing
	   in - and a login with a short Retry-After waits it out once rather than
	   failing. The code is not spent by a refused request, so it can be sent
	   again. */
	if (response.status === 429) {
		noteRateLimit(response);
		const wait = retryAfterMs(response);
		if (retryRateLimit && wait !== null && wait <= EXCHANGE_RETRY_CEILING_MS) {
			await new Promise((done) => setTimeout(done, wait));
			return postToTokenEndpoint(form, label, false);
		}
	}

	if (response.status === 401) {
		throw new HcaGrantRejected(
			`${label} was refused with 401. The grant has been revoked, has expired, ` +
				'or the program is inactive; the user must sign in again.'
		);
	}

	if (!response.ok) {
		/* OAuth error responses are a small closed vocabulary (`invalid_grant`,
       `invalid_client`, …) and naming the code is the difference between a
       ticket someone can act on and "login broken". The description is
       upstream-authored prose, never a credential. */
		let code = 'no error code';
		try {
			const body = await readJsonObject(response, label);
			code = readString(body, 'error') ?? readString(body, 'error_description') ?? code;
		} catch {
			/* Non-JSON error body. The status alone still says enough. */
		}
		throw new HcaError(`${label} failed: HCA returned ${response.status} (${code}).`, {
			status: response.status
		});
	}

	return parseTokenSet(await readJsonObject(response, label), label);
}

/** Exchange the authorization code for tokens. */
export async function exchangeHcaCode(input: {
	code: string;
	codeVerifier: string | null;
}): Promise<HcaTokenSet> {
	const config = requireProvider('hca');

	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		code: input.code,
		/* Byte-identical to the one sent at authorize time, because Doorkeeper
       compares them. Both come from the same helper reading the same request,
       so they cannot drift. */
		redirect_uri: await redirectUri('hca'),
		client_id: config.clientId,
		client_secret: config.clientSecret
	});
	/* Only when the challenge actually went out. Sending a verifier for a flow
     that had no challenge is a parameter the server did not ask for, and on a
     strict server that is a rejected exchange. */
	if (input.codeVerifier) form.set('code_verifier', input.codeVerifier);

	return postToTokenEndpoint(form, 'HCA code exchange', true);
}

/* ── identity ────────────────────────────────────────────────────────────── */

export type HcaIdentity = {
	/**
	 * The `sub` claim - an `ident!…` public ID, and the only identifier here that
	 * upstream promises is stable.
	 *
	 * Everything else on this object is mutable: people change their email, and
	 * their Slack account, and their display name. Keying a local user on any of
	 * those splits one person into two accounts the first time they do.
	 */
	subject: string;
	email: string;
	displayName: string | null;
	avatarUrl: string | null;
	slackId: string | null;
	/** `unknown` when the claim was absent, which is a different fact from any
	 *  of the values HCA can send. */
	verificationStatus: VerificationStatus;
	/** Null when absent. The wiki is explicit that an absent field must not be
	 *  treated as an empty value, and `false` here would be exactly that. */
	yswsEligibleClaim: boolean | null;
	/** `YYYY-MM-DD`, or null. For the YSWS record's `Birthday` column and
	 *  nothing else - see the note on HCA_SCOPES. */
	birthdate: string | null;
};

/* The values HCA's own claim can carry. `unknown` is ours and is not in here -
   anything we do not recognise, including a new state HCA adds later, lands on
   `unknown` so it shows up as something to look at rather than silently
   becoming a decision. */
const CLAIM_VALUES = [
	'needs_submission',
	'pending',
	'verified',
	'ineligible'
] as const satisfies readonly VerificationStatus[];

function readVerificationStatus(claims: JsonObject): VerificationStatus {
	const value = readString(claims, 'verification_status');
	return CLAIM_VALUES.find((claim) => claim === value) ?? 'unknown';
}

/** An avatar URL is rendered into an `<img src>`, so a `javascript:` or `data:`
 *  value here is a scripting bug with a user-controlled payload. Only http(s)
 *  survives. */
function readAvatarUrl(claims: JsonObject): string | null {
	const value = readString(claims, 'picture');
	if (value === null) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
		return value;
	} catch {
		return null;
	}
}

/**
 * The `birthdate` claim, but only in the one shape the column can hold.
 *
 * OIDC allows `YYYY`, `0000-MM-DD` and `YYYY-MM-DD` for this claim, and
 * `users.birthdate` is a Postgres `date` - so a year on its own, or a
 * zero year, reaches the driver as a value it cannot parse and turns a
 * sign-in into a 500. Anything that is not a complete calendar date is read as
 * an absent one, which is what the schema means by nullable here.
 *
 * The range check is for the same reason and not for realism: `9999-99-99`
 * matches the pattern and is not a date.
 */
function readBirthdate(claims: JsonObject): string | null {
	const value = readString(claims, 'birthdate');
	if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split('-').map(Number);
	if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
	return value;
}

/**
 * Read the current identity from the discovered userinfo endpoint.
 *
 * Userinfo rather than the ID token, because the ID token is a snapshot taken
 * at authentication and this is called on every login to refresh a cache that
 * the schema is explicit is a cache and not an authority.
 */
export async function fetchHcaIdentity(accessToken: string): Promise<HcaIdentity> {
	const document = await discoverHca();

	let response: Response;
	try {
		response = await fetch(document.userinfoEndpoint, {
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: 'application/json'
			},
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HcaError("Could not reach HCA's userinfo endpoint.", { cause });
	}
	noteRateLimit(response);

	if (response.status === 401) {
		throw new HcaGrantRejected(
			'HCA rejected the access token at userinfo. The grant has been revoked ' + 'or has expired.'
		);
	}
	if (!response.ok) {
		throw new HcaError(`HCA userinfo returned ${response.status}.`, {
			status: response.status
		});
	}

	const claims = await readJsonObject(response, 'HCA userinfo');

	const subject = readString(claims, 'sub');
	if (!subject) {
		throw new HcaError(
			'HCA userinfo returned no `sub` claim. Sign-in cannot continue: `sub` is ' +
				'the only identifier stable enough to key a local account on.'
		);
	}

	/* Email is required because `users.email` is NOT NULL and because every
     support path in this app starts from an address. If the `email` scope was
     not granted this fails loudly here, naming the cause, rather than inserting
     an empty string that looks like data forever after. */
	const email = readString(claims, 'email');
	if (!email) {
		throw new HcaMissingEmail(
			'HCA released no email address. The `email` scope is in our request but ' +
				"was not granted - check this client's configured scopes in HCA."
		);
	}

	return {
		subject,
		email,
		displayName:
			readString(claims, 'name') ??
			readString(claims, 'preferred_username') ??
			readString(claims, 'nickname'),
		avatarUrl: readAvatarUrl(claims),
		slackId: readString(claims, 'slack_id'),
		verificationStatus: readVerificationStatus(claims),
		yswsEligibleClaim: readBoolean(claims, 'ysws_eligible'),
		birthdate: readBirthdate(claims)
	};
}

/* ── the public identity check ───────────────────────────────────────────── */

/**
 * The one HCA path this file writes down, because it is not part of OIDC and
 * discovery does not describe it.
 *
 * It is intentionally public - no credential, CORS `*` - and answers the
 * question the `verification_status` claim does not: whether a verified
 * identity is actually youth-eligible. Two calls instead of one, because
 * `verified` and `verified_eligible` are different facts and collapsing them is
 * the mistake this whole subsystem is built to avoid.
 */
const IDENTITY_CHECK_PATH = '/api/external/check';

const CHECK_RESULTS = [
	'needs_submission',
	'pending',
	'verified_eligible',
	'verified_but_over_18',
	'rejected',
	'not_found'
] as const satisfies readonly IdentityCheckResult[];

/**
 * Pull the result out of the response without a schema that could reject it.
 *
 * The wiki records that this controller "rarely adds an unrelated fortune
 * field", and that consumers must ignore unknown keys. A strict validator -
 * a zod object without `.passthrough()`, say - would parse fine in every test
 * and then start failing in production on whichever requests happened to get a
 * fortune attached. So: read the key we want, ignore everything else, and never
 * assert on the shape of the whole object.
 *
 * `status` is checked as a second guess after `result` because the exact key
 * name is documented only as a table column in the wiki. Anything unrecognised
 * falls through to `unavailable`, which fails closed - a wrong guess here can
 * only ever make us more cautious, never less.
 */
function readCheckResult(body: JsonValue): IdentityCheckResult {
	if (!isJsonObject(body)) return 'unavailable';

	for (const key of ['result', 'status']) {
		const value = readString(body, key);
		const recognised = CHECK_RESULTS.find((result) => result === value);
		if (recognised !== undefined) return recognised;
	}
	return 'unavailable';
}

/**
 * Ask HCA whether this identity is youth-eligible.
 *
 * Every failure - unreachable, 5xx, malformed, a result we do not recognise -
 * becomes `unavailable`, never an optimistic guess and never a null. The schema
 * makes that a value rather than an absence precisely so "we asked and could
 * not find out" is distinguishable from "we never asked": the first should be
 * retried, the second means the flow skipped a step.
 *
 * Keyed on `idv_id` - the `sub` - rather than on email or Slack ID. Both of
 * those are accepted by the endpoint and both are mutable, so either would
 * eventually ask about somebody else.
 */
export async function checkHcaIdentity(subject: string): Promise<IdentityCheckResult> {
	const config = requireProvider('hca');
	if (hcaBackingOff()) return 'unavailable';

	const url = new URL(`${config.host}${IDENTITY_CHECK_PATH}`);
	url.searchParams.set('idv_id', subject);

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch {
		return 'unavailable';
	}
	noteRateLimit(response);

	/* A 404 is the endpoint's way of saying it has no such identity, which is a
     real answer rather than a fault - the same answer the body's `not_found`
     carries. Treating it as an outage would block a brand-new user forever
     under a decision that says "retry later". */
	if (response.status === 404) return 'not_found';
	if (!response.ok) return 'unavailable';

	try {
		return readCheckResult(await readJson(response, 'HCA identity check'));
	} catch {
		return 'unavailable';
	}
}

/* ── stored credentials ──────────────────────────────────────────────────── */

/**
 * How long before expiry we refresh.
 *
 * HCA access tokens last six months, so this is generous by design: there is no
 * value in cutting it fine, and a week of slack means a few days of upstream
 * refresh trouble does not become a wave of forced relinks.
 */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The stored HCA account for a user, or null if they have none. */
export async function getHcaAccount(userId: string): Promise<ProviderAccount | null> {
	const [account] = await db
		.select()
		.from(providerAccounts)
		.where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, 'hca')))
		.limit(1);
	return account ?? null;
}

/**
 * Whether this account can no longer be used without the user signing in
 * again.
 *
 * The marker is the absence of an access token, which is what a rejected
 * refresh leaves behind - see `refreshHcaTokens`. Everything else about the
 * row survives, so this answers "is the credential dead" without destroying
 * the record that the link ever existed.
 */
export function accountNeedsRelink(account: ProviderAccount): boolean {
	return account.accessTokenEncrypted === null;
}

/**
 * Write a fresh token set onto an existing account row.
 *
 * One UPDATE, so the rotated refresh token and the access token it came with
 * land together. The wiki's instruction is to "store the latest rotated refresh
 * token atomically", and the failure it is guarding against is real: a refresh
 * that persists the access token, then crashes, then persists the refresh token
 * leaves the row holding a refresh token that has already been spent - and
 * Doorkeeper rotation means the previous one is now the only valid one and we
 * no longer have it. That account is unrecoverable without a relink.
 *
 * A null refresh token in the response leaves the stored one alone rather than
 * clearing it, because some servers omit the field on refresh to mean "keep
 * using the one you have", and clearing it would be an unforced logout.
 */
async function persistTokenSet(
	account: { id: string; userId: string },
	tokens: HcaTokenSet
): Promise<void> {
	/* The whole row, not just its id: the ciphertext is bound to the account it
     belongs to, and the binding is built from the owner rather than from the
     primary key so it is the same string an insert could have produced. */
	const changes: Partial<typeof providerAccounts.$inferInsert> = {
		accessTokenEncrypted: encryptToken(
			tokens.accessToken,
			bindings.providerToken(account.userId, 'hca', 'access_token')
		),
		accessTokenExpiresAt: tokens.expiresAt,
		updatedAt: new Date()
	};
	if (tokens.refreshToken) {
		changes.refreshTokenEncrypted = encryptToken(
			tokens.refreshToken,
			bindings.providerToken(account.userId, 'hca', 'refresh_token')
		);
	}
	/* Likewise for scope: a refresh response that omits it is not a revocation
     of the scopes we were granted, and overwriting the column with null would
     make every later capability check think we have none. */
	if (tokens.scope) changes.scope = tokens.scope;

	await db.update(providerAccounts).set(changes).where(eq(providerAccounts.id, account.id));
}

/**
 * Exchange the stored refresh token for a new token set.
 *
 * Returns null when there is nothing to refresh with, so a caller can tell
 * "there is no refresh token" from "the refresh was refused" - the second
 * throws.
 *
 * On a 401 the credential is provably dead: HCA has said the grant is revoked,
 * expired, or the program is inactive, and no retry will change that. The
 * ciphertext is cleared and NOTHING ELSE IS. The row, the provider account ID,
 * the granted scope, the profile snapshot and `linkedAt` all stay, because that
 * is the history - who this user is upstream and when they linked - and
 * deleting it to represent a failed refresh would erase the only record that
 * the link existed. What goes is the two columns that hold a credential which
 * upstream has already refused; keeping unusable ciphertext buys nothing and
 * leaves a live-looking secret in the database.
 */
export async function refreshHcaTokens(userId: string): Promise<HcaTokenSet | null> {
	const account = await getHcaAccount(userId);
	if (!account?.refreshTokenEncrypted) return null;

	const config = requireProvider('hca');

	let refreshToken: string;
	try {
		refreshToken = decryptToken(
			account.refreshTokenEncrypted,
			bindings.providerToken(account.userId, 'hca', 'refresh_token')
		);
	} catch (cause) {
		/* Undecryptable means the key changed or the column was corrupted. Not
       retryable, and not something to paper over: the account needs relinking
       exactly as if upstream had refused it. */
		throw new HcaGrantRejected(
			'The stored HCA refresh token could not be decrypted. Was ENCRYPTION_KEY ' +
				'rotated without a re-encryption pass? The user must sign in again.',
			{ cause }
		);
	}

	try {
		const tokens = await postToTokenEndpoint(
			new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: config.clientId,
				client_secret: config.clientSecret
			}),
			'HCA token refresh'
		);

		await persistTokenSet(account, tokens);
		return tokens;
	} catch (error) {
		if (error instanceof HcaGrantRejected) {
			await db
				.update(providerAccounts)
				.set({
					accessTokenEncrypted: null,
					refreshTokenEncrypted: null,
					accessTokenExpiresAt: new Date(),
					updatedAt: new Date()
				})
				.where(eq(providerAccounts.id, account.id));

			await recordAudit({
				action: 'provider.relink_required',
				subjectId: userId,
				metadata: { provider: 'hca', reason: 'refresh_rejected_401' }
			});
		}
		throw error;
	}
}

/**
 * A usable HCA access token for a user, refreshing first if it is close to
 * expiring.
 *
 * Returns null rather than throwing when there is simply no linked account or
 * the credential is dead - those are states the UI renders ("reconnect your
 * Hack Club account"), not exceptions. A refusal from upstream during the
 * refresh still throws, because that is a fact the caller has to see.
 *
 * The plaintext returned here must never leave the server: not into props, not
 * into a log line, not into an audit metadata bag. lib/audit.ts scrubs
 * token-shaped keys as a backstop, but the real rule is that no call site
 * passes one.
 */
export async function getHcaAccessToken(userId: string): Promise<string | null> {
	const account = await getHcaAccount(userId);
	if (!account || accountNeedsRelink(account)) return null;

	const expiringSoon =
		account.accessTokenExpiresAt !== null &&
		account.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_WINDOW_MS;

	if (expiringSoon && account.refreshTokenEncrypted) {
		const refreshed = await refreshHcaTokens(userId);
		if (refreshed) return refreshed.accessToken;
	}

	if (!account.accessTokenEncrypted) return null;
	return decryptToken(
		account.accessTokenEncrypted,
		bindings.providerToken(account.userId, 'hca', 'access_token')
	);
}

/* ── addresses ───────────────────────────────────────────────────────────── */

/** HCA's backend identity endpoint, which returns the address list. Not OIDC,
 *  so not in discovery - the one written path besides the identity check. The
 *  mailing-address list appears only when the `address` scope was granted. */
const ME_PATH = '/api/v1/me';

export type HcaAddress = {
	/** HCA's stable id for the address; what a selection is keyed on. */
	id: string;
	primary: boolean;
	/** A one-line label for a picker, composed defensively from whatever fields
	 *  the payload carries. */
	label: string;
	/** The full address object, kept verbatim to freeze onto a submission and file
	 *  to Airtable - not every HCA field name is documented, so nothing is dropped. */
	raw: JsonObject;
};

function addressField(raw: JsonObject, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = readString(raw, key);
		if (value) return value;
	}
	return null;
}

/** The person the address is for: a full name where HCA gives one, else the
 *  first and last names joined. Null when the record carries no name. */
export function addressRecipient(raw: JsonObject): string | null {
	const whole = addressField(raw, 'full_name', 'name', 'recipient');
	if (whole) return whole;
	const parts = [addressField(raw, 'first_name'), addressField(raw, 'last_name')].filter(Boolean);
	return parts.length ? parts.join(' ') : null;
}

function addressLabel(raw: JsonObject): string {
	const parts = [
		addressRecipient(raw),
		addressField(raw, 'line_1', 'line1', 'street_address', 'address_line_1'),
		addressField(raw, 'city', 'locality'),
		addressField(raw, 'state', 'region', 'province'),
		addressField(raw, 'country', 'country_code')
	].filter(Boolean);
	return parts.length ? parts.join(', ') : 'saved address';
}

/**
 * The user's HCA addresses, read live from HCA.
 *
 * Null when we cannot ask - no linked HCA account, or a dead credential. An empty
 * array is a real answer: linked, and nothing on file yet. A transport or non-200
 * failure THROWS, so the ship path fails closed rather than let someone ship
 * without an address it merely failed to read.
 *
 * Read live rather than stored because HCA is the source of truth and editing
 * happens on its portal (hcaAddressPortalUrl) - this app never holds an editable
 * copy of an address off an order or submission.
 */
export async function fetchHcaAddresses(
	userId: string,
	options: { fresh?: boolean } = {}
): Promise<HcaAddress[] | null> {
	if (staging) {
		void rememberCountry(userId, STAGING_ADDRESSES).catch(() => {});
		return STAGING_ADDRESSES;
	}

	const cached = addressCache.get(userId);
	/* Held off after a 429: an old list beats an error, and asking again is
	   what got us blocked. */
	if (cached && hcaBackingOff()) return cached.addresses;
	if (!options.fresh && cached && Date.now() - cached.at < ADDRESS_CACHE_MS) {
		return cached.addresses;
	}
	if (hcaBackingOff()) throw new HcaError('Holding off HCA after a rate limit.', { status: 429 });

	const existing = addressInFlight.get(userId);
	if (existing) return existing;

	const pending = readHcaAddresses(userId)
		.then((addresses) => {
			if (addresses === null) addressCache.delete(userId);
			else {
				addressCache.set(userId, { at: Date.now(), addresses });
				/* Keep the stored country in step with the list, without holding
				   the page up for it - see rememberCountry. */
				void rememberCountry(userId, addresses).catch((error) =>
					console.error('[hca] could not store country', error)
				);
			}
			return addresses;
		})
		.finally(() => addressInFlight.delete(userId));
	addressInFlight.set(userId, pending);
	return pending;
}

/**
 * How long a page may show an address list without asking HCA again.
 *
 * Every page that mentions an address used to read it live, so one person
 * clicking around was a request per click. A form submission that acts on an
 * address passes `fresh` and still reads it live; this only covers pages that
 * describe one.
 */
const ADDRESS_CACHE_MS = 2 * 60 * 1000;
const addressCache = new Map<string, { at: number; addresses: HcaAddress[] }>();
const addressInFlight = new Map<string, Promise<HcaAddress[] | null>>();

async function readHcaAddresses(userId: string): Promise<HcaAddress[] | null> {
	const accessToken = await getHcaAccessToken(userId);
	if (!accessToken) return null;

	const config = requireProvider('hca');

	let response: Response;
	try {
		response = await fetch(`${config.host}${ME_PATH}`, {
			headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HcaError('Could not reach HCA to read addresses.', { cause });
	}
	noteRateLimit(response);

	if (response.status === 401) return null;
	if (!response.ok) {
		throw new HcaError(`HCA ${ME_PATH} returned ${response.status}.`, { status: response.status });
	}

	const body = await readJsonObject(response, 'HCA me');
	/* The record is under `identity` (Stardance's shape); fall back to the top
	   level in case a deployment flattens it. */
	const identity = isJsonObject(body.identity) ? body.identity : body;
	const list = Array.isArray(identity.addresses) ? identity.addresses : [];

	const addresses: HcaAddress[] = [];
	for (const entry of list) {
		if (!isJsonObject(entry)) continue;
		const id = readString(entry, 'id');
		if (!id) continue;
		addresses.push({
			id,
			primary: readBoolean(entry, 'primary') === true,
			label: addressLabel(entry),
			raw: entry
		});
	}
	return addresses;
}

export type NormalizedAddress = {
	name: string | null;
	line1: string | null;
	line2: string | null;
	city: string | null;
	region: string | null;
	postal: string | null;
	country: string | null;
	phone: string | null;
};

/** Map a raw HCA address object to the fields the Airtable record needs, trying
 *  the several key names this family of APIs uses. */
export function normalizeHcaAddress(raw: JsonObject): NormalizedAddress {
	return {
		name: addressRecipient(raw),
		line1: addressField(raw, 'line_1', 'line1', 'street_address', 'address_line_1'),
		line2: addressField(raw, 'line_2', 'line2', 'address_line_2'),
		city: addressField(raw, 'city', 'locality'),
		region: addressField(raw, 'state', 'region', 'province'),
		postal: addressField(raw, 'postal_code', 'zip', 'zip_code', 'postcode'),
		country: addressField(raw, 'country', 'country_code'),
		phone: addressField(raw, 'phone_number', 'phone')
	};
}

/** The address as it would be written on an envelope: one line per row,
 *  empty parts left out. What the buyer sees before pressing buy. */
export function addressLines(raw: JsonObject): string[] {
	const a = normalizeHcaAddress(raw);
	const locality = [a.city, [a.region, a.postal].filter(Boolean).join(' ')]
		.filter(Boolean)
		.join(', ');
	return [a.name, a.line1, a.line2, locality, a.country].filter((line): line is string =>
		Boolean(line)
	);
}

/**
 * Where to send someone to prove who they are - HCA's own verification flow.
 *
 * Built from the configured host rather than written out, so a staging instance
 * pointed at a staging HCA sends people to that one instead of quietly handing
 * them the real thing to verify against.
 *
 * No `return_to`: unlike the address portal, verification is not a round trip
 * somebody completes in a minute and comes back from - it is a submission that
 * Hack Club then reviews, and the page it ends on is theirs. Every caller opens
 * it in a new tab and leaves Phantom where it was.
 */
export function hcaVerifyUrl(): string {
	return `${providerHost('hca')}/verifications/new`;
}

/**
 * Where to send someone to add or edit their addresses - HCA's own address
 * page.
 *
 * Built from the configured host for the reason `hcaVerifyUrl` gives: a staging
 * instance pointed at a staging HCA sends people to that one rather than
 * quietly handing them the real thing.
 *
 * No `return_to`, and the reason is HCA's, not ours. Anyone who follows this
 * link without a live HCA session lands on `/welcome` first, and that bounce
 * rewrites `return_to` to HCA's own destination - ours is gone before the
 * sign-in form is even drawn. So the parameter only ever worked for somebody
 * already signed in, which is not the person being sent to fix an address. It
 * is a round trip HCA has to offer for us to use; until it does, this is a
 * plain link out and every caller leaves Phantom where it was.
 */
export function hcaAddressPortalUrl(): string {
	return `${providerHost('hca')}/addresses`;
}
