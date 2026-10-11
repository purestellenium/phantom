import type { PageServerLoad } from './$types';

import { can, requireCapability } from '$lib/server/auth/authorize';
import { inviterBoard, recentInvitees, referralGlance } from '$lib/server/referrals';
import { REFERRAL_MILESTONES } from '$lib/referral';

/**
 * Who has brought people in, who they brought, and what it has paid.
 *
 * `view_audit`, like the reviewer board: it names people, read for oversight,
 * and nothing here mutates. The console's front page carries only the counts
 * so that the names are one deliberate click away rather than on the page
 * every operator lands on. Rows link through to a person only for a reader
 * who can open people, since that page would refuse anyone else.
 */
export const load: PageServerLoad = async () => {
	const user = requireCapability('view_audit');

	const [glance, board, recent] = await Promise.all([
		referralGlance(90),
		inviterBoard(),
		recentInvitees()
	]);

	/* The busiest inviter sets the scale, as on the reviewer board. */
	const most = Math.max(1, ...board.map((row) => row.joined));

	return {
		glance,
		canOpenPeople: can(user, 'manage_users'),
		milestones: REFERRAL_MILESTONES.map((milestone) => ({
			count: milestone.count,
			seconds: milestone.seconds,
			reached: board.filter((row) => row.qualified >= milestone.count).length
		})),
		board: board.map((row, index) => ({
			...row,
			rank: index + 1,
			share: row.joined / most
		})),
		recent
	};
};
