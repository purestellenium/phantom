import type { PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { airtableCredits, reviewerBoard } from '$lib/server/projects/reviewers';

/**
 * Who has first-passed the ships that went to Airtable.
 *
 * `view_audit`, as the board always was: it names people, read for oversight,
 * and nothing here mutates. What counts as a credit, and why only the first
 * pass, is in lib/server/projects/reviewers.ts.
 */
export const load: PageServerLoad = async () => {
	requireCapability('view_audit');

	const credits = await airtableCredits();
	const rows = await reviewerBoard(credits);

	/* The busiest reviewer sets the scale every bar is drawn against. */
	const most = Math.max(1, ...rows.map((row) => row.credited));

	return {
		reviewers: rows.map((row, index) => ({
			...row,
			rank: row.credited > 0 ? index + 1 : null,
			share: row.credited / most
		})),
		totals: {
			credited: rows.reduce((sum, row) => sum + row.credited, 0),
			week: rows.reduce((sum, row) => sum + row.week, 0),
			month: rows.reduce((sum, row) => sum + row.month, 0),
			creditedSeconds: rows.reduce((sum, row) => sum + row.creditedSeconds, 0),
			active: rows.filter((row) => row.credited > 0).length,
			/* Filings whose first pass could not be told apart. */
			uncredited: credits.filter((credit) => credit.credited && !credit.key).length
		}
	};
};
