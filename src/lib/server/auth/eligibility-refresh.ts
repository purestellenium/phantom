import { and, eq, isNull } from 'drizzle-orm';

import { recordAudit } from '$lib/server/audit';
import {
	deriveEligibility,
	ELIGIBILITY_RULE,
	eligibilityIsFresh,
	type IdentitySignals
} from '$lib/server/auth/eligibility';
import {
	checkHcaIdentity,
	fetchHcaIdentity,
	getHcaAccessToken,
	hcaBackingOff
} from '$lib/server/auth/hca';
import { type SessionUser } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import { users, type EligibilityDecision } from '$lib/server/db/schema';
import { qualifyReferral } from '$lib/server/referrals';
import { staging, STAGING_SIGNALS } from '$lib/server/staging';

/**
 * Asking again.
 *
 * lib/auth/eligibility.ts decides; this is the half that goes and looks. They
 * are separate files for the reason that one states about itself: the decision
 * is pure, synchronous and callable from a test or a backfill, and the moment
 * it could reach for the network that stops being true.
 *
 * Every signal is observed at sign-in. After that, HCA is asked again only
 * when the person asks - the "check again" button on the verification notice,
 * `recheckEligibility` - because asking on page loads and before purchases
 * got this app rate limited by HCA once the program had a thousand people in
 * it. Everywhere else reads the stored decision: `currentEligibility`.
 *
 * The cost is staleness, and it is accepted with open eyes. Somebody verified
 * after signing in stays blocked until they press the button or sign in
 * again; an upstream ban lands at their next sign-in or re-check rather than
 * within the day. A session lasts thirty days, so that is the bound.
 */

/**
 * Both observations are required: the userinfo claim can report a new ban.
 *
 * The birthdate comes back ALONGSIDE the signals rather than inside them, and
 * that separation is deliberate. `IdentitySignals.birthdate` is the field
 * `deriveEligibility` is not allowed to read - see the note on HCA_SCOPES for
 * the failure it exists to prevent - so putting a real value there would put
 * it one careless edit away from becoming an eligibility input. It is captured
 * here only because this function already holds the userinfo response, and
 * because a participant who signed in before the scope was requested would
 * otherwise file an Airtable record with no Birthday until they next signed in.
 */
async function observe(
	user: SessionUser
): Promise<{ signals: IdentitySignals; birthdate: string | null }> {
	/* Staging mode has no HCA to ask; see lib/server/staging.ts. */
	if (staging) return { signals: STAGING_SIGNALS, birthdate: null };

	/* `checkHcaIdentity` turns every network failure into `unavailable` itself,
	   but it reads the provider configuration first and throws if HCA is not
	   configured at all. That is the right behaviour at a login, which cannot
	   proceed without the provider, and the wrong behaviour here: a re-check
	   against an unconfigured provider should say "could not check", not 500.
	   `unavailable` is the value the schema keeps for exactly this - we asked
	   and could not find out. */
	/* The two calls are independent, so they go together: somebody pressed a
	   button and is waiting on both. */
	const [checked, claims] = await Promise.all([
		checkHcaIdentity(user.hcaSubject).catch((error: unknown) => {
			console.error('eligibility: could not run the HCA identity check', error);
			return 'unavailable' as const;
		}),
		getHcaAccessToken(user.id)
			.then((token) => (token ? fetchHcaIdentity(token) : null))
			.catch((error: unknown) => {
				console.error('eligibility: could not refresh HCA claims', error);
				return null;
			})
	]);

	let identityCheckResult: IdentitySignals['identityCheckResult'] = checked;
	let verificationStatus = user.verificationStatus;
	let yswsEligibleClaim = user.yswsEligibleClaim;
	let birthdate: string | null = null;
	if (claims) {
		verificationStatus = claims.verificationStatus;
		yswsEligibleClaim = claims.yswsEligibleClaim;
		birthdate = claims.birthdate;
	} else {
		identityCheckResult = 'unavailable';
	}

	return {
		signals: {
			verificationStatus,
			yswsEligibleClaim,
			identityCheckResult,
			/* Never read by the rule, whatever is in the column. See
			   deriveEligibility, and the note on HCA_SCOPES. */
			birthdate: null
		},
		birthdate
	};
}

/**
 * Decide from an observation and write it, guarded against a concurrent writer.
 * Returns the decision in force afterwards, and the columns written - null when
 * another writer got there first.
 */
async function store(
	user: SessionUser,
	{ signals, birthdate }: Awaited<ReturnType<typeof observe>>,
	trigger: 'recheck'
): Promise<{ decision: EligibilityDecision; written: Partial<SessionUser> | null }> {
	const outcome = deriveEligibility(signals);
	const now = new Date();
	const columns = {
		/* Only when this observation actually carried one. An absent claim means
		   the scope was not granted or userinfo could not be reached, neither of
		   which is a reason to clear a date already on file. */
		...(birthdate ? { birthdate } : {}),
		verificationStatus: signals.verificationStatus,
		verificationStatusAt: now,
		yswsEligibleClaim: signals.yswsEligibleClaim,
		yswsEligibleClaimAt: now,
		identityCheckResult: signals.identityCheckResult,
		identityCheckAt: now,
		eligibility: outcome.decision,
		eligibilityAt: now,
		eligibilityRule: outcome.rule,
		updatedAt: now
	};

	const [updated] = await db
		.update(users)
		.set(columns)
		.where(
			and(
				eq(users.id, user.id),
				user.eligibilityAt
					? eq(users.eligibilityAt, user.eligibilityAt)
					: isNull(users.eligibilityAt)
			)
		)
		.returning({ id: users.id });
	if (!updated) {
		const [current] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
		return {
			decision:
				current && eligibilityIsFresh(current.eligibilityAt) ? current.eligibility : 'undetermined',
			written: null
		};
	}

	/* The decision that makes an invited, onboarded person count for whoever
	   invited them. Cheap to skip: most people were not invited, or already
	   count. */
	if (outcome.decision === 'eligible' && user.referredByUserId && !user.referralQualifiedAt) {
		await qualifyReferral(user.id);
	}

	/* The same action the sign-in callback records, with the same fields, because
	   it is the same event - somebody looked, and this is what they saw. A second
	   verb for "we looked outside a login" would split one question ("what have
	   we ever observed about this person") across two searches. `trigger` is what
	   tells them apart, and `from` is here because a re-check is the one path
	   where the previous decision is worth reading beside the new one. */
	await recordAudit({
		action: 'identity.observed',
		subjectId: user.id,
		metadata: {
			verificationStatus: signals.verificationStatus,
			yswsEligibleClaim: signals.yswsEligibleClaim,
			identityCheckResult: signals.identityCheckResult,
			eligibility: outcome.decision,
			eligibilityRule: outcome.rule,
			from: user.eligibility,
			trigger
		}
	});

	return { decision: outcome.decision, written: columns };
}

/**
 * Ask HCA again because the person asked us to - the "check again" button.
 *
 * Once per RECHECK_INTERVAL_MS per person, however often it is pressed, and
 * one observation shared by concurrent presses. An observation that could
 * not reach HCA writes NOTHING: a hiccup is not a reason to turn somebody's
 * standing into "we could not tell", and the stored decision stays in force.
 *
 * Updates the request's session user in place, so the rest of the request
 * sees the new answer.
 */
export async function recheckEligibility(
	user: SessionUser
): Promise<'checked' | 'too_soon' | 'unavailable'> {
	if (hcaBackingOff()) return 'unavailable';

	const now = Date.now();
	if (now - (lastAsked.get(user.id) ?? 0) < RECHECK_INTERVAL_MS) return 'too_soon';

	let pending = inFlight.get(user.id);
	if (!pending) {
		lastAsked.set(user.id, now);
		pending = observe(user).finally(() => inFlight.delete(user.id));
		inFlight.set(user.id, pending);
	}
	const observation = await pending;
	if (observation.signals.identityCheckResult === 'unavailable') return 'unavailable';
	const { written } = await store(user, observation, 'recheck');
	if (written) Object.assign(user, written);
	return 'checked';
}

/** Long enough that the button cannot be used to hammer HCA, short enough
 *  that somebody who just finished verifying is not kept waiting. */
export const RECHECK_INTERVAL_MS = 2 * 60_000;
/** When each person last asked, successful or not - so an outage, which
 *  writes nothing, cannot be retried on every press. */
const lastAsked = new Map<string, number>();
const inFlight = new Map<string, ReturnType<typeof observe>>();

/**
 * The decision to gate on, right now: the stored one, with no network call.
 *
 * Call this at a mutation and pass the result to `eligibilityAllows`, which is
 * still the only thing that reads a decision as a yes or a no. A decision made
 * under an older rule is re-derived from the stored signals - the rule is pure,
 * so changing it needs no trip to HCA either.
 */
export async function currentEligibility(user: SessionUser): Promise<EligibilityDecision> {
	if (user.eligibilityRule === ELIGIBILITY_RULE) return user.eligibility;
	return deriveEligibility({
		verificationStatus: user.verificationStatus,
		yswsEligibleClaim: user.yswsEligibleClaim,
		identityCheckResult: user.identityCheckResult,
		birthdate: null
	}).decision;
}
