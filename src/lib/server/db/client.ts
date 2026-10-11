import { dev } from '$app/environment';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../env';
import * as schema from './schema';

/**
 * The database handle, and the one file that knows how we talk to Postgres.
 *
 * Everything else in the app imports `db` and never names a driver, so moving
 * hosts is an edit here rather than a sweep through the codebase: a move to
 * something like Cloudflare would want a different transport, and it would
 * change here.
 *
 * postgres-js is the choice that makes the move cheap. It speaks the ordinary
 * Postgres wire protocol over TCP, which is what local Postgres, a Node server
 * and Cloudflare Hyperdrive all accept - so the switch is a connection
 * string and a pool size, not a different client with a different API. The
 * alternative, a driver that tunnels Postgres over HTTP or WebSockets, would
 * have pinned us to one vendor's proxy and needed a shim to run locally at all.
 *
 * There is deliberately no branch in here on NODE_ENV or on which platform we
 * are running on. A connection layer that behaves differently in production is
 * one that cannot be tested before it gets there.
 */

/* One client per process, kept on the module scope.
 *
 * Vite reloads modules on every edit in development, and a fresh pool per reload
 * leaks connections until Postgres refuses new ones - `too many clients
 * already`, some minutes into a session, with no obvious cause. Stashing it on
 * globalThis outlives the module registry, which is the thing being replaced.
 * In production the module is evaluated once and this is simply a singleton. */
declare global {
	var phantomSql: ReturnType<typeof postgres> | undefined;
	var phantomLockSql: ReturnType<typeof postgres> | undefined;
}

function connect(max = 3) {
	return postgres(env.DATABASE_URL, {
		/* Three, not ten, and the number follows from how this code actually runs.
       Every handler here issues its queries sequentially - one request does one
       thing at a time - so a single instance never needs more than a couple of
       connections, and the ceiling that matters is Postgres's total across every
       warm instance rather than the throughput of any one of them. Ten slots per
       instance means a modest fan-out saturates the pooler and new instances get
       refused rather than queued. The spare two are headroom for a transaction
       holding one while something else on the same instance reads. */
		max,
		/* Long enough to survive the gaps between requests on a warm instance.
       Opening a connection is not cheap - TCP, then a TLS handshake that
       `sslmode=verify-full` makes several round trips, then authentication -
       and at twenty seconds a site with any pause in its traffic paid that
       again on nearly every request. Measured against the production database
       from outside its region, a cold connect was 1.5s where a query on an open
       one was 170ms: the handshake cost nine times the work.

       It is still a timeout rather than `0`. A platform that freezes an
       instance between requests should not leave a socket allocated on the
       server forever for an instance that may never wake; two minutes bounds
       that without paying the handshake inside a single visitor's session.
       `keepWarm` below pings well inside this, so on a long-running server the
       connection is never actually idle long enough to close. */
		idle_timeout: 300,
		/* Fail a stuck connect attempt rather than hanging a request until the
       platform's own timeout kills it, which produces a far less legible
       error. */
		connect_timeout: 10,
		/* Prepared statements are per-connection server-side state, and a
       transaction pooler hands out a different backend per transaction - so a
       statement prepared on one is missing on the next. Off, because that is
       the mode a hosted pooler is likely to be in, and the cost is small. */
		prepare: false,
		/* Postgres DATE has no time zone and no time of day. The driver's default
       is to parse it into a JS Date, which forces a UTC midnight through the
       host's local zone and can land the calendar day before - the classic
       birthday-off-by-one. Birthdates decide eligibility here, so dates stay
       the strings they are and are compared as calendar values. */
		types: {
			date: {
				to: 1082,
				from: [1082],
				serialize: (v: string) => v,
				parse: (v: string) => v
			}
		}
	});
}

const sql = globalThis.phantomSql ?? connect();
if (dev) globalThis.phantomSql = sql;

/**
 * Connections for job locks only - see `runJob` in lib/server/jobs.ts.
 *
 * A job holds its advisory lock on a connection reserved for the whole run,
 * and does its work through the pool above. When those reserved connections
 * came out of that same pool of three, three jobs starting at once on one
 * instance - a scheduled dispatch, a nudge from a request, another cron -
 * reserved all three, and each then waited forever for a connection to do its
 * work with. That instance could not run a query again until it restarted, and
 * every request routed to it hung until the gateway gave up.
 *
 * Its own pool, so a lock can never take a connection the application needs.
 * Four covers the jobs that run on a schedule at once; a fifth waits here for
 * one of them to finish, which it will, because none of them needs this pool
 * to make progress.
 */
export const lockSql = globalThis.phantomLockSql ?? connect(4);
if (dev) globalThis.phantomLockSql = lockSql;

export const db = drizzle(sql, { schema });

/**
 * Keep one connection open and warm.
 *
 * The first query on a cold pool pays TCP, TLS and authentication - measured at
 * 1.8s against the production database - and that cost lands on whichever
 * visitor happens to arrive first after a quiet spell. Called once from `init`
 * in hooks.server.ts, this opens the connection before any visitor needs it and
 * pings it every minute, inside `idle_timeout`, so it stays open. A serverless
 * platform may freeze the process between requests and the timer with it; that
 * loses nothing, since the next request warms it again.
 */
const KEEP_WARM_MS = 60_000;

declare global {
	var phantomKeepWarm: ReturnType<typeof setInterval> | undefined;
}

export async function keepWarm(): Promise<void> {
	const ping = async () => {
		try {
			await sql`select 1`;
		} catch (error) {
			console.error('database: keep-warm ping failed', error);
		}
	};
	if (globalThis.phantomKeepWarm) clearInterval(globalThis.phantomKeepWarm);
	globalThis.phantomKeepWarm = setInterval(ping, KEEP_WARM_MS);
	/* Never the reason the process stays alive. */
	globalThis.phantomKeepWarm.unref?.();
	await ping();
}

/** The raw handle. Needed for `select ... for update` and other statements that
 *  are easier to express in SQL than through the query builder. */
export { sql };

export type Db = typeof db;
