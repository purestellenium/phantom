import type {
	EligibilityDecision,
	IdentityCheckResult,
	VerificationStatus
} from '$lib/server/db/schema';

/**
 * One function. Every gate calls it. There is no second opinion anywhere.
 *
 * This file exists because of the specific failure the schema describes: gate
 * project submission on the external identity check and the shop on the
 * `verification_status` claim, and the same person can be eligible for one and
 * refused by the other, with nothing in either code path that would reveal the
 * two questions had different answers. The fix is not "be careful";
 * it is that no other module is allowed to look at the raw signals and reach a
 * conclusion. They read `users.eligibility`, which this produced.
 *
 * It is pure and synchronous on purpose. It performs no I/O, so it can be
 * called from a test, from a backfill, and from a request handler and give the
 * same answer; and the callers fetch the signals, which keeps "what did we
 * observe" and "what did we decide" as two separable steps.
 */

/**
 * The rule's version, stored alongside every decision in
 * `users.eligibilityRule`.
 *
 * Bump this whenever the mapping below changes in a way that could move
 * somebody between decisions. Rows keep the version that produced them, so
 * "why was I blocked in October" is answerable from the row instead of from a
 * git blame - and a re-derivation under a newer rule is visible as a version
 * change rather than being silent.
 */
export const ELIGIBILITY_RULE = '2026-08-11.1';

/**
 * How old a stored decision may be and still be acted on.
 *
 * A decision is an OBSERVATION, and it was being treated as a fact with no
 * expiry: the signals behind it are refreshed when somebody signs in, sessions
 * last thirty days, and nothing in between ever asked again - so a participant
 * banned upstream in week one kept buying through week four on the strength of
 * a check made before the ban existed. Nothing in the gates could see that,
 * because "eligible" and "eligible as of a month ago" are the same value in the
 * column.
 *
 * No longer a trigger for asking HCA again: that happens only at sign-in and
 * on the "check again" button, because re-asking on a timer got the app rate
 * limited (see eligibility-refresh.ts). What is left of it is the guard in
 * `store` against a concurrent writer's stale answer.
 */
export const ELIGIBILITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a decision made at this moment can still be used.
 *
 * A null timestamp is stale: it means the column was written by something that
 * did not record when it looked, and an undated observation cannot be shown to
 * be recent.
 */
export function eligibilityIsFresh(at: Date | null, now = Date.now()): boolean {
	if (!at) return false;
	const age = now - at.getTime();
	return age >= 0 && age < ELIGIBILITY_MAX_AGE_MS;
}

/** Everything the rule is allowed to look at. Assembled by the caller from the
 *  user row or from a fresh set of observations; the function cannot reach for
 *  anything that is not in here. */
export type IdentitySignals = {
	/** The `verification_status` claim. `unknown` when it was absent. */
	verificationStatus: VerificationStatus;
	/** The `ysws_eligible` claim. Null when it was absent, which is NOT false. */
	yswsEligibleClaim: boolean | null;
	/** The public check's result, on its own separate value set. Null when we
	 *  have never asked. */
	identityCheckResult: IdentityCheckResult | null;
	/** Present in the type because the column exists. Deliberately unused - see
	 *  the note on birthdate below. */
	birthdate: string | null;
};

export type EligibilityOutcome = {
	decision: EligibilityDecision;
	/** The version that produced it, to be stored with it. */
	rule: string;
	/** One sentence for an operator or a support conversation. Not user-facing
	 *  copy - see `explainEligibility` for that. */
	reason: string;
};

/**
 * Decide.
 *
 * Two things about the shape of this are deliberate and worth defending.
 *
 * FIRST, it fails closed. Every path that is not an affirmative "verified and
 * youth-eligible" is a block or an `undetermined`, and an upstream failure -
 * recorded upstream of here as `unavailable` - becomes `undetermined`, which no
 * gate treats as permission. The tempting alternative is to fall back to an age
 * computed locally from the birthdate claim when the identity check errors,
 * which lets an HCA outage quietly promote a weaker signal into the deciding one.
 *
 * `birthdate` IS now requested and IS now stored - the YSWS records base has a
 * Birthday column - so the fallback stopped being impossible and became merely
 * forbidden, which is a weaker guarantee and worth saying out loud. What keeps
 * it forbidden is the signature: this function reads `IdentitySignals`, every
 * caller hands it `birthdate: null`, and the column is not reachable from here.
 * A future rule that genuinely gates on age is a new ELIGIBILITY_RULE and a
 * deliberate decision, not this one quietly acquiring an input.
 *
 * `blocked_age` therefore never appears under this rule version; it stays in
 * the enum because a future rule that does gate on age would need it, and
 * adding an enum value later is a migration that cannot share a transaction
 * with the code that uses it.
 *
 * SECOND, the check result decides, not the claim. The wiki is emphatic that
 * `verified` on the claim means "an approved verification exists" and says
 * nothing about age, and that verified adults are routinely `verified` and
 * ineligible at once. The external check answers the eligibility question
 * directly, which is why it is worth a second network call.
 *
 * The one place the claim overrides the check is `ineligible`, which is HCA's
 * own state for permabanned or fatally rejected. That can only ever tighten the
 * outcome - it turns an `eligible` into a block and never the reverse - and
 * letting a check result outrank a ban would be the wrong direction to fail in.
 */
export function deriveEligibility(signals: IdentitySignals): EligibilityOutcome {
	const outcome = (decision: EligibilityDecision, reason: string): EligibilityOutcome => ({
		decision,
		rule: ELIGIBILITY_RULE,
		reason
	});

	if (signals.verificationStatus === 'ineligible') {
		return outcome(
			'blocked_rejected',
			'HCA reports this identity as ineligible, which is its state for a ' +
				'permanent ban or a fatally rejected verification. This overrides the ' +
				'identity check result.'
		);
	}

	switch (signals.identityCheckResult) {
		case 'verified_eligible':
			return outcome(
				'eligible',
				"HCA's identity check reports a verified, youth-eligible identity."
			);

		case 'verified_but_over_18':
			return outcome(
				'blocked_over_18',
				"HCA's identity check reports a verified identity that is over the " + 'youth age limit.'
			);

		case 'rejected':
			return outcome('blocked_rejected', "HCA's identity check reports this identity as rejected.");

		case 'needs_submission':
		case 'pending':
		case 'not_found':
			return outcome(
				'blocked_unverified',
				`HCA's identity check reports ${signals.identityCheckResult}: there is ` +
					'no completed verification to act on yet. This is expected to change ' +
					'once the user finishes verifying, and should be re-derived then.'
			);

		case 'unavailable':
			return outcome(
				'undetermined',
				"HCA's identity check could not be reached, so nothing was decided. " +
					'Fail closed and retry; do not substitute a weaker signal.'
			);

		case null:
			return outcome('undetermined', 'The identity check has not been run for this user yet.');
	}
}

/**
 * Whether a decision permits access to gated features.
 *
 * A one-line reader over the stored column, not a second derivation - it never
 * touches the raw signals. It is here rather than at each call site so that
 * `undetermined` cannot be accidentally read as permission by a gate written in
 * a hurry, which is the shape the original bug took.
 */
export function eligibilityAllows(decision: EligibilityDecision): boolean {
	return decision === 'eligible';
}

/** User-facing copy, kept next to the decisions so a new enum value is a type
 *  error here rather than a blank space on a page. */
const EXPLANATIONS = {
	eligible: "You're verified and eligible.",
	blocked_age: "Your age doesn't meet the program's requirements.",
	blocked_over_18:
		'Hack Club programs are for people 18 and under, and your verified identity is over that.',
	blocked_rejected:
		"Hack Club Identity rejected this verification. Contact Hack Club support if you think that's wrong.",
	blocked_unverified:
		'You need to finish identity verification with Hack Club before you can take part.',
	undetermined:
		"We couldn't reach Hack Club Identity to check your verification. Try again in a few minutes."
} satisfies Record<EligibilityDecision, string>;

export function explainEligibility(decision: EligibilityDecision): string {
	return EXPLANATIONS[decision];
}
