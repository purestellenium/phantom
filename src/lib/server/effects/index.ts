import { and, desc, eq } from 'drizzle-orm';

import { normalizeHcaAddress } from '$lib/server/auth/hca';
import { bindings, decryptJson } from '$lib/server/crypto';
import { db } from '$lib/server/db/client';
import { fragments, payoutSeconds, toFragments } from '$lib/fragments';
import {
	orders,
	products,
	projects,
	submissionTransitions,
	submissions,
	users
} from '$lib/server/db/schema';
import { REFERRAL_STICKERS_SLUG } from '$lib/referral';
import { FRAUD_SQUAD_NOTE, fraudRejectedSubmission } from '$lib/server/projects/fraud';
import type { AriJustificationFields } from '$lib/justification';
import type { EffectHandler, EffectOutcome } from '$lib/server/outbox';
import { postAirtableSubmission } from '$lib/server/effects/airtable';
import {
	inviteToPhantomChannel,
	postSlackDm,
	postSlackMessage,
	slackEscape
} from '$lib/server/effects/slack';
import { ARI_INGEST_EFFECT, sendShip } from '$lib/server/ari';
import { recountClaim } from '$lib/server/projects/decisions';
import { isJsonObject, readNumber, readString, type JsonObject } from '$lib/json';

/**
 * What each outbox effect actually does.
 *
 * A registry rather than a switch inside the worker, so adding an integration
 * is a new entry here and nothing else changes. Two rules apply to everything
 * in it, and both come out of the reliability pages:
 *
 * A HANDLER MUST BE SAFE TO RUN TWICE. The lease reduces duplicate execution;
 * it does not eliminate it, because a worker can stall long enough for its
 * lease to expire while its request is still in flight. Where the far end has
 * no idempotency key - Slack's `chat.postMessage` does not - the handler must
 * return `ambiguous` rather than retrying blind, and it does.
 *
 * A HANDLER READS THE CURRENT RECORD. The payload carries an id, not a copy of
 * the data. Freezing the message text into the row at enqueue time would mean a
 * notification sent an hour later describing a state that has since changed, and
 * would put order details into a table the wiki says should hold references.
 */

/**
 * An effect whose subject has vanished.
 *
 * Terminal rather than retryable, and not a failure worth alerting on: an order
 * deleted before its notification went out is a resolved situation, and a row
 * that retries eight times for something that no longer exists is noise in the
 * one table an operator is supposed to be able to scan.
 */
function gone(what: string): EffectOutcome {
	return { status: 'skipped', error: `${what} no longer exists` };
}

function readId(payload: JsonObject | null, key: string): string | null {
	return payload === null ? null : readString(payload, key);
}

/** Seconds as hours, for a message. Duplicated from components/status.ts on
 *  purpose - that module is for the browser's benefit and this string is
 *  assembled on a worker; importing a UI helper into an integration is how a
 *  React dependency ends up in a background job. */
function hours(seconds: number): string {
	return `${(seconds / 3600).toFixed(1)}h`;
}

/** What an approval credited: its hours, rounded down to whole fragments (see
 *  $lib/fragments - pure, with no UI in it, so a worker can import it). */
function credited(awardedSeconds: number | null): string {
	return fragments(payoutSeconds(awardedSeconds ?? 0));
}

/** A decided submission, with its author's name, Slack id and its project's
 *  public number - what its Slack messages need besides the submission itself. */
async function decidedSubmission(submissionId: string) {
	const [row] = await db
		.select({
			submission: submissions,
			displayName: users.displayName,
			slackId: users.slackId,
			projectNumber: projects.number
		})
		.from(submissions)
		.innerJoin(users, eq(users.id, submissions.userId))
		.innerJoin(projects, eq(projects.id, submissions.projectId))
		.where(eq(submissions.id, submissionId))
		.limit(1);
	return row ?? null;
}

/**
 * The project's name, as a Slack link to its page on the platform.
 *
 * The origin comes from the payload - captured from the reviewer's request when
 * the decision was made, see `linkOrigin` in projects/review.ts - because this
 * runs on the outbox's schedule, not in any request a person made. It is
 * checked again here rather than trusted: a payload is a database row, and a
 * link is the one thing in the message somebody will click. No usable origin
 * (a row enqueued before this existed, or outside a request) is the plain name.
 */
function projectLink(
	payload: JsonObject | null,
	row: { submission: { name: string }; projectNumber: number }
): string {
	const name = slackEscape(row.submission.name);
	const origin = payload ? readString(payload, 'origin') : null;
	if (!origin || !/^https?:\/\/[^\s/<>|]+$/.test(origin)) return name;
	return `<${origin}/projects/${row.projectNumber}|${name}>`;
}

/* Added to the approval DM when the reviewer marked the ship hyper-chroma -
   see projects/hyper-chroma.ts. The bonuses it promises are not built yet; the
   mark is kept per ship so they can be keyed on it. `:hyper-chroma:` is a
   custom emoji in the Hack Club workspace (the sparkles in the pill's
   colours); a workspace without it would show the bare shortcode. */
const HYPER_CHROMA_LINE =
	"\n:hyper-chroma: Your reviewer really loved your project, and marked it _hyper-chroma_! As a result, you'll receive some bonuses soon!";

/** A message typed by a reviewer, as a Slack quote. Escaped, since it is
 *  somebody's free text, and quoted line by line, since Slack's `>` only
 *  reaches the end of its own line. */
function quote(text: string | null): string {
	const body = text?.trim();
	if (!body) return '';
	return `\n${body
		.split('\n')
		.map((line) => `> ${slackEscape(line)}`)
		.join('\n')}`;
}

/**
 * The DM an author gets about a decision on their project.
 *
 * Reads the submission as it is now, like every handler here, and delivers
 * nothing if the decision it was about no longer stands - a change request
 * the author already answered, say, or one undone after the outbox missed
 * the row. `expect` is the states in which the message is still true.
 *
 * No Slack account linked is `skipped`: there is nobody to send it to, and
 * nothing that will change on a retry.
 *
 * `link` is the project's name, bold, linking to its page - the one link in
 * every DM, so each reads "your project <name>" and the name is the way in.
 */
async function dmAuthor(
	event: { payload: JsonObject | null },
	expect: readonly string[],
	write: (row: NonNullable<Awaited<ReturnType<typeof decidedSubmission>>>, link: string) => string
): Promise<EffectOutcome> {
	const submissionId = readId(event.payload, 'submissionId');
	if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };

	const row = await decidedSubmission(submissionId);
	if (!row) return gone('that submission');
	if (!expect.includes(row.submission.state)) {
		return { status: 'skipped', error: `the submission is ${row.submission.state} now` };
	}
	if (!row.slackId) return { status: 'skipped', error: 'the author has no slack id' };

	return postSlackDm(row.slackId, write(row, `*${projectLink(event.payload, row)}*`));
}

/**
 * The base's justification fields an Ari approval left on its history entry,
 * or null for an approval from before they were kept (or from the old desk).
 */
async function approvalFields(submissionId: string): Promise<AriJustificationFields | null> {
	const [row] = await db
		.select({ metadata: submissionTransitions.metadata })
		.from(submissionTransitions)
		.where(
			and(
				eq(submissionTransitions.submissionId, submissionId),
				eq(submissionTransitions.toState, 'approved')
			)
		)
		.orderBy(desc(submissionTransitions.createdAt))
		.limit(1);
	const fields = row?.metadata?.justificationFields;
	if (!fields || !isJsonObject(fields)) return null;
	const text = (key: string) => readString(fields, key);
	return {
		hackatimeId: text('hackatimeId'),
		hackatimeProjects: text('hackatimeProjects'),
		lapseLinks: text('lapseLinks'),
		technicalFeatures: text('technicalFeatures'),
		deflation: text('deflation'),
		alternateTracking: text('alternateTracking'),
		additional: text('additional'),
		duplicate: text('duplicate')
	};
}

const HANDLERS = {
	/** Send a shipped submission to Ari for review - see `sendShip`, which
	 *  asks Ari before it resends anything, so running it twice sends once. */
	[ARI_INGEST_EFFECT]: (event) => sendShip(event.payload),

	/** Count a submission's claim again after a reviewer corrected its
	 *  Hackatime projects on Ari - see `recountClaim`. */
	'ari.recount': (event) => recountClaim(event.payload),

	/**
	 * Someone bought something.
	 *
	 * The message names the person, the thing and the price, and deliberately
	 * carries no address, no email and no order options - a Slack channel is a
	 * wide audience with no access control worth the name, and the wiki's
	 * telemetry boundary applies to notifications as much as to logs.
	 */
	'slack.order_placed': async (event) => {
		const orderId = readId(event.payload, 'orderId');
		if (!orderId) return { status: 'failed', error: 'payload has no orderId' };

		const [row] = await db
			.select({
				order: orders,
				displayName: users.displayName,
				slug: products.slug
			})
			.from(orders)
			.innerJoin(users, eq(users.id, orders.userId))
			.innerJoin(products, eq(products.id, orders.productId))
			.where(eq(orders.id, orderId))
			.limit(1);

		if (!row) return gone('that order');

		/* Both of these are attacker-reachable: the name is the participant's own
       HCA profile, and the product name is whatever an operator typed. */
		const who = slackEscape(row.displayName ?? 'someone');
		return postSlackMessage(
			`${who} ordered ${row.order.quantity} × ${slackEscape(row.order.productName)} ` +
				(row.slug === REFERRAL_STICKERS_SLUG
					? 'as a referral reward.'
					: `for ${fragments(row.order.totalPrice)}.`)
		);
	},

	/** An order moved. Same restraint about contents; the state and the product
	 *  name are the whole message. */
	'slack.order_state_changed': async (event) => {
		const orderId = readId(event.payload, 'orderId');
		if (!orderId) return { status: 'failed', error: 'payload has no orderId' };

		const [row] = await db
			.select({ order: orders, displayName: users.displayName })
			.from(orders)
			.innerJoin(users, eq(users.id, orders.userId))
			.where(eq(orders.id, orderId))
			.limit(1);

		if (!row) return gone('that order');

		const who = slackEscape(row.displayName ?? 'someone');
		return postSlackMessage(
			`${who}'s ${slackEscape(row.order.productName)} order is now ${row.order.state}.`
		);
	},

	/** Someone shipped a project. Goes to the reviewer channel so the queue is
	 *  noticed; no project internals beyond the name and the logged time. */
	'slack.submission_shipped': async (event) => {
		const submissionId = readId(event.payload, 'submissionId');
		if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };

		const [row] = await db
			.select({ submission: submissions, displayName: users.displayName })
			.from(submissions)
			.innerJoin(users, eq(users.id, submissions.userId))
			.where(eq(submissions.id, submissionId))
			.limit(1);
		if (!row) return gone('that submission');

		const who = slackEscape(row.displayName ?? 'someone');
		const verb = row.submission.changelog ? 'reshipped' : 'shipped';
		return postSlackMessage(
			`${who} ${verb} ${slackEscape(row.submission.name)} - ${hours(row.submission.claimedSeconds)} logged. it's in the review queue.`
		);
	},

	/** A submission was approved. The granted hours are the point of the message;
	 *  the project's name links to its page on the platform. */
	'slack.submission_approved': async (event) => {
		const submissionId = readId(event.payload, 'submissionId');
		if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };

		const row = await decidedSubmission(submissionId);
		if (!row) return gone('that submission');
		if (row.submission.state !== 'approved') {
			return { status: 'skipped', error: `the submission is ${row.submission.state} now` };
		}

		const who = slackEscape(row.displayName ?? 'someone');
		return postSlackMessage(
			`${who}'s ${projectLink(event.payload, row)} was approved for ${hours(row.submission.awardedSeconds ?? 0)} - ${credited(row.submission.awardedSeconds)}.`
		);
	},

	'slack.submission_rejected': async (event) => {
		const submissionId = readId(event.payload, 'submissionId');
		if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };

		const row = await decidedSubmission(submissionId);
		if (!row) return gone('that submission');

		const who = slackEscape(row.displayName ?? 'someone');
		return postSlackMessage(`${who}'s ${projectLink(event.payload, row)} was rejected.`);
	},

	/** An approval withdrawn and its hours taken back - see `revokeSubmission`.
	 *  To the operator channel like every decision; the reason stays in the
	 *  audit log rather than being posted where it would travel. */
	'slack.submission_revoked': async (event) => {
		const submissionId = readId(event.payload, 'submissionId');
		if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };

		const row = await decidedSubmission(submissionId);
		if (!row) return gone('that submission');

		const who = slackEscape(row.displayName ?? 'someone');
		return postSlackMessage(
			`${who}'s ${projectLink(event.payload, row)} had its approval revoked - ${credited(row.submission.awardedSeconds)} taken back.`
		);
	},

	/* ── the author's DMs ───────────────────────────────────────────────────
	   One per decision a participant can see, sent to them rather than to the
	   operator channel - which still gets its own line about each. A first pass
	   is not among them: to its author a first-passed ship is still in review. */

	'slack.dm_approved': (event) =>
		dmAuthor(
			event,
			['approved', 'revoked'],
			(row, link) =>
				`Your project ${link} was approved for *${hours(row.submission.awardedSeconds ?? 0)}*! *${credited(row.submission.awardedSeconds)}* ${toFragments(payoutSeconds(row.submission.awardedSeconds ?? 0)) === 1 ? 'was' : 'were'} added to your balance.${row.submission.hyperChroma ? HYPER_CHROMA_LINE : ''}${quote(row.submission.publicMessage)}`
		),

	/* A ship marked hyper-chroma by hand on Phantom, after its approval - the
	   approval DM went out without the line, so this is its own message.
	   Nothing if the mark came off, or the approval was taken back, before it
	   was sent: the promise would no longer be true. */
	'slack.dm_hyper_chroma': async (event) => {
		const submissionId = readId(event.payload, 'submissionId');
		const row = submissionId ? await decidedSubmission(submissionId) : null;
		if (row && !row.submission.hyperChroma) {
			return { status: 'skipped', error: 'the hyper-chroma mark was taken off' };
		}
		return dmAuthor(
			event,
			['approved'],
			(_, link) =>
				`:hyper-chroma: We really loved your project ${link}, so we marked it _hyper-chroma_! As a result, you'll receive some bonuses soon!`
		);
	},

	/* OneKey's rejection DM, with the project's name as the link rather than a
	   "See more on the dashboard" line under it. Ari's automatic rejections
	   carry their own explanation as the note, so it is the same message. */
	/* A fraud rejection ends with where to take it up - see projects/fraud.ts. */
	'slack.dm_rejected': async (event) => {
		const submissionId = readId(event.payload, 'submissionId');
		const fraud = submissionId ? await fraudRejectedSubmission(submissionId) : false;
		return dmAuthor(
			event,
			['rejected'],
			(row, link) =>
				`Your project ${link} was rejected.${quote(row.submission.publicMessage)}` +
				(fraud ? `\n${FRAUD_SQUAD_NOTE}` : '')
		);
	},

	'slack.dm_changes_requested': (event) =>
		dmAuthor(
			event,
			['changes_requested'],
			(row, link) =>
				`A reviewer asked for changes to ${link} before it can be approved:${quote(row.submission.publicMessage)}\n` +
				`Make them, then press *Changes are done* on the project page. ` +
				`It goes straight back to its old place in the review queue.`
		),

	/* A decision taken back on Ari for a fresh look. Only sent when the author
	   had already been told of the decision, or hours left their balance. */
	'slack.dm_requeued': (event) =>
		dmAuthor(event, ['pending'], (row, link) => {
			const back = (event.payload && readNumber(event.payload, 'reversedSeconds')) ?? 0;
			return (
				`Your project ${link} is back in review - its decision was taken back for a fresh look.` +
				(back > 0
					? ` Its *${fragments(back)}* came off your balance until it's decided again.`
					: '') +
				quote(row.submission.publicMessage)
			);
		}),

	/* A decision taken back on Ari, with the ship left closed. */
	'slack.dm_reverted': (event) =>
		dmAuthor(event, ['reverted'], (row, link) => {
			const back = (event.payload && readNumber(event.payload, 'reversedSeconds')) ?? 0;
			return (
				`The decision on your project ${link} was taken back.` +
				(back > 0 ? ` Its *${fragments(back)}* came off your balance.` : '') +
				` You can ship it again whenever you're ready.${quote(row.submission.publicMessage)}`
			);
		}),

	'slack.dm_revoked': (event) =>
		dmAuthor(
			event,
			['revoked'],
			(row, link) =>
				`The approval of ${link} was withdrawn and its *${credited(row.submission.awardedSeconds)}* taken back.${quote(row.submission.publicMessage)}`
		),

	/**
	 * Somebody signed in and we know their Slack account: put them in the
	 * Phantom channel.
	 *
	 * The only effect in here that acts on the participant rather than reporting
	 * to operators, and the only one whose subject is a person rather than a
	 * thing they did. The registry's second rule is what makes the indirection
	 * worth it: the payload carries the user id and the Slack id is read HERE,
	 * so an account that was unlinked between sign-in and dispatch is skipped
	 * rather than invited by a copy of an id that is no longer theirs.
	 */
	'slack.channel_invite': async (event) => {
		const userId = readId(event.payload, 'userId');
		if (!userId) return { status: 'failed', error: 'payload has no userId' };

		const [row] = await db
			.select({ slackId: users.slackId })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		if (!row) return gone('that account');

		/* Skipped, not failed: HCA released no `slack_id` for this person - they
		   have no Slack account linked to their Hack Club account - and there is
		   nothing to retry against. The row is enqueued at sign-in only when the
		   id is there, so this is the narrow case of it going away in between. */
		if (!row.slackId) return { status: 'skipped', error: 'that account has no slack id' };

		return inviteToPhantomChannel(row.slackId);
	},

	/** An approved submission, written to the YSWS records base. Carries the
	 *  frozen fields, the author, the granted hours and the justification. */
	'airtable.submission_approved': async (event) => {
		const submissionId = readId(event.payload, 'submissionId');
		if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };

		const [row] = await db
			.select({
				submission: submissions,
				authorName: users.displayName,
				authorEmail: users.email,
				authorBirthday: users.birthdate
			})
			.from(submissions)
			.innerJoin(users, eq(users.id, submissions.userId))
			.where(eq(submissions.id, submissionId))
			.limit(1);
		if (!row) return gone('that submission');
		/* Taken back on Ari before this went out: there is no approval to file. */
		if (row.submission.state !== 'approved') {
			return { status: 'skipped', error: `the submission is ${row.submission.state} now` };
		}

		/* Decrypt the frozen shipping address, defensively - an undecryptable blob
		   files the record without an address rather than blocking it entirely. */
		let address = null;
		if (row.submission.shippingEncrypted) {
			try {
				const raw = decryptJson(
					row.submission.shippingEncrypted,
					bindings.submissionShipping(row.submission.userId, row.submission.id)
				);
				if (isJsonObject(raw)) address = normalizeHcaAddress(raw);
			} catch {
				/* leave address null */
			}
		}

		/* No project name goes out: the YSWS base has no column for one. See the
		   field list in effects/airtable.ts. */
		return postAirtableSubmission({
			description: row.submission.description,
			repoUrl: row.submission.repoUrl,
			demoUrl: row.submission.demoUrl,
			screenshotUrl: row.submission.screenshotUrl,
			authorName: row.authorName,
			authorEmail: row.authorEmail,
			authorBirthday: row.authorBirthday,
			approvedSeconds: row.submission.awardedSeconds ?? 0,
			justification: row.submission.justification,
			justificationFields: await approvalFields(submissionId),
			address
		});
	}
} satisfies Record<string, EffectHandler>;

/** An effect name this deploy has a handler for. */
type EffectName = keyof typeof HANDLERS;

function isKnownEffect(effect: string): effect is EffectName {
	return Object.hasOwn(HANDLERS, effect);
}

/**
 * The handler for an effect, or null.
 *
 * Null is a real case rather than an impossibility: a row can outlive the
 * deploy that knew how to run it - an effect enqueued, then the handler removed,
 * then the worker started. The worker turns that into a terminal failure naming
 * the effect, which is a legible thing to find in the console. Throwing here
 * would take the whole batch down with it.
 */
export function handlerFor(effect: string): EffectHandler | null {
	return isKnownEffect(effect) ? HANDLERS[effect] : null;
}

/** Every effect this deploy can run. For the console, so an operator can see
 *  what a row's effect name is supposed to match. */
export function knownEffects(): string[] {
	return Object.keys(HANDLERS).sort();
}
