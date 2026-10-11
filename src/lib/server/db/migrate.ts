/**
 * Apply the migrations, then the constraints Drizzle cannot express.
 *
 * `drizzle-kit migrate` generates its SQL from lib/db/schema.ts, and a trigger
 * is not something that schema can describe - so the append-only enforcement
 * would be a file somebody has to remember to run by hand, which is the same as
 * not having it. Running both from one command is what makes "the database
 * refuses to rewrite history" true of every environment rather than of whichever
 * ones an operator got to.
 *
 * Both halves are idempotent, so this is safe to re-run and safe to resume after
 * a failure.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import postgres from 'postgres';

import { databaseUrl } from './url';

const migrate = spawnSync('bunx', ['drizzle-kit', 'migrate'], {
	stdio: 'inherit'
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const sql = postgres(databaseUrl());
try {
	await sql.unsafe(await readFile(new URL('./append-only.sql', import.meta.url), 'utf8'));
	console.log('append-only triggers applied');
} finally {
	await sql.end();
}
