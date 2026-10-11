import type {
	EligibilityDecision,
	LedgerEntryType,
	OrderState,
	OutboxStatus,
	SubmissionState,
	VerificationStatus
} from '$lib/server/db/schema';
import type { ProjectStatus } from '$lib/server/projects/projects';
import { inLocalTime } from '$lib/time.svelte';

/**
 * The two identity enums, said in words a person can act on.
 *
 * They are kept in one file because the dashboard and the account page both
 * show them, and a state that is called "pending" on one screen and "waiting on
 * Hack Club" on the other is two states as far as the reader is concerned.
 *
 * Typed as a total Record over each enum on purpose. The schema is explicit
 * that a new value appearing upstream should surface as something to look at
 * rather than silently collapsing into a falsy default - with a Record, adding
 * one to the database enum breaks the build here until somebody decides what it
 * should say, which is exactly the moment to decide it.
 *
 * The tone is a class off the badge ramp and never a colour. Only red survives
 * the seven-level quantiser as a hue (see globals.css), so `is-bad` is spent on
 * things that are actually wrong and everything else is bright or dim.
 */

type Tone = 'is-good' | 'is-waiting' | 'is-bad' | 'is-approved' | 'is-changes';

export type StateLabel = {
	/** The word on the badge. */
	label: string;
	tone: Tone;
	/** One line under the row, saying what it means and who has the ball. */
	hint: string;
};

/** The `verification_status` claim: whether an identity verification exists. */
export const VERIFICATION = {
	verified: {
		label: 'verified',
		tone: 'is-good',
		hint: 'Hack Club has confirmed who you are.'
	},
	pending: {
		label: 'pending',
		tone: 'is-waiting',
		hint: 'your submission is with Hack Club. nothing to do but wait.'
	},
	needs_submission: {
		label: 'not submitted',
		tone: 'is-waiting',
		hint: 'Hack Club has not seen anything from you yet. verifying is what unlocks the rest.'
	},
	ineligible: {
		label: 'refused',
		tone: 'is-bad',
		hint: "Hack Club's records say this account cannot be verified. email phantom@hackclub.com if that looks wrong."
	},
	/* Not a no. The claim is absent - the scope was not granted, or the field was
     simply not in the response - and the wiki is explicit that an absent field
     must not be read as an empty one. */
	unknown: {
		label: 'unknown',
		tone: 'is-waiting',
		hint: 'we were not told either way. that is not the same as a no; signing in again usually settles it.'
	}
} satisfies Record<VerificationStatus, StateLabel>;

/**
 * Our own eligibility decision, which answers a different question from the
 * claim above and routinely disagrees with it - a verified adult is verified
 * and ineligible at the same time. Both are shown, side by side, rather than
 * merged into one green tick that would have to pick which one it meant.
 */
export const ELIGIBILITY = {
	eligible: {
		label: 'eligible',
		tone: 'is-good',
		hint: 'you can take part.'
	},
	blocked_age: {
		label: 'too young',
		tone: 'is-bad',
		hint: 'phantom is for 13 to 18 year olds. come back on your birthday - the account keeps.'
	},
	blocked_over_18: {
		label: 'over 18',
		tone: 'is-bad',
		hint: 'phantom is for 13 to 18 year olds. you are welcome in Hack Club, just not in this one.'
	},
	blocked_rejected: {
		label: 'refused',
		tone: 'is-bad',
		hint: 'Hack Club refused this identity check. email phantom@hackclub.com and we will look at it with you.'
	},
	blocked_unverified: {
		label: 'unverified',
		tone: 'is-waiting',
		hint: 'verify your identity with Hack Club and this answers itself.'
	},
	undetermined: {
		label: 'undetermined',
		tone: 'is-waiting',
		hint: 'we have not worked this out yet. it settles once Hack Club has answered.'
	}
} satisfies Record<EligibilityDecision, StateLabel>;

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/**
 * A timestamp broken into the numbers a format needs, in whichever zone is
 * currently true.
 *
 * UTC for the server's render, the reader's own zone once the browser has
 * taken over - see $lib/time.svelte.ts for why that is two phases rather than
 * one. Reading `inLocalTime()` here is what subscribes every caller to the
 * switch, so `day` and `stamp` stay plain functions and their call sites stay
 * `{day(x)}`.
 *
 * A UTC stamp is not a cosmetic difference for anyone west of it: 8pm on the
 * 13th in Philadelphia is the 14th in UTC, so a shipped-on date was reading a
 * day late for most of the people this is built for.
 */
function parts(date: Date) {
	return inLocalTime()
		? {
				year: date.getFullYear(),
				month: date.getMonth() + 1,
				day: date.getDate(),
				hour: date.getHours(),
				minute: date.getMinutes()
			}
		: {
				year: date.getUTCFullYear(),
				month: date.getUTCMonth() + 1,
				day: date.getUTCDate(),
				hour: date.getUTCHours(),
				minute: date.getUTCMinutes()
			};
}

/**
 * A date, as a calendar day.
 *
 * ISO order rather than a locale one, still: it sorts, and it lines up under
 * .row-value's tabular figures, which is what a column of them needs. What has
 * changed is the ZONE the numbers are read in, not the shape they are written
 * in - `toLocaleDateString` would have given the reader their own zone and the
 * server's locale at the same time, which is a different format on every
 * deployment and none of them sortable.
 */
export function day(date: Date | null): string {
	if (!date) return '-';
	const at = parts(date);
	return `${at.year}-${pad(at.month)}-${pad(at.day)}`;
}

/**
 * A date and the time of day. For a log where two rows on the same date need
 * to be told apart.
 *
 * Twelve-hour with AM/PM, and the hour is padded - `06:41 PM` rather than
 * `6:41 PM`. Padding is not the usual convention for a twelve-hour clock and
 * it is deliberate here: these sit in columns of tabular figures, and an
 * unpadded hour makes every row before ten in the morning a character narrower
 * than the rest, which is exactly the ragged edge the ISO date above exists to
 * avoid. It also keeps both render phases the same width, so nothing shifts
 * when the zone switches on load.
 */
export function stamp(date: Date | null): string {
	if (!date) return '-';
	const at = parts(date);
	const meridiem = at.hour < 12 ? 'AM' : 'PM';
	const hour = at.hour % 12 === 0 ? 12 : at.hour % 12;
	return `${at.year}-${pad(at.month)}-${pad(at.day)} ${pad(hour)}:${pad(at.minute)} ${meridiem}`;
}

/* ── the economy, said in words ──────────────────────────────────────────── */

/**
 * Seconds, as hours.
 *
 * The ledger stores seconds because that is what Hackatime counts and what an
 * approval credits, and every price is in seconds for the same reason. Nobody
 * thinks in seconds. So the storage unit and the display unit are different on
 * purpose, and this is the only place the conversion happens - a second one
 * somewhere else is how a shop page and a statement end up disagreeing about
 * what the same number means.
 *
 * One decimal place. Two is a precision the underlying number does not have in
 * any way a person cares about, and none turns every short session into "0h".
 */
export function hours(seconds: number): string {
	return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * The same conversion, as a number rather than a label.
 *
 * For a caller that is handing the figure to something other than a reader -
 * an API response, where a consumer wants to compare and add prices and cannot
 * do either with "8h". It lives here beside the formatters and not at the call
 * site precisely because of what this file's note above says: a second `/3600`
 * somewhere else is how two surfaces end up disagreeing about what the same
 * number means, and that is as true of a JSON body as of a page.
 *
 * Two decimal places. A catalog is priced in whole hours and option surcharges
 * are authored in hours, so this rounds off float noise rather than real
 * precision - 1.0000000000000002 is not a price anybody set.
 */
export function hoursValue(seconds: number): number {
	return Math.round((seconds / 3600) * 100) / 100;
}

/** Whole hours, for a price. A catalog is priced in round hours and "8.0h"
 *  reads as a measurement rather than a tag. */
export function wholeHours(seconds: number): string {
	return `${Math.round(seconds / 3600)}h`;
}

/** The same, signed, for a ledger row where the direction is the point. The
 *  minus comes from the number; the plus has to be added, or a statement reads
 *  as a list of costs with some of them mysteriously negative. */
export function signedHours(seconds: number): string {
	const rendered = hours(Math.abs(seconds));
	return seconds < 0 ? `−${rendered}` : `+${rendered}`;
}

/** Where an order is. Total over the enum, so a new state is a type error here
 *  until somebody writes the sentence for it. */
export const ORDER_STATE = {
	placed: {
		label: 'placed',
		tone: 'is-waiting',
		hint: 'with us. nothing for you to do.'
	},
	on_hold: {
		label: 'on hold',
		tone: 'is-waiting',
		hint: 'someone is looking at this one. we will be in touch if we need anything.'
	},
	fulfilled: {
		label: 'fulfilled',
		tone: 'is-good',
		hint: 'done.'
	},
	rejected: {
		label: 'rejected',
		tone: 'is-bad',
		hint: 'we could not fill this. the fragments are back in your balance.'
	},
	cancelled: {
		label: 'cancelled',
		tone: 'is-waiting',
		hint: 'cancelled. the fragments are back in your balance.'
	},
	unfulfilled: {
		label: 'unfulfilled',
		tone: 'is-changes',
		hint: 'something went wrong after this was sent. we are sorting it out and will reship or refund it.'
	}
} satisfies Record<OrderState, StateLabel>;

/** Where a submission is, for the participant. `first_passed` (the old
 *  on-platform two-step's middle state) reads as "in review" too. */
export const SUBMISSION_STATE = {
	pending: {
		label: 'in review',
		tone: 'is-good',
		hint: 'with a reviewer. nothing to do but wait.'
	},
	first_passed: {
		label: 'in review',
		tone: 'is-good',
		hint: 'a reviewer has looked; a final check confirms it.'
	},
	approved: {
		label: 'approved',
		tone: 'is-approved',
		hint: 'approved - the fragments are yours.'
	},
	rejected: {
		label: 'rejected',
		tone: 'is-bad',
		hint: 'not approved this time. read the note, then reship.'
	},
	revoked: {
		label: 'revoked',
		tone: 'is-bad',
		hint: 'the approval was withdrawn and its fragments taken back. read the note.'
	},
	changes_requested: {
		label: 'changes requested',
		tone: 'is-changes',
		hint: 'a reviewer asked for changes. make them and mark them done to keep your place in the queue.'
	},
	reverted: {
		label: 'taken back',
		tone: 'is-changes',
		hint: 'the decision on this ship was taken back. you can ship it again.'
	}
} satisfies Record<SubmissionState, StateLabel>;

/**
 * Where a PROJECT stands, as against where a submission does.
 *
 * The two are different questions and this one is only ever asked on operator
 * surfaces - a project is an editable working copy and its owner reads its
 * state off the ship panel and the history, not off a badge. `draft` is the
 * value the participant-facing enum has no equivalent for, because a project
 * that has never been shipped has no submission to have a state.
 */
export const PROJECT_STATUS = {
	draft: {
		label: 'draft',
		tone: 'is-waiting',
		hint: 'never shipped. only the owner has seen it.'
	},
	review: {
		label: 'in review',
		tone: 'is-good',
		hint: 'a submission is open on it.'
	},
	approved: {
		label: 'approved',
		tone: 'is-approved',
		hint: 'at least one ship has been approved.'
	},
	rejected: {
		label: 'rejected',
		tone: 'is-bad',
		hint: 'shipped and turned down, with nothing approved since.'
	}
} satisfies Record<ProjectStatus, StateLabel>;

/** What a ledger row is. The words a participant reads on their statement. */
export const ENTRY_TYPE = {
	submission_award: 'approved work',
	admin_adjustment: 'adjustment',
	order_debit: 'purchase',
	order_refund: 'refund',
	reversal: 'reversal',
	referral_reward: 'referral reward'
} satisfies Record<LedgerEntryType, string>;

/** Where an outbox row stands. Operator-facing, so these say what to do rather
 *  than how it feels. */
export const OUTBOX_STATUS = {
	pending: {
		label: 'pending',
		tone: 'is-waiting',
		hint: 'waiting for the next dispatch run.'
	},
	delivered: {
		label: 'delivered',
		tone: 'is-good',
		hint: 'confirmed by the far end.'
	},
	retryable: {
		label: 'retrying',
		tone: 'is-waiting',
		hint: 'failed and will be tried again on a backoff.'
	},
	failed: {
		label: 'failed',
		tone: 'is-bad',
		hint: 'given up on. this effect will not happen without a retry.'
	},
	ambiguous: {
		label: 'ambiguous',
		tone: 'is-bad',
		hint: 'we do not know whether this landed. establish it at the far end before retrying - a blind retry may duplicate it.'
	},
	skipped: {
		label: 'skipped',
		tone: 'is-waiting',
		hint: 'nothing to deliver to. usually an integration that is not configured.'
	}
} satisfies Record<OutboxStatus, StateLabel>;

/** Seconds as a gap a person reads at a glance: `40s`, `12m`, `3h`, `2d`.
 *  Here rather than beside the reviewer queries because the console's cards
 *  draw it on the client, and a server module cannot be imported there. */
export function gapText(seconds: number | null): string {
	if (seconds === null) return '-';
	if (seconds < 90) return `${seconds}s`;
	if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
	if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86400)}d`;
}
