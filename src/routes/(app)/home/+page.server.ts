import { desc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

import { eligibilityAllows } from '$lib/server/auth/eligibility';
import { fetchHackatimeSeconds, getLinkedHackatime } from '$lib/server/auth/hackatime';
import { recordEvent } from '$lib/server/analytics';
import { recheckEligibility } from '$lib/server/auth/eligibility-refresh';
import { hcaVerifyUrl } from '$lib/server/auth/hca';
import { requireOnboarded } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import { submissions } from '$lib/server/db/schema';
import { providerConfigured } from '$lib/server/env';
import { cachedBalance } from '$lib/server/ledger';
import { parseProjectNames, projectsForUser } from '$lib/server/projects/projects';
import { lastApprovedByProject, newWorkFromClaim } from '$lib/server/projects/review';
import { productBySlug, purchasabilityOf } from '$lib/server/shop/catalog';
import { referralSummary } from '$lib/server/referrals';
import { inviteOrder, inviteProduct } from '$lib/server/shop/invite';
import { shopWindow } from '$lib/server/shop/window';
import { staging } from '$lib/server/staging';
import { INVITE_PARAM, REFERRAL_STICKERS_SLUG } from '$lib/referral';

/**
 * The signed-in home.
 *
 * Where you stand - what is with a reviewer, what it is worth, what you have to
 * spend - then progress toward the invite, then what a fresh account has not
 * done yet beside the card for inviting friends.
 *
 * Orders are deliberately not here. They live off the shop page, where the
 * thing they are about lives, the same way the nav stopped carrying a tab for
 * them: a home page is for what to do next, and an order that is already placed
 * is not something to do.
 */
export const load: PageServerLoad = async ({ url }) => {
	const user = requireOnboarded();
	const [balance, list, hackatime, ticketOrder, invite, window, rows, referral, stickers] =
		await Promise.all([
			cachedBalance(user.id),
			projectsForUser(user.id),
			getLinkedHackatime(user.id),
			/* The order that made the invite theirs, or null. The boolean half of it
		   decides whether the panel shows a meter or a stub; the row itself is
		   what the stub is made of. */
			inviteOrder(user.id),
			/* The prize itself, and whether the shop is open - both for the link
		   below the meter. Neither is a gate: `purchase` re-reads all of this
		   inside the transaction. They only decide what is drawn. */
			inviteProduct(),
			shopWindow(),
			/**
			 * Their submissions, in the same breath as everything else.
			 *
			 * Keyed on the SUBMITTER rather than on a list of project ids, which is
			 * the point: by project id this had to wait for `projectsForUser` to come
			 * back before it could even be sent, and against a database a round trip
			 * away that wait is most of what it costs. A submission is always its
			 * project's owner's, so the two questions have the same answer, and
			 * `submissions_user_idx` on (user_id, created_at) is the index for exactly
			 * this shape.
			 */
			db
				.select({
					projectId: submissions.projectId,
					state: submissions.state,
					stateAt: submissions.stateAt,
					createdAt: submissions.createdAt,
					claimedSeconds: submissions.claimedSeconds
				})
				.from(submissions)
				.where(eq(submissions.userId, user.id))
				.orderBy(desc(submissions.createdAt)),
			/* Their invite link and how far it has got them. See lib/server/referrals.ts. */
			referralSummary(user.id),
			/* Whether the stickers can be claimed yet: until an operator activates
			   the product, "claim" would lead to a 404. */
			productBySlug(REFERRAL_STICKERS_SLUG)
		]);

	/* Each project's latest submission, the same way the projects page badges
	   them: the newest row per project wins, and a project with none is a draft. */
	const latest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) if (!latest.has(row.projectId)) latest.set(row.projectId, row);

	/**
	 * The hours actually up for review, which is not the same as the hours
	 * claimed.
	 *
	 * `claimedSeconds` is cumulative - the whole Hackatime total for the linked
	 * projects at the moment of the ship - so a project approved for 10h and
	 * reshipped at 14h is claiming 14 and asking for 4. Printing 14 would tell
	 * somebody they have hours pending that they were paid for a fortnight ago.
	 * `newWorkFromClaim` is the review module's own definition of the delta, and
	 * borrowing it is what stops this page and the reviewer's screen disagreeing
	 * about the same submission.
	 *
	 * One batched query for the baselines rather than one per project, for the
	 * reason written on `lastApprovedByProject`: the database is a round trip
	 * away and this runs on every visit to the home page.
	 */
	const openIds = [...latest]
		.filter(([, row]) => ['pending', 'first_passed', 'changes_requested'].includes(row.state))
		.map(([projectId]) => projectId);

	const baselines = openIds.length ? await lastApprovedByProject(openIds) : new Map();

	const awaiting = openIds.reduce((total, id) => {
		const claimed = latest.get(id)?.claimedSeconds ?? 0;
		/* Floored per project, so one project whose Hackatime total shrank since
		   its last approval cannot eat the hours another is genuinely waiting on. */
		return total + Math.max(0, newWorkFromClaim(claimed, baselines.get(id) ?? null));
	}, 0);

	/**
	 * Every Hackatime project any of their projects has claimed, drafts included.
	 *
	 * The union rather than a per-project sum, and the two are the same figure:
	 * one Hackatime project may be claimed by one Phantom project (see
	 * `claimedElsewhere`), so no name can appear twice and nothing is
	 * double-counted. A draft contributes exactly as much as a shipped project
	 * does - the names are on the working copy, and shipping is what puts them
	 * in front of a reviewer, not what starts the clock.
	 */
	const claimedNames = [
		...new Set(list.flatMap((project) => parseProjectNames(project.hackatimeProjects)))
	];

	/* Having the invite is having a secured order for it, and nothing else. */
	const invited = ticketOrder !== null;

	/**
	 * The ticket, if there is one worth pointing at, or null.
	 *
	 * It is a LINK to the product page rather than a purchase: one place sells
	 * the invite, and it is the one with the quantity, the options, the address
	 * picker and every refusal written out. A second buy button here was a
	 * second implementation of all of that, and it could only exist by refusing
	 * to be drawn in every case it did not handle - an invite with a size on it
	 * simply had no button, on the page whose entire subject is that invite.
	 *
	 * The conditions are the ones the button already had, minus one: it no longer
	 * requires the invite to ask nothing, because options are answerable at the
	 * far end of the link. The prize exists and is on sale, the shop is open,
	 * they are allowed to buy it, and the balance covers it - below that the
	 * panel is a meter and the note above it says how much is left, which is the
	 * more useful thing to say to somebody who cannot buy it yet.
	 *
	 * NOT A GATE in any sense. `purchase` re-reads the price, the stock, the
	 * window, the eligibility and the per-person limit inside the transaction.
	 */
	const ticket =
		invite &&
		!invited &&
		!purchasabilityOf(invite) &&
		window.open &&
		(!invite.requiresEligibility || eligibilityAllows(user.eligibility)) &&
		balance >= invite.price
			? { slug: invite.slug, name: invite.name, price: invite.price }
			: null;

	/**
	 * The goal, in seconds: what the invite costs, read off the invite.
	 *
	 * The product with the reserved slug decides this and nothing else does.
	 * There used to be a `GOAL_HOURS = 50` here beside a price of 50h in the
	 * catalog, kept in step by whoever remembered both - so repricing the invite
	 * in the console moved what it costs without moving what the bar counts
	 * toward, and the page went on promising a number the shop would not honour.
	 * One value, in the console, where an operator already edits everything else
	 * about it.
	 *
	 * Null when nobody has created the invite, and the panel is then not drawn:
	 * a meter counting toward nothing in particular is worse than no meter.
	 *
	 * The meter under it reads the SPENDABLE BALANCE rather than lifetime
	 * earnings, because the goal is not "log fifty hours", it is "be able to buy
	 * the invite" - and hours spent on stickers are hours no longer available for
	 * it. That makes it a savings bar, and it can genuinely go down.
	 */
	const goalSeconds = invite?.price ?? null;

	return {
		/* Only what the greeting needs. The role was here for a staff-only notice
		   about the site being closed, which told the people who close the site
		   that the site was closed. */
		user: {
			displayName: user.displayName,
			email: user.email
		},
		/**
		 * Whether they have chosen an address to ship to - the default on their
		 * account, a pointer at one of Hack Club's.
		 *
		 * Read from our own column rather than asking Hack Club. This used to
		 * fetch their address list on every home load, which was one of the
		 * calls that got the app rate limited; the address pages still read it
		 * live, and so does shipping, which is where an address actually has to
		 * exist. Somebody with an address on Hack Club but no default picked here
		 * sees the step as not done, and picking one is what it asks of them.
		 */
		hasAddress: user.defaultAddressId !== null,
		/**
		 * Both identity signals, because they answer different questions and the
		 * notice needs both to avoid saying something false.
		 *
		 * `eligibility` is our decision and the thing the shop and the ship button
		 * actually gate on. `verificationStatus` is Hack Club's claim, and it is
		 * what separates "you have not sent anything yet" - where telling somebody
		 * to go and verify is the right advice - from "it is with Hack Club and
		 * being looked at", where the same sentence would be asking them to do a
		 * thing they have already done.
		 */
		eligibility: user.eligibility,
		verificationStatus: user.verificationStatus,
		/* Where "verify" goes. Resolved on the server because it is built from the
		   configured HCA host. */
		verifyUrl: hcaVerifyUrl(),
		/**
		 * Hours logged, read live off Hackatime rather than off the ledger.
		 *
		 * This used to be `earnedSeconds` - everything a reviewer had ever granted
		 * - under a label that says "logged", which are different figures and the
		 * gap between them is most of what a participant is waiting on. Somebody
		 * forty hours into a draft had logged forty hours and been granted none,
		 * and the page told them they had done nothing. So the tile now counts
		 * what the name says: tracked time on the Hackatime projects their
		 * projects have claimed, whatever state those projects are in.
		 *
		 * AI-coded time counts at a third here: the stats endpoint splits the
		 * "ai coding" category out of the raw total, and the tile shows the raw
		 * total minus two thirds of that split. Ships and reviews still freeze
		 * and grant the raw claim, so this tile deliberately reads lower than a
		 * submission's frozen claim wherever AI did some of the typing.
		 *
		 * It is therefore no longer a monotonic figure the ledger can vouch for.
		 * It is Hackatime's number, it moves while they work, and it owes nothing
		 * to what has been approved - `balance` below is still the only thing the
		 * goal is measured in, and the only thing anything is bought with.
		 *
		 * STREAMED, for the same reason the address is: it costs calls to
		 * another company, and nothing else on the page waits for it. Null is
		 * "we could not count" - unlinked, token refused, Hackatime unreachable -
		 * and is drawn as such rather than as a zero, which would be a claim.
		 * Empty list of names short-circuits to 0 inside the fetch, so a fresh
		 * account spends no request on it.
		 */
		logged: {
			seconds: fetchHackatimeSeconds(user.id, claimedNames, { adjustForAi: true }).catch(() => null)
		},
		balance,
		goalSeconds,
		/* Whether the goal has already been met, which is a different question
		   from what the balance says today: buying the invite drains the balance
		   by exactly the figure the bar was counting toward, so a panel that only
		   knew the balance would empty itself at the moment the goal was reached.
		   This is what replaces the bar with where they are going instead. */
		invited,
		/* The stub's contents, and null for everybody who has not bought one -
		   which is the same fact `invited` carries, in the form the panel needs. */
		ticketOrder,
		ticket,
		projects: {
			/* Everything started, drafts included: the figure is "projects
			   created", and a project with no submission yet is still one. */
			count: list.length
		},
		/* Hours waiting on a decision - the new work up for review, not the
		   cumulative claim. See the note where it is computed. */
		awaiting,
		referral: {
			/* Staging always shows the production address, so the card looks the way
			   it will on phantom.hackclub.com whatever host the dev server is on. */
			link: `${staging ? 'https://phantom.hackclub.com' : url.origin}/?${INVITE_PARAM}=${referral.code}`,
			joined: referral.joined,
			qualified: referral.qualified,
			stickersClaimed: referral.stickersClaimed,
			stickersOpen: stickers !== null && stickers.active && purchasabilityOf(stickers) === null
		},
		hackatimeLinked: hackatime !== null,
		/* Staging fakes a linked Hackatime for everybody, so it shows the step
		   too - done - and the checklist has the same three rows as production. */
		hackatimeConfigured: staging || providerConfigured('hackatime')
	};
};

export const actions: Actions = {
	/**
	 * "check again" on the verification notice: the one way, besides signing
	 * in, that this app asks Hack Club about somebody's standing. Rate-limited
	 * per person in `recheckEligibility`; the page reloads its data afterwards,
	 * so a newly verified person's notice simply goes away.
	 */
	recheck: async () => {
		const user = requireOnboarded();
		const recheck = await recheckEligibility(user);
		recordEvent('eligibility.rechecked', { outcome: recheck });
		return { recheck };
	}
};
