import { defineConfig } from 'drizzle-kit';

import { databaseUrl } from './src/lib/server/db/url';

/**
 * Migration tooling config.
 *
 * The connection string comes from src/lib/server/db/url.ts, the same place
 * the application gets it — not from `process.env` directly and not from
 * env.ts, which validates the whole application config and reads SvelteKit's
 * environment module, neither of which a CLI that needs one string should have
 * to satisfy. Reading it raw here is what made `db:migrate` fail against a URL
 * the app could open.
 *
 * Migrations are generated as SQL files and committed. Pushing a schema
 * straight at a database is fine for a scratch branch and wrong for anything
 * with data in it: the generated file is the thing that gets reviewed, and it
 * is the only record of what a deploy is about to do.
 */
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: { url: databaseUrl() },
	/* Named constraints and indexes, so a later migration can refer to them
	   rather than to whatever the database happened to generate. */
	verbose: true,
	strict: true
});
