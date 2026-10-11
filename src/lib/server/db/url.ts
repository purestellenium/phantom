/**
 * The connection string, normalised the one way everything that opens Postgres
 * needs it - and the two different places the raw string is read from.
 *
 * `normalizeDatabaseUrl` is dependency-free on purpose. It is imported by the
 * application (through env.ts), by the seed script, and by drizzle.config.ts - a
 * CLI config that must not have to satisfy the whole application's config
 * module. Every one of those needs the same string normalised the same way, and
 * the last time this logic lived in only one of them, `db:migrate` failed
 * against a URL the app itself could open.
 *
 * Where the raw string COMES FROM differs by caller, deliberately. The
 * application reads it from `$env/dynamic/private` via env.ts, so a `bun run dev`
 * that never exported the variable still finds it in `.env` - SvelteKit loads
 * the file, node does not. The CLI tooling cannot reach `$env`: it runs outside
 * SvelteKit's bundling, so `databaseUrl()` reads `process.env`, which bun
 * populates from `.env` for a script it runs itself.
 */

/**
 * Normalise a connection string. Pure - takes the raw URL, returns the one the
 * driver can actually open. See `databaseUrl()` for the CLI's `process.env` read.
 */
export function normalizeDatabaseUrl(url: string): string {
	/* Work around a driver bug, without weakening what the URL asked for.
	 *
	 * postgres-js maps `sslmode` to its own option and deletes it, but handles
	 * `sslrootcert=system` WITHOUT deleting it - so that parameter survives and is
	 * sent to the server as a startup option, and Postgres refuses the connection
	 * with `unrecognized configuration parameter "sslrootcert"`. The URL is
	 * therefore rejected for asking to verify harder than the default.
	 *
	 * `system` means "trust the platform's CA store", which is what Node does
	 * anyway, and the driver already reads it as a request for `verify-full`. So
	 * the parameter is dropped and `verify-full` asserted in its place: the chain
	 * and the hostname are still verified, whether or not `sslmode` was given too.
	 *
	 * Only this one value is touched. `sslrootcert=/path/to/ca.pem` is a different
	 * request that this cannot honour, so it is left alone to fail loudly rather
	 * than be silently downgraded to the system store.
	 */
	const parsed = new URL(url);
	if (parsed.searchParams.get('sslrootcert') === 'system') {
		parsed.searchParams.delete('sslrootcert');
		parsed.searchParams.set('sslmode', 'verify-full');
		return parsed.toString();
	}
	return url;
}

/**
 * The connection string from the process environment, normalised.
 *
 * For the CLI tooling - drizzle.config.ts and the migrate script - which runs
 * outside SvelteKit and so cannot import `$env`. The application does not use
 * this: it reads DATABASE_URL through env.ts, off `$env/dynamic/private`, and
 * this function is never on the request path.
 */
export function databaseUrl(): string {
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
	}
	return normalizeDatabaseUrl(url);
}
