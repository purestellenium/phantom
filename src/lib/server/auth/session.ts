import { redirect } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { and, eq, isNull, lt, ne, sql as raw } from 'drizzle-orm';

import { recordAudit, type DbHandle } from '$lib/server/audit';
import { cookieOptions } from '$lib/server/auth/oauth';
import { hashSessionToken, newSessionToken } from '$lib/server/crypto';
import { db } from '$lib/server/db/client';
import { sessions, users, siteSettings } from '$lib/server/db/schema';

/** Session authority is read once per request and shared only through locals. */
/** The cookie name. Prefixed so it cannot collide with anything a platform or
 *  a reverse proxy sets on the same origin. */
export const SESSION_COOKIE = 'phantom_session';

/**
 * How long a session lives, absolutely.
 *
 * Thirty days, written once at creation and never moved. The schema says why:
 * extending this on use is a sliding window, and a sliding window means a
 * stolen session stays alive exactly as long as the thief keeps using it. The
 * cost is that a long-running participant signs in again once a month, which is
 * one HCA redirect they will usually not even see.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How often `lastSeenAt` is allowed to be written.
 *
 * Without a throttle this is a write on every authenticated request, including
 * every navigation and every prefetch - which turns a read-only page load into
 * a row update, and puts a write on the hot path of literally everything. Five
 * minutes is far finer than any question this column answers ("is this session
 * still in use", "which of my devices is active"), and it drops the write rate
 * by orders of magnitude.
 */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/** Exactly the user row. Exported under this name because the UI's props and
 *  helpers are typed against it, and re-deriving it in each consumer is how the
 *  two quietly stop matching. */
export type SessionUser = typeof users.$inferSelect;

export type ActiveSession = { user: SessionUser; sessionId: string; launched: boolean };

/* ── request metadata ────────────────────────────────────────────────────── */

/**
 * Truncate an address to its network prefix before it is stored.
 *
 * The feature this supports is "you were signed in from somewhere else", and a
 * /24 (or a /48 for v6) answers that just as well as a full address while being
 * dramatically less identifying. Storing the exact address would make the
 * sessions table a location history that nothing in the product needs, and the
 * schema comment commits to this happening here rather than at the database.
 */
export function toIpPrefix(address: string | null | undefined): string | null {
	if (!address) return null;
	const value = address.trim();
	if (!value) return null;

	if (value.includes(':')) {
		/* IPv6: the first three hextets is a /48, which is typically the site
       allocation and stops well short of the interface identifier. */
		const parts = value.split(':');
		return `${parts.slice(0, 3).join(':')}::/48`;
	}

	const octets = value.split('.');
	if (octets.length !== 4) return null;
	return `${octets.slice(0, 3).join('.')}.0/24`;
}

/**
 * The client address as the platform reports it.
 *
 * `x-forwarded-for` is a list and the LEFTMOST entry is the one the original
 * client sent - which means on a platform that appends rather than replaces, it
 * is also the one the client can forge. That is acceptable here and nowhere
 * else: this value is coarse provenance shown back to the user, never an input
 * to an authorization decision or a rate limit, where a spoofable address would
 * be a bypass.
 */
export function clientIpFrom(headers: Headers): string | null {
	const forwarded = headers.get('x-forwarded-for');
	if (forwarded) {
		const first = forwarded.split(',')[0]?.trim();
		if (first) return first;
	}
	return headers.get('x-real-ip');
}

/* ── creating ────────────────────────────────────────────────────────────── */

export type CreatedSession = {
	sessionId: string;
	/** The only copy of this value outside the browser. It is returned so the
	 *  caller can set the cookie, and must not be logged or stored. */
	token: string;
	expiresAt: Date;
};

/**
 * Mint a session.
 *
 * The token is 32 random bytes from a CSPRNG and the row holds only its
 * SHA-256, so read access to the sessions table yields nothing that can be
 * replayed - the same reason a password column holds a hash.
 *
 * Takes a database handle so a login can create the user, the provider account
 * and the session in one transaction. A session that commits independently of
 * the account it belongs to is a session that can outlive a rolled-back login.
 */
export async function createSession(
	input: {
		userId: string;
		userAgent?: string | null;
		ip?: string | null;
	},
	handle: DbHandle = db
): Promise<CreatedSession> {
	const token = newSessionToken();
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

	const [row] = await handle
		.insert(sessions)
		.values({
			userId: input.userId,
			tokenHash: hashSessionToken(token),
			expiresAt,
			/* Bounded before it reaches a column. User-Agent is client-controlled and
         unbounded, and this one is only ever rendered back as "Chrome on
         macOS"-ish provenance. */
			userAgent: input.userAgent?.slice(0, 512) ?? null,
			ipPrefix: toIpPrefix(input.ip)
		})
		.returning({ id: sessions.id });

	return { sessionId: row.id, token, expiresAt };
}

/* ── cookie ──────────────────────────────────────────────────────────────── */

/** Install the session cookie. HttpOnly so no script can read it, `Secure`
 *  wherever the origin is https, `SameSite=Lax` so it survives the OAuth
 *  callback's top-level navigation but not a cross-site POST, and `Path=/`
 *  because every route needs it. */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
	const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
	getRequestEvent().cookies.set(SESSION_COOKIE, token, await cookieOptions(maxAge));
}

export function clearSessionCookie(): void {
	getRequestEvent().cookies.delete(SESSION_COOKIE, { path: '/' });
}

/* ── reading ─────────────────────────────────────────────────────────────── */

/**
 * Resolve a request's cookie to a live session, or null.
 *
 * Called once per request, from the `handle` hook, which puts the answer on
 * `event.locals` - so a layout, a page and a form action inside the same
 * request share one query instead of issuing three. Locals are per-request, so
 * nothing leaks between users, which is the property that makes this safe to do
 * with a value this sensitive. Everything else reads `getSession()` below.
 *
 * The join is deliberate. Every caller wants the user, and fetching the session
 * and then the user is two round trips and a window where the user could be
 * deleted between them.
 */
export async function readSession(cookies: Pick<Cookies, 'get'>): Promise<ActiveSession | null> {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) return null;

	const tokenHash = hashSessionToken(token);

	const [row] = await db
		.select({
			user: users,
			sessionId: sessions.id,
			lastSeenAt: sessions.lastSeenAt,
			launched: siteSettings.launched
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.leftJoin(siteSettings, eq(siteSettings.id, 'singleton'))
		.where(
			and(
				eq(sessions.tokenHash, tokenHash),
				/* Both conditions in SQL, not in JavaScript. A revoked or expired
           session must never be materialised as an object that some later
           branch could forget to check. */
				isNull(sessions.revokedAt),
				raw`${sessions.expiresAt} > now()`
			)
		)
		.limit(1);

	if (!row) return null;
	touchLastSeen(row.sessionId, row.user.id, row.lastSeenAt);
	const session = { user: row.user, sessionId: row.sessionId, launched: row.launched ?? false };

	return session;
}

/** The session the hook resolved for this request, or null. */
export function getSession(): ActiveSession | null {
	return getRequestEvent().locals.session;
}

/**
 * Move `lastSeenAt` forward, at most once per throttle window.
 *
 * Not awaited. Nothing the response says depends on this write, and a write on
 * the request path is a visitor waiting on the database for a timestamp. It
 * runs on a long-lived server (adapter-node), where a promise outlives the
 * response; a platform that freezes the process on response would lose the
 * occasional stamp, which no question this column answers would notice.
 *
 */
function touchLastSeen(sessionId: string, userId: string, lastSeenAt: Date | null): Date | null {
	const now = Date.now();
	if (lastSeenAt && now - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) return lastSeenAt;

	const stamp = new Date(now);
	void Promise.all([
		db.update(sessions).set({ lastSeenAt: stamp }).where(eq(sessions.id, sessionId)),
		db.update(users).set({ lastSeenAt: stamp }).where(eq(users.id, userId))
	]).catch((error) => console.error('session: could not stamp lastSeenAt', error));
	return stamp;
}

/**
 * The signed-in user, or a redirect to the front door.
 *
 * `redirect` throws a control-flow signal that SvelteKit catches, so this never
 * returns for an anonymous caller and the call sites need no null check - which
 * is the point. It must not be wrapped in a try/catch that swallows unknown
 * errors, or the redirect turns into a rendered page for a user who is not
 * signed in.
 *
 * 303, because this is thrown from form actions as well as from loads, and a
 * redirect that answers a POST has to tell the browser to follow it with a GET.
 */
export function requireUser(): SessionUser {
	const session = getSession();
	if (!session) redirect(303, '/');
	return session.user;
}

/** The same, and also insists onboarding is finished. Separate from
 *  `requireUser` so the onboarding flow itself can use the weaker one without
 *  redirecting to itself forever. */
export function requireOnboarded(): SessionUser {
	const user = requireUser();
	if (!user.onboardedAt) redirect(303, '/onboarding');
	return user;
}

/* ── ending ──────────────────────────────────────────────────────────────── */

/**
 * End one session.
 *
 * Marks `revokedAt` rather than deleting the row, per the schema: "signed out"
 * and "never existed" are different facts, and only the first can answer a
 * support question about when someone was logged out and from where.
 *
 * The `isNull` guard makes this idempotent - a second revoke does not rewrite
 * the original timestamp, so the recorded moment stays the moment it actually
 * happened.
 */
export async function revokeSession(sessionId: string, handle: DbHandle = db): Promise<void> {
	await handle
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Every session this user has, including the caller's. For a password-reset
 *  equivalent, or an admin ending someone's access. */
export async function revokeAllSessions(userId: string, handle: DbHandle = db): Promise<number> {
	const revoked = await handle
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
		.returning({ id: sessions.id });
	return revoked.length;
}

/** Every session except the one making the request - "sign out my other
 *  devices", which is useless if it also signs you out. */
export async function revokeOtherSessions(
	userId: string,
	keepSessionId: string,
	handle: DbHandle = db
): Promise<number> {
	const revoked = await handle
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(
			and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId), isNull(sessions.revokedAt))
		)
		.returning({ id: sessions.id });
	return revoked.length;
}

/**
 * Sign out the current browser.
 *
 * This ends OUR session and nothing else. It deliberately does not attempt to
 * revoke the HCA or Hackatime tokens we hold, and the UI must not claim that it
 * does: HCA documents no client-callable revocation endpoint - revocation there
 * happens through the user's own HCA grant screen or the application owner's -
 * so a "signed out everywhere" message would be a promise this code cannot
 * keep. The stored tokens stay encrypted and stay valid until the user revokes
 * the grant upstream or it expires.
 *
 * The cookie is cleared regardless of whether a row was found, so a stale or
 * forged cookie does not survive a sign-out and keep producing a lookup on
 * every subsequent request.
 */
export async function signOutCurrent(): Promise<void> {
	const session = getSession();

	if (session) {
		await revokeSession(session.sessionId);
		await recordAudit({
			action: 'session.revoked',
			actorId: session.user.id,
			subjectId: session.user.id,
			metadata: { reason: 'sign_out', sessionId: session.sessionId }
		});
	}

	clearSessionCookie();
}

/**
 * Rotate away from whatever session this browser was holding, before a new one
 * is installed.
 *
 * This is the session-fixation defence and it is not optional. Without it, an
 * attacker who can plant a cookie on a victim's browser - a subdomain they
 * control, a shared machine, a network position on plain http - waits for the
 * victim to sign in and then holds a session identifier that is now
 * authenticated as the victim. Revoking the pre-auth session and minting a new
 * identifier means the value the attacker planted is dead the instant the login
 * completes.
 *
 * Revoked rather than merely replaced: overwriting the cookie would leave the
 * old row live, and the attacker still has the old token.
 */
export async function rotateExistingSession(handle: DbHandle = db): Promise<void> {
	const token = getRequestEvent().cookies.get(SESSION_COOKIE);
	if (!token) return;

	await handle
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)));
}

/* ── housekeeping ────────────────────────────────────────────────────────── */

/**
 * Delete sessions that expired long enough ago to be of no further interest.
 *
 * Removing expired sessions only lazily, when one happens to be looked up,
 * lets rows for people who simply stopped visiting accumulate forever - which is both an unbounded table and a pile of retained
 * user-agent and network data for accounts nobody is using.
 *
 * The grace period is the point of the delay: a session that expired an hour
 * ago is exactly what someone is asking about when they say "it logged me out",
 * so it stays readable for a while. After thirty days it is only ballast.
 * Revoked-but-unexpired rows are left alone; they expire on their own schedule
 * and are swept then.
 *
 * Returns the number deleted so a scheduled caller can log something useful.
 */
export async function sweepExpiredSessions(graceMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
	const deleted = await db
		.delete(sessions)
		.where(lt(sessions.expiresAt, new Date(Date.now() - graceMs)))
		.returning({ id: sessions.id });
	return deleted.length;
}

/** A user's live sessions, newest first. For a "where am I signed in" screen;
 *  it returns provenance only and never anything token-shaped. */
export async function listActiveSessions(userId: string) {
	return db
		.select({
			id: sessions.id,
			userAgent: sessions.userAgent,
			ipPrefix: sessions.ipPrefix,
			createdAt: sessions.createdAt,
			lastSeenAt: sessions.lastSeenAt,
			expiresAt: sessions.expiresAt
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				isNull(sessions.revokedAt),
				raw`${sessions.expiresAt} > now()`
			)
		)
		.orderBy(raw`${sessions.lastSeenAt} desc`);
}
