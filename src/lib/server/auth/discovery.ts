import { requireProvider } from '$lib/server/env';
import {
	isJsonObject,
	parseJson,
	readString,
	readStringArray,
	type JsonObject,
	type JsonValue
} from '$lib/json';

/**
 * OIDC discovery, because HCA does not publish a fixed set of paths.
 *
 * The wiki is explicit that the issuer varies between production, staging and
 * local, and that only "standard discovery" is guaranteed to advertise the
 * authorization, token, userinfo and JWKS endpoints. Writing `/oauth/authorize`
 * into this codebase would work right up until the first time we pointed at a
 * different environment, and the failure would arrive as a 404 during someone
 * else's login rather than as an error anyone could act on.
 *
 * So the document is the source of truth for every path, and this module is the
 * only place that fetches it. Nothing downstream is allowed to know a path.
 *
 * One thing this deliberately does NOT do is cache signing keys. Key rotation is
 * expected - the wiki says so, and says clients should re-read JWKS through
 * discovery rather than pinning one copied key forever. `jwksUri` is carried
 * through for anyone who later needs to verify a token out of band; it is not
 * resolved or memoised here.
 */

export type OidcDiscovery = {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	userinfoEndpoint: string;
	jwksUri: string;

	/**
	 * RP-initiated logout, if the provider offers it.
	 *
	 * Nullable because HCA may not advertise it, and an app that assumes it is
	 * present ends up either crashing on sign-out or, worse, silently sending
	 * people to `undefined`. Nothing in this codebase currently uses it; it is
	 * surfaced so that a future sign-out that wants to end the upstream session
	 * can check for it rather than guess at a path.
	 */
	endSessionEndpoint: string | null;

	/**
	 * Exactly as advertised, unmapped.
	 *
	 * The PKCE decision in lib/auth/hca.ts turns on whether `S256` appears here.
	 * An absent array is an absent array - it is not evidence that PKCE works and
	 * must not be normalised into one.
	 */
	codeChallengeMethods: string[];
};

/** Discovery failed. Distinct from a token or userinfo failure because the
 *  operator response is different: this one is nearly always a wrong HCA_HOST
 *  or an upstream outage, not anything about a particular user. */
export class DiscoveryError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'DiscoveryError';
	}
}

/* Ten minutes. Long enough that a burst of logins costs one round trip rather
   than hundreds, short enough that an endpoint move is picked up within a
   deploy-free window. The document is not versioned or ETagged in any way we can
   rely on, so a TTL is the only invalidation available. */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/* A discovery fetch sits directly in front of a user pressing "sign in", so it
   gets a short leash. Without an explicit signal this inherits whatever the
   platform's request timeout is, which means a hung upstream shows up as a
   blank page after 30 seconds instead of a legible error after eight. */
const DISCOVERY_TIMEOUT_MS = 8_000;

type CacheEntry = { document: OidcDiscovery; fetchedAt: number };

/* Module scope would be enough in production, where this file is evaluated
   once. In development Next.js replaces the module registry on every edit, so
   the cache - and, more importantly, the in-flight map that stops a stampede -
   would reset constantly. Same reasoning as the database handle in
   lib/db/client.ts. */
declare global {
	var phantomDiscoveryCache: Map<string, CacheEntry> | undefined;
	var phantomDiscoveryInFlight: Map<string, Promise<OidcDiscovery>> | undefined;
}

const cache = (globalThis.phantomDiscoveryCache ??= new Map());
const inFlight = (globalThis.phantomDiscoveryInFlight ??= new Map());

/* ── parsing ─────────────────────────────────────────────────────────────── */

function messageOf(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	return String(cause);
}

/**
 * Pull one endpoint out of the document, insisting it is a usable URL.
 *
 * The scheme check is not pedantry. The client secret goes to `token_endpoint`
 * in a request body, so an endpoint that came back as `http://` would put a
 * long-lived credential on the wire in the clear. Localhost is exempted for the
 * same reason lib/env.ts exempts it: a local HCA is how this gets developed
 * against at all.
 */
function endpoint(document: JsonObject, key: string, source: string): string {
	const value = readString(document, key);
	if (value === null) {
		throw new DiscoveryError(
			`${source} does not advertise ${key}. This is a required OIDC discovery field; ` +
				'check that HCA_HOST points at an OIDC issuer and not at a marketing page.'
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new DiscoveryError(`${source} advertises a malformed ${key}: ${value}`);
	}
	if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
		throw new DiscoveryError(
			`${source} advertises ${key} over ${parsed.protocol}//. ` +
				'Refusing to send client credentials or bearer tokens to a non-https endpoint.'
		);
	}
	return value;
}

/** The same, but the field is genuinely optional and its absence is a fact
 *  rather than a fault. */
function optionalEndpoint(document: JsonObject, key: string): string | null {
	const value = readString(document, key);
	if (value === null) return null;
	try {
		new URL(value);
	} catch {
		/* Advertised but unusable. Treated as absent rather than fatal: nothing
       required depends on it, and refusing to sign anybody in because an
       optional logout URL has a typo in it would be a bad trade. */
		return null;
	}
	return value;
}

/**
 * Every endpoint has to live on the host we asked.
 *
 * A discovery document says where to send things, and one of the things we send
 * is the client secret - `token_endpoint` receives it on every code exchange
 * and every refresh. Checking only that the URL is https means a document that
 * advertises `"token_endpoint": "https://evil.example/token"` is accepted, and
 * the credential goes there on the next login.
 *
 * This is what the OIDC spec's issuer check is for, and the document already
 * carries the value to check against. Both are compared: the issuer must be the
 * host we configured, and every endpoint must be on that issuer - so a
 * compromised or misconfigured document can move the flow around within HCA and
 * nowhere else.
 *
 * Origin, not prefix. `startsWith(issuer)` accepts
 * `https://auth.hackclub.com.evil.example`, which is the whole trick.
 */
function sameOrigin(value: string, origin: string): boolean {
	try {
		return new URL(value).origin === origin;
	} catch {
		return false;
	}
}

function parseDiscovery(body: JsonValue, source: string, host: string): OidcDiscovery {
	if (!isJsonObject(body)) {
		throw new DiscoveryError(`${source} did not return a JSON object.`);
	}
	const document = body;

	const expected = new URL(host).origin;
	const issuer = endpoint(document, 'issuer', source);
	if (!sameOrigin(issuer, expected)) {
		throw new DiscoveryError(
			`${source} claims to be issued by ${issuer}, which is not ${expected}. ` +
				'Refusing it: an issuer that does not match the host it was fetched ' +
				'from is either a misconfiguration or a redirect to somewhere else.'
		);
	}

	const parsed = {
		issuer,
		authorizationEndpoint: endpoint(document, 'authorization_endpoint', source),
		tokenEndpoint: endpoint(document, 'token_endpoint', source),
		userinfoEndpoint: endpoint(document, 'userinfo_endpoint', source),
		jwksUri: endpoint(document, 'jwks_uri', source),
		endSessionEndpoint: optionalEndpoint(document, 'end_session_endpoint'),
		codeChallengeMethods: [...(readStringArray(document, 'code_challenge_methods_supported') ?? [])]
	};

	/* Every endpoint, named rather than derived by walking the object and
     skipping whatever does not look like a string: a field added to the shape
     above must be listed here or deliberately left out, instead of quietly
     escaping the check because of its type. */
	const onIssuer = {
		authorizationEndpoint: parsed.authorizationEndpoint,
		tokenEndpoint: parsed.tokenEndpoint,
		userinfoEndpoint: parsed.userinfoEndpoint,
		jwksUri: parsed.jwksUri,
		endSessionEndpoint: parsed.endSessionEndpoint
	};

	for (const [key, value] of Object.entries(onIssuer)) {
		if (value === null) continue;
		if (!sameOrigin(value, expected)) {
			throw new DiscoveryError(
				`${source} advertises ${key} at ${value}, which is not on ${expected}. ` +
					"Refusing it: the token endpoint receives this client's secret."
			);
		}
	}

	return parsed;
}

/* ── fetching ────────────────────────────────────────────────────────────── */

async function fetchDiscovery(host: string): Promise<OidcDiscovery> {
	const url = `${host}/.well-known/openid-configuration`;

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
			/* This module does its own caching with its own TTL. Letting the fetch
         layer cache underneath it would give the document two lifetimes, and
         the one we could not see would be the one that mattered. */
			cache: 'no-store'
		});
	} catch (cause) {
		throw new DiscoveryError(`Could not reach ${url}: ${messageOf(cause)}`, { cause });
	}

	if (!response.ok) {
		throw new DiscoveryError(
			`${url} returned ${response.status} ${response.statusText}. ` +
				"Check HCA_HOST - this should be the issuer's origin, with no path."
		);
	}

	const body = parseJson(await response.text());
	if (body === undefined) {
		throw new DiscoveryError(
			`${url} did not return JSON. A login page or an HTML error page here ` +
				'usually means HCA_HOST is pointing somewhere that is not the issuer.'
		);
	}

	return parseDiscovery(body, url, host);
}

/**
 * The discovery document for a host, from cache when it is fresh.
 *
 * Concurrent misses share one request. Without that, the first login after a
 * cold start or a TTL expiry fans out one discovery fetch per in-flight
 * request - which is both rude to the provider and a way to turn a slow
 * upstream into a much slower one.
 */
export async function discover(host: string): Promise<OidcDiscovery> {
	const cached = cache.get(host);
	if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
		return cached.document;
	}

	const existing = inFlight.get(host);
	if (existing) return existing;

	const pending = fetchDiscovery(host)
		.then((document) => {
			cache.set(host, { document, fetchedAt: Date.now() });
			return document;
		})
		.finally(() => {
			/* Cleared whether it resolved or threw. A rejected promise left in here
         would be handed to every later caller, so one transient outage would
         pin the provider as broken for the life of the process. */
			inFlight.delete(host);
		});

	inFlight.set(host, pending);
	return pending;
}

/** Discovery for HCA specifically. Throws ConfigError if HCA is not set up,
 *  which is the fail-closed behaviour lib/env.ts is built around. */
export async function discoverHca(): Promise<OidcDiscovery> {
	return discover(requireProvider('hca').host);
}

/**
 * Whether we may send PKCE to this provider.
 *
 * HCA's Doorkeeper configuration does not force PKCE, and - this is the part
 * that matters - it is unproven whether it accepts a code challenge at all.
 * Sending one to a server that ignores it is harmless; sending one to a server
 * that rejects the parameter breaks every login. So the advertised list is the
 * permission slip: S256 present means send it, absent means do not, and the
 * flow falls back to the state check alone.
 */
export function supportsPkceS256(document: OidcDiscovery): boolean {
	return document.codeChallengeMethods.includes('S256');
}

/** Drop a cached document. For an operator who has just moved an issuer and
 *  does not want to wait out the TTL or restart the process. */
export function forgetDiscovery(host?: string): void {
	if (host) cache.delete(host);
	else cache.clear();
}
