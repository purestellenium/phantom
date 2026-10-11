import type { DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import { siteSettings } from '$lib/server/db/schema';

/**
 * The launch gate: whether the site is open, and who gets in when it is not.
 *
 * Two things here guard against specific failures rather than following
 * general good sense, and both are worth stating plainly.
 *
 * FIRST, bypass comes from the database and only from the database. Reading
 * admins from an environment variable, reviewers from a table, and - inside the
 * OAuth callback - a THIRD legacy environment list of reviewer IDs lets the
 * three disagree. The result is a reviewer who exists in the database and not
 * in the variable being authorized on every page in the app and rejected at the
 * one place that matters: login. `canBypassLaunch` below reads exactly one
 * field, `users.role`, and there is no environment fallback anywhere in the
 * request path. ADMIN_HCA_SUBJECTS seeds that column on first sign-in and is
 * never consulted again.
 *
 * SECOND, this is evaluated before a user is sent to a provider, never after
 * they come back. Running the entire OAuth round trip, creating a session, and
 * THEN deleting it if the user lacks bypass means the expensive, user-visible
 * part of the flow happens for people who were always going to be refused, and
 * the deletion races anything else that has already read the new session. Here the check happens at the start route and the session, once
 * created, is never destroyed to enforce a gate.
 */

/**
 * Fifteen seconds between reads, which is the right
 * trade: being that stale on the day of launch is not a problem anyone will
 * notice, and anything longer starts to matter when an operator flips the
 * switch and then reloads to check.
 *
 * What it must never be is a wait. This is read on essentially every request,
 * and a database round trip on the request path - even one in fifteen seconds
 * - is a visitor who gets a blank screen for as long as the database takes to
 * answer. So the cache is stale-while-revalidate: a request always gets the
 * value already in memory, and a value past its age is refreshed in the
 * background for the next one. The only request that ever waits is the very
 * first after the process starts, and `init` in hooks.server.ts warms the
 * cache before that request arrives.
 */
const LAUNCH_CACHE_MS = 15_000;
/* How long that first request is allowed to wait before it is answered
   "closed", which is the safe direction for this particular failure. */
const LAUNCH_FIRST_WAIT_MS = 2_000;

/**
 * Every operator switch, read together.
 *
 * The shop window rides along rather than getting a cache of its own, and that
 * is worth stating: they live in the same singleton row, so a second reader
 * would be a second query and a second TTL for one table - and the two would
 * then be able to answer from different moments, which is precisely the class of
 * bug the singleton constraint exists to prevent. One read, one cache, one
 * staleness to reason about.
 */
export type LaunchSettings = {
	launched: boolean;
	prelaunchMessage: string | null;
	shopOpen: boolean;
	shopClosesAt: Date | null;
	shopClosedMessage: string | null;
};

type CacheEntry = { settings: LaunchSettings; readAt: number };

/* On globalThis for the same reason as the database handle: development
   replaces the module registry on every edit, and a cache that resets on each
   one is not a cache. */
declare global {
	var phantomLaunchCache: CacheEntry | null | undefined;
	var phantomLaunchRefresh: Promise<void> | null | undefined;
}

/* No row means the seed has not run. Treated as closed rather than as an
   error, because the honest answer to "are we launched" on an unseeded
   database is no. Closed is also what an unreachable database answers: an
   outage that throws the doors open for a program that has not started is much
   worse than one that keeps them shut for a few seconds. */
const CLOSED: LaunchSettings = {
	launched: false,
	prelaunchMessage: null,
	shopOpen: false,
	shopClosesAt: null,
	shopClosedMessage: null
};

async function readLaunch(): Promise<LaunchSettings | null> {
	try {
		const [row] = await db
			.select({
				launched: siteSettings.launched,
				prelaunchMessage: siteSettings.prelaunchMessage,
				shopOpen: siteSettings.shopOpen,
				shopClosesAt: siteSettings.shopClosesAt,
				shopClosedMessage: siteSettings.shopClosedMessage
			})
			.from(siteSettings)
			.limit(1);
		return row ?? CLOSED;
	} catch (error) {
		console.error('launch gate: could not read site_settings', error);
		return null;
	}
}

/** One refresh in flight at a time; everyone who asks meanwhile shares it. A
 *  failed read keeps whatever was there - stale but real beats flipping a live
 *  site closed because one query timed out. */
export function refreshLaunch(): Promise<void> {
	if (!globalThis.phantomLaunchRefresh) {
		globalThis.phantomLaunchRefresh = readLaunch()
			.then((settings) => {
				if (settings) globalThis.phantomLaunchCache = { settings, readAt: Date.now() };
			})
			.finally(() => {
				globalThis.phantomLaunchRefresh = null;
			});
	}
	return globalThis.phantomLaunchRefresh;
}

/**
 * The launch settings, from memory.
 *
 * Never waits on the database once there is a value to give. A value past its
 * age starts a refresh and is returned as it is; the next request gets the
 * fresh one.
 */
export async function launchSettings(): Promise<LaunchSettings> {
	const cached = globalThis.phantomLaunchCache;
	if (cached) {
		if (Date.now() - cached.readAt >= LAUNCH_CACHE_MS) void refreshLaunch();
		return cached.settings;
	}

	/* Nothing in memory yet: the one time a request waits, and only this long. */
	await Promise.race([
		refreshLaunch(),
		new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_FIRST_WAIT_MS))
	]);
	return globalThis.phantomLaunchCache?.settings ?? CLOSED;
}

export async function isLaunched(): Promise<boolean> {
	return (await launchSettings()).launched;
}

/**
 * The switches straight off the row, with no cache anywhere in the way.
 *
 * For a MUTATION, and only for a mutation. Everything above answers "what
 * should this page render", where fifteen seconds of staleness is invisible and
 * a database round trip on every request is not. This answers "may this
 * actually happen", where the trade runs the other way round: the cache is
 * per-process, so an operator closing the shop on one instance leaves every
 * other instance selling from a value it has no reason to re-read, and a
 * refresh that fails keeps the old answer indefinitely by design. That is the
 * right behaviour for a gate on a page and the wrong behaviour for a gate on a
 * sale.
 *
 * Takes a handle so the caller can read it INSIDE the transaction that is about
 * to act on the answer, which is also what makes the read consistent with
 * everything else that transaction sees.
 *
 * It throws rather than falling back to `CLOSED`. A caller is inside a
 * transaction: an exception rolls the whole thing back, which is the only
 * failure mode that cannot half-happen. `CLOSED` would be indistinguishable
 * from a deliberately closed shop and would tell a buyer the shop is shut when
 * the truth is that we could not tell.
 */
export async function launchSettingsNow(handle: DbHandle = db): Promise<LaunchSettings> {
	const [row] = await handle
		.select({
			launched: siteSettings.launched,
			prelaunchMessage: siteSettings.prelaunchMessage,
			shopOpen: siteSettings.shopOpen,
			shopClosesAt: siteSettings.shopClosesAt,
			shopClosedMessage: siteSettings.shopClosedMessage
		})
		.from(siteSettings)
		.limit(1);
	/* No row is the unseeded database, and the honest answer there is the same
	   one `launchSettings` gives: nothing is open. */
	return row ?? CLOSED;
}

/**
 * Whether this user gets in while the site is closed.
 *
 * The parameter is deliberately the narrowest thing that answers the question,
 * and the value it reads must have come from the `users` row. Passing a role
 * assembled from anywhere else - a token claim, an environment list, a header -
 * reintroduces exactly the disagreement described at the top of this file.
 *
 * Anonymous is never a bypass, and that is not a limitation: signing in is how
 * someone demonstrates they are staff, and the sign-in routes are on the public
 * allowlist so a staff member can always reach one. What the gate then refuses
 * is the app, not the login - which is why the callback never destroys a
 * session it just created.
 */
export function canBypassLaunch(user: { role: string } | null): boolean {
	if (!user) return false;
	return user.role === 'owner' || user.role === 'admin' || user.role === 'reviewer';
}

/**
 * Paths that work while the site is closed.
 *
 * Narrow on purpose - an allowlist that grows to cover "the marketing pages"
 * stops being a gate. Only three kinds of thing belong here: the closed page
 * itself, the routes that let someone prove they are staff, and the framework's
 * own asset paths, without which the closed page renders unstyled.
 */
/* /login is the staff door: it decides for itself who may pass (see
   routes/login/+server.ts), so the gate lets it be reached. */
const PUBLIC_EXACT = new Set(['/', '/login', '/favicon.ico', '/robots.txt']);

const PUBLIC_PREFIXES = [
	/* Every auth route, including the callbacks. A gate that blocked the callback
     would make it impossible for anyone to ever demonstrate they have bypass. */
	'/api/auth/',
	'/_app/'
];

export function isPublicPath(pathname: string): boolean {
	if (PUBLIC_EXACT.has(pathname)) return true;
	return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * The endpoints that are NOT behind the gate, and why each one is out.
 *
 * `/api/auth/` is how somebody demonstrates they have bypass, so gating it
 * would make the gate unopenable. `/api/jobs/` is a machine route holding its
 * own bearer token and is not reached by a browser at all, and `/api/ari/` is
 * the same: the feed Ari polls with its own bearer token, which never carries a
 * session and so was refused here before its token was ever read. `/api/signup` is the
 * closed site's one working control: the waitlist on the landing page, which
 * exists precisely for the period before launch.
 */
const UNGATED_API = ['/api/auth/', '/api/jobs/', '/api/ari/'];

/**
 * Whether this endpoint is behind the launch gate.
 *
 * An ALLOWLIST, so a route added tomorrow is gated by default and someone has
 * to come here and argue for the exception. The gate used to key on the
 * `(app)` route group alone, which is a true statement about the pages and a
 * false one about the data behind them: `/api/projects` and `/api/showcase`
 * serve exactly the rows those pages serve and sat outside the group, so
 * closing the platform redirected a participant away from /projects and
 * answered them 200 on the endpoint underneath it. A gate the data walks
 * around is not a gate.
 */
export function isGatedApi(pathname: string): boolean {
	if (!pathname.startsWith('/api/')) return false;
	if (pathname === '/api/signup') return false;
	return !UNGATED_API.some((prefix) => pathname.startsWith(prefix));
}

/**
 * The endpoints that answer without a session, but still wait for launch.
 *
 * A third state, and it exists because the other two do not fit. `UNGATED_API`
 * means "answers before the site is open", which the catalog must not: what the
 * program is offering is ours to announce, and an endpoint that reads it out
 * while the front page still says "closed" has announced it. Ordinary gating
 * means "answers a launched site, to a signed-in caller", and the whole point
 * of a public endpoint is the second half of that.
 *
 * So: open when the site is open, to anybody. A prefix rather than an exact
 * match, so a later `/api/shop/<slug>` is covered by the decision made here
 * rather than by somebody forgetting to make it again.
 *
 * Still an allowlist. A new route is gated by default and lands in neither of
 * these lists until someone writes down why it belongs.
 */
const PUBLIC_API = ['/api/shop'];

export function isPublicApi(pathname: string): boolean {
	return PUBLIC_API.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The whole gate in one call, for a page or a route that wants a yes/no.
 *
 * Having this here rather than as three lines repeated at each call site is the
 * point: it is one place to read when someone asks what the rule is, and one
 * place to change when it moves.
 */
export async function launchAllows(
	user: { role: string } | null,
	pathname?: string,
	launched?: boolean
): Promise<boolean> {
	if (pathname && isPublicPath(pathname)) return true;
	if (canBypassLaunch(user)) return true;
	if (launched !== undefined) return launched;
	return (await launchSettingsNow()).launched;
}

/** Re-read the flag now. For the admin action that flips the switch, so the
 *  operator who just changed it does not spend fifteen seconds wondering
 *  whether it took. The old value stays until the new one has arrived, so no
 *  request in between waits. */
export function invalidateLaunchCache(): Promise<void> {
	return refreshLaunch();
}
