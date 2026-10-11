import { desc, eq, sql as raw } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { db } from '$lib/server/db/client';
import { ledgerAccounts, users } from '$lib/server/db/schema';
import { personMatches } from '$lib/server/people';

/**
 * Everyone, searchable.
 *
 * The search is a GET form so a result set is a URL - an operator can send
 * somebody the link to what they were looking at, and the back button works.
 *
 * The balance comes from the cached projection rather than a sum per row: this
 * is a list, the number is informational, and summing the ledger once per row
 * would be a query per person. The place that number is authoritative is a
 * spend, and a spend replays it under a lock.
 */
export const load: PageServerLoad = async ({ url }) => {
	requireCapability('manage_users');
	const term = url.searchParams.get('q')?.trim() || null;

	const rows = await db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			slackUsername: users.slackUsername,
			role: users.role,
			capabilities: users.capabilities,
			createdAt: users.createdAt,
			balance: ledgerAccounts.cachedBalance
		})
		.from(users)
		.leftJoin(ledgerAccounts, eq(ledgerAccounts.userId, users.id))
		/* Name, email, HCA subject, Slack id or handle - the definition lives in
		   `personMatches` because the projects list asks the same question about a
		   project's owner, and two copies of "what you can search a person by" is
		   how one page comes to know about Slack ids and the other does not. */
		.where(term ? personMatches(term) : raw`true`)
		.orderBy(desc(users.createdAt))
		.limit(100);

	return { term, rows };
};
