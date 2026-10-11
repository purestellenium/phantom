import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { can, requireCapability } from '$lib/server/auth/authorize';
import { airtableCredits, reviewerBoard } from '$lib/server/projects/reviewers';

/**
 * One reviewer's credits: every ship they first-passed that was sent to
 * Airtable, newest first.
 *
 * `key` is a user id, a bare Slack id for an Ari reviewer with no account
 * here, or `ari` for Ari's automatic decisions. The figures come from the same
 * board the list uses, so this page cannot disagree with the row that linked
 * to it.
 */
export const load: PageServerLoad = async ({ params }) => {
	const user = requireCapability('view_audit');

	const credits = await airtableCredits();
	const board = await reviewerBoard(credits);
	const person = board.find((row) => row.key === params.key);
	if (!person) error(404);

	const mine = credits.filter((credit) => credit.key === person.key);

	return {
		person,
		canOpenPeople: can(user, 'manage_users'),
		credits: mine.filter((credit) => credit.credited),
		unfiled: mine.filter((credit) => !credit.credited)
	};
};
