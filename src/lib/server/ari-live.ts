import { desc, eq } from 'drizzle-orm';

import { ariStatus } from '$lib/server/ari';
import { db } from '$lib/server/db/client';
import { ariShips } from '$lib/server/db/schema';

/**
 * Where a submission in review is on Ari, in the participant's words - for
 * the project page, which used to say "under review" and nothing else from
 * the ship to the decision.
 *
 * Asked of Ari's status endpoint, which knows the phase; Phantom only hears
 * about decisions. Cached for a minute per ship, so a page reloaded or a few people looking
 * cost one request, and never thrown: Ari not answering is a page that just
 * says "under review", as it did before.
 */

export type ReviewPhase = 'sending' | 'checking' | 'queued' | 'reviewing' | 'final';

/** The phases in order, as the project page's review timeline draws them. */
export const PHASE_ORDER: ReviewPhase[] = ['sending', 'checking', 'queued', 'reviewing', 'final'];

/** What each phase reads as on the project page. */
export const PHASE_LABELS: Record<ReviewPhase, string> = {
	sending: 'on its way to review',
	checking: 'being checked before review',
	queued: 'waiting for a reviewer',
	reviewing: 'a reviewer is looking at it now',
	final: 'reviewed - waiting for a final check'
};

/* How Ari's phases read on the project page. In this program's setup the
   checks that can follow a reviewer's decision are shown together as "a final
   check". */
const ARI_PHASES: Record<string, ReviewPhase> = {
	processing: 'checking',
	fraud_review: 'final',
	review: 'queued',
	under_review: 'reviewing',
	second_pass: 'final'
};

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; phase: ReviewPhase | null }>();

/**
 * The phase of a submission that is waiting on Ari, or null when there is
 * nothing to add to "under review" - Ari unreachable or not configured, or
 * already decided (its delivery is on the way, and the page will say so).
 */
export async function reviewPhase(submissionId: string): Promise<ReviewPhase | null> {
	const [ship] = await db
		.select({ ariId: ariShips.ariId })
		.from(ariShips)
		.where(eq(ariShips.submissionId, submissionId))
		.orderBy(desc(ariShips.createdAt))
		.limit(1);
	/* Shipped here, not yet on Ari: the send is queued in the outbox. */
	if (!ship) return 'sending';

	const cached = cache.get(ship.ariId);
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.phase;

	let phase: ReviewPhase | null;
	try {
		const status = await ariStatus({ id: ship.ariId });
		phase = status ? (ARI_PHASES[status.phase] ?? null) : null;
	} catch {
		phase = null;
	}
	cache.set(ship.ariId, { at: Date.now(), phase });
	/* A bound on the cache: an entry older than its minute is worth nothing. */
	if (cache.size > 500) {
		for (const [key, entry] of cache) if (Date.now() - entry.at >= CACHE_MS) cache.delete(key);
	}
	return phase;
}
