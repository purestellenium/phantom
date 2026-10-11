import { createRows, emailField, listRows, signUpFormat, updateRows } from '$lib/server/airtable';
import { db } from '$lib/server/db/client';
import { submissions, users } from '$lib/server/db/schema';
import type { JobResult } from '$lib/server/jobs';
import { mergePeople, planLoopsSync } from '$lib/server/loops-plan';

/**
 * Keeping "Loops - Sign Ups" in step with Phantom, for the `loops.sync` job.
 *
 * Everybody who has ever signed in gets a row - eligible or not, staff or not,
 * because Loops filters on its own side and a row we never wrote is a contact
 * it cannot reach. Each row says when the account was made and whether its
 * owner has ever shipped (any submission, whatever became of it). What to write
 * is decided in lib/server/loops-plan.ts; this reads both sides and sends it.
 */

/**
 * The most rows one run writes. A first run against an empty table is every
 * account at once, and at Airtable's five requests a second that is minutes;
 * capped, it fills over a few runs instead of holding the job lock and a
 * scheduler step open for the whole of it. After that a run writes a handful.
 */
const MAX_WRITES = 2000;

export async function syncLoops(): Promise<JobResult> {
	const accounts = await db
		.select({ id: users.id, email: users.email, signedUpAt: users.createdAt })
		.from(users);

	/* Its own query, not an `exists` beside the account columns. Selecting from
	   one table, drizzle writes column names without their table, so a
	   correlated subquery came out as `where "user_id" = "id"` - the
	   submission's own id - and nobody had ever shipped. */
	const shipped = new Set(
		(await db.selectDistinct({ userId: submissions.userId }).from(submissions)).map(
			(row) => row.userId
		)
	);

	const format = await signUpFormat();
	const people = mergePeople(
		accounts.map(({ id, email, signedUpAt }) => ({ email, signedUpAt, shipped: shipped.has(id) }))
	);
	const plan = planLoopsSync(people, await listRows(), emailField(), format);

	const creates = plan.creates.slice(0, MAX_WRITES);
	const updates = plan.updates.slice(0, MAX_WRITES - creates.length);
	await createRows(creates);
	await updateRows(updates);

	const remaining = plan.creates.length + plan.updates.length - creates.length - updates.length;

	return {
		counts: {
			accounts: accounts.length,
			emails: people.size,
			created: creates.length,
			updated: updates.length,
			unchanged: plan.unchanged,
			remaining,
			duplicateRows: plan.duplicateRows,
			/* False until the field is changed from Created time to a date in
			   Airtable; until then every row's sign-up time is when the sync made
			   it, and the run says so rather than looking clean. */
			signUpWritable: format !== null
		},
		needsAttention: format === null
	};
}
