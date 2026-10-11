import { env as runtime } from '$env/dynamic/private';

import { normalizeDatabaseUrl } from './db/url';

/**
 * Configuration, in two tiers.
 *
 * The split matters. Some values the application cannot do anything at all
 * without - it cannot serve a page without a database, and it must never store
 * a token without a key - and those are read and validated the moment this
 * module loads, so a mistake is one legible error at startup rather than a
 * surprise three screens into a login.
 *
 * The provider credentials are different. They are issued by other teams on
 * their own schedule, and an app that refuses to boot without them is an app
 * nobody can run, develop against, or deploy a first time. So they are resolved
 * on use: everything that does not touch OAuth works without them, and the
 * routes that do touch it fail closed with a message naming exactly which
 * variable is missing. That is the wiki's own rule - fail closed when a protected route has
 * no configured key, and report variable names and enabled state rather than
 * values.
 *
 * What is NOT here is as deliberate as what is. There is no APP_URL: the
 * request already says where this instance is running (lib/auth/origin.ts), and
 * a variable holding our own address is a second copy of that fact which drifts
 * from it.
 *
 * `$env/dynamic/private` is not decoration. Everything here is a secret, and
 * that module makes reaching it from client code a build error rather than
 * something a review has to catch. Anything the browser genuinely needs belongs
 * in a PUBLIC_ variable and is not read here.
 */

export class ConfigError extends Error {
	constructor(message: string) {
		super(
			`${message}\n\nSee .env.example for the full list, and copy it to .env.local to get started.`
		);
		this.name = 'ConfigError';
	}
}

function required(name: string): string {
	const value = runtime[name];
	if (!value || !value.trim()) throw new ConfigError(`${name} is not set.`);
	return value.trim();
}

function optional(name: string): string | undefined {
	const value = runtime[name];
	return value && value.trim() ? value.trim() : undefined;
}

/** A URL with no trailing slash, so callers can join paths without doubling it. */
function asUrl(name: string, value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new ConfigError(`${name} is not a valid URL: ${value}`);
	}
	if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
		throw new ConfigError(
			`${name} must be https (got ${parsed.protocol}//${parsed.hostname}). ` +
				'Only localhost may be plain http.'
		);
	}
	return value.replace(/\/+$/, '');
}

/**
 * The 32-byte key that encrypts stored provider tokens.
 *
 * Accepted as 64 hex characters or as base64, because key material arrives in
 * both shapes depending on what generated it, and guessing wrong is a silent
 * failure - a short key would otherwise be padded or truncated into something
 * that "works" and produces ciphertext nobody can decrypt later.
 *
 * Validated here, at startup, rather than at first use. A key that is only
 * checked when crypto is first invoked lets a malformed one survive a deploy
 * and surface as a broken login for the first person to try one.
 *
 * There is deliberately no development fallback. A fixed all-zero key for
 * development is the kind of default that reaches
 * production precisely because nothing ever complains about it: an instance
 * missing the variable would encrypt every token in the database under a key
 * printed in the source. Refusing to start is the only behaviour that cannot do
 * that.
 */
function encryptionKey(): Buffer {
	const raw = required('ENCRYPTION_KEY');

	let key: Buffer | null = null;
	if (/^[0-9a-fA-F]{64}$/.test(raw)) {
		key = Buffer.from(raw, 'hex');
	} else {
		const decoded = Buffer.from(raw, 'base64');
		if (decoded.length === 32) key = decoded;
	}

	if (!key) {
		throw new ConfigError(
			'ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or as base64.\n' +
				'Generate one with:  openssl rand -hex 32'
		);
	}

	if (key.every((byte) => byte === 0)) {
		throw new ConfigError(
			'ENCRYPTION_KEY is all zero bytes. Generate a real one:  openssl rand -hex 32'
		);
	}

	return key;
}

/** Comma-separated HCA subjects seeded to an elevated role on first sign-in -
 *  ADMIN_HCA_SUBJECTS for admins, OWNER_HCA_SUBJECTS for owners.
 *
 *  A bootstrap, not the authorization model: roles live on the user row and are
 *  what the app checks. Without something like this the first admin - and the
 *  first owner, whom `canActOn` otherwise lets only another owner appoint -
 *  could only be made by hand in the database. */
function idList(name: string): string[] {
	const raw = optional(name);
	if (!raw) return [];
	return raw
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
}

/* ── tier one: read eagerly, fail at startup ─────────────────────────────── */

export const env = {
	/* Normalised here so `env.DATABASE_URL` is a string the driver can open, the
	   same shape drizzle.config.ts and the migrate script get from url.ts. */
	DATABASE_URL: normalizeDatabaseUrl(required('DATABASE_URL')),

	ENCRYPTION_KEY: encryptionKey(),

	ADMIN_HCA_SUBJECTS: idList('ADMIN_HCA_SUBJECTS'),
	OWNER_HCA_SUBJECTS: idList('OWNER_HCA_SUBJECTS')
} as const;

/* ── tier two: resolved on use, fail closed at the route ─────────────────── */

/**
 * The credentials for an upstream provider.
 *
 * There is no redirect URI in here. It is derived from the request being
 * served - see lib/auth/origin.ts - so the value registered with a provider is
 * whatever host this instance is actually answering on, and there is no
 * variable that can disagree with it.
 */
export type ProviderConfig = {
	/** Base URL, no trailing slash. */
	host: string;
	clientId: string;
	clientSecret: string;
};

/**
 * Every variable a provider needs, so a missing-config message can name all of
 * them at once rather than one per attempt.
 *
 * The host is not in these lists. Both are public services at a fixed address
 * and asking every deployment to type them in is asking for a typo; the
 * defaults below are overridable for staging or a local instance, which is a
 * different thing from being required.
 */
const PROVIDER_VARS = {
	hca: ['HCA_CLIENT_ID', 'HCA_CLIENT_SECRET'],
	hackatime: ['HACKATIME_CLIENT_ID', 'HACKATIME_CLIENT_SECRET']
} as const;

const PROVIDER_HOSTS = {
	hca: 'https://auth.hackclub.com',
	hackatime: 'https://hackatime.hackclub.com'
} as const;

const PROVIDER_HOST_VARS = {
	hca: 'HCA_HOST',
	hackatime: 'HACKATIME_HOST'
} as const;

export type ProviderName = keyof typeof PROVIDER_VARS;

/**
 * A provider's configuration, or null if it has not been set up.
 *
 * Null rather than a throw, so a page can render "signing in is not available
 * yet" instead of a stack trace. The routes that actually need it use
 * `requireProvider` below.
 *
 * Deliberately not memoised. These are read a handful of times per request at
 * most, the runtime environment is already an in-memory object, and a cache would mean a
 * platform that injects configuration after first render serves a stale answer
 * for the life of the instance.
 */
export function providerConfig(name: ProviderName): ProviderConfig | null {
	const [idVar, secretVar] = PROVIDER_VARS[name];

	const clientId = optional(idVar);
	const clientSecret = optional(secretVar);
	if (!clientId || !clientSecret) return null;

	return { host: providerHost(name), clientId, clientSecret };
}

/**
 * Where a provider lives, whether or not we hold credentials for it.
 *
 * For the plain links out - HCA's verification and address pages - which send
 * a person to the provider rather than asking it anything, so a missing client
 * secret is no reason for the page carrying them to fail.
 */
export function providerHost(name: ProviderName): string {
	const hostVar = PROVIDER_HOST_VARS[name];
	/* Still validated, just later. A malformed host that only fails at the
     redirect is worse than one that fails here with the variable's name. */
	return asUrl(hostVar, optional(hostVar) ?? PROVIDER_HOSTS[name]);
}

/** Which of a provider's variables are missing. For operator-facing output, and
 *  it reports names only - never values. */
export function missingProviderVars(name: ProviderName): string[] {
	return PROVIDER_VARS[name].filter((v) => !optional(v));
}

/** The same, but for code paths that cannot continue without it. */
export function requireProvider(name: ProviderName): ProviderConfig {
	const config = providerConfig(name);
	if (!config) {
		throw new ConfigError(
			`${name} is not configured. Missing: ${missingProviderVars(name).join(', ')}.`
		);
	}
	return config;
}

/** Whether a provider is usable at all. Used to decide what the UI offers. */
export function providerConfigured(name: ProviderName): boolean {
	return providerConfig(name) !== null;
}

/**
 * The shared secret the scheduler presents to /api/jobs/run.
 *
 * Sent as `Authorization: Bearer <value>` by whatever runs the jobs on a
 * schedule. One secret under one name serves the scheduler and a person with
 * curl, rather than two variables holding the same string and a rule about
 * keeping them equal.
 *
 * Tier two, and its absence DISABLES the endpoint rather than opening it. That
 * is the wiki's rule stated as bluntly as it can be: "an absent service key
 * should produce 503 or disabled behaviour, not bypass authentication." The
 * failure mode being guarded against is a deploy where the variable was
 * forgotten and the endpoint that runs jobs is briefly reachable by anyone who
 * guesses the path.
 *
 * It is compared with the constant-time helper in lib/crypto.ts. A bearer token
 * compared with `===` leaks its prefix through timing, and this one authorises
 * running every scheduled job in the application.
 */
export function cronSecret(): string | null {
	const value = optional('CRON_SECRET');
	if (!value) return null;
	/* A short token is a token somebody typed. Refusing it here rather than
     accepting it is the difference between a legible startup complaint and an
     endpoint protected by the word "secret". */
	if (value.length < 32) {
		throw new ConfigError(
			'CRON_SECRET must be at least 32 characters. Generate one with:  openssl rand -base64 32'
		);
	}
	return value;
}

/**
 * Ari, Hack Club's review platform, where projects shipped here are reviewed.
 *
 * Two secrets, one each way, both from Ari's Settings -> Webhooks for the
 * program, and never the same one:
 *
 * - ARI_INGEST_SECRET signs what Phantom sends (ships, and the status lookup's
 *   bearer token). Unset leaves the `ari.ingest` effect DEFERRED - a ship is
 *   recorded and goes out once it is set, the same rule as Airtable.
 * - ARI_WEBHOOK_SECRET verifies what Ari sends back. Unset makes
 *   /api/ari/webhook answer 503, which Ari retries, rather than accepting
 *   decisions nobody can check.
 *
 * ARI_PROGRAM is the program's id in Ari's ingest URLs. ARI_API_URL is only
 * for pointing at somewhere other than Ari's own host.
 */
export type AriConfig = {
	program: string;
	ingestSecret: string;
	host: string;
};

export function ariConfig(): AriConfig | null {
	const program = optional('ARI_PROGRAM');
	const ingestSecret = optional('ARI_INGEST_SECRET');
	if (!program || !ingestSecret) return null;
	const host = optional('ARI_API_URL') ?? 'https://webhooks.ari.hackclub.com';
	return { program, ingestSecret, host: asUrl('ARI_API_URL', host) };
}

/** Ari's review app, for links to a ship's review page. ARI_APP_URL only for
 *  pointing somewhere other than Ari's own host. */
export function ariAppUrl(): { host: string; program: string } | null {
	const program = optional('ARI_PROGRAM');
	if (!program) return null;
	const host = optional('ARI_APP_URL') ?? 'https://ari.hackclub.com';
	return { host: asUrl('ARI_APP_URL', host), program };
}

export function ariWebhookSecret(): string | null {
	return optional('ARI_WEBHOOK_SECRET') ?? null;
}

/**
 * Whether Slack notifications can be sent.
 *
 * Read here as well as in lib/effects/slack.ts so operator surfaces can say
 * "not configured" without importing the effect module - and so this file
 * remains the one place that answers "which integrations are on", which the
 * wiki asks for as startup output that reports enabled state and never values.
 */
export function slackConfigured(): boolean {
	return !!optional('SLACK_BOT_TOKEN') && !!optional('SLACK_CHANNEL_ID');
}

/**
 * The key that authorises uploads to the Hack Club CDN.
 *
 * Tier two: null when unset, and lib/server/cdn.ts turns that into a "screenshot
 * uploads are not available" message at the point of upload rather than a boot
 * failure - the rest of the app runs fine without it, and a project simply
 * cannot get a screenshot until it is configured. It is a bearer token, so it is
 * read here (never in client-reachable code) and only ever sent server-to-server
 * to the CDN.
 */
export function cdnApiKey(): string | null {
	return optional('CDN_API_KEY') ?? null;
}

/**
 * A GitHub token for checking, at ship time, that a repository is public.
 *
 * Optional. Without it the check uses GitHub's anonymous API, which allows 60
 * requests an hour per IP - and a check that cannot be made lets the ship
 * through rather than refusing it. A fine-grained token with no permissions
 * beyond public read is enough. Only ever sent server-to-server, to
 * api.github.com.
 */
export function githubToken(): string | null {
	return optional('GITHUB_TOKEN') ?? null;
}

/** The site as Plausible knows it, whether or not this host sends to it - the
 *  console's analytics page embeds its dashboard from anywhere. */
export function plausibleDomain(): string {
	return optional('PLAUSIBLE_DOMAIN') ?? 'phantom.hackclub.com';
}

/**
 * A Plausible Stats API key, for the console's analytics page to read the
 * dashboard's numbers and draw them itself (lib/server/plausible-stats.ts).
 *
 * Tier two: null when unset, and the page says so. A bearer token that reads
 * every number the dashboard shows, so it is only ever sent server to server,
 * to Plausible, and belongs in Orchard as a secret.
 */
export function plausibleApiKey(): string | null {
	return optional('PLAUSIBLE_API_KEY') ?? null;
}

/**
 * Where product analytics go: the site's domain as Plausible knows it, and the
 * event endpoint (plausible.io unless a proxy or a self-hosted instance is
 * set).
 *
 * On by default for production and nowhere else: the domain defaults to
 * phantom.hackclub.com, and with no PLAUSIBLE_DOMAIN set, analytics run only
 * on a request served at that host. A local checkout, a preview or staging
 * sends nothing, so its traffic never lands in production's numbers. Setting
 * the variable turns it on for whatever host is serving, against that domain.
 * Null is off. Neither value is a secret; the domain is printed into every page
 * for the browser tracker.
 */
export function plausibleConfig(host: string): { domain: string; endpoint: string } | null {
	const configured = optional('PLAUSIBLE_DOMAIN');
	const domain = plausibleDomain();
	if (!configured && host !== domain) return null;
	return {
		domain,
		endpoint: optional('PLAUSIBLE_ENDPOINT') ?? 'https://plausible.io/api/event'
	};
}

export type Env = typeof env;
