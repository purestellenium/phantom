import { randomBytes } from 'node:crypto';

import { and, count, eq, inArray, isNotNull, isNull, or, sql as raw } from 'drizzle-orm';

import { recordEvent } from '$lib/server/analytics';
import { recordAudit, type DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import { isUniqueViolation } from '$lib/server/db/errors';
import {
	ledgerEntries,
	orders,
	products,
	users,
	type EligibilityDecision
} from '$lib/server/db/schema';
import { postEntry, reverseEntry } from '$lib/server/ledger';
import { REFERRAL_MILESTONES, REFERRAL_STICKERS_SLUG } from '$lib/referral';

/**
 * Inviting friends.
 *
 * Somebody arrives by another participant's `?ref=` link, the code rides a
 * cookie to their signup, and the account is written with who invited them
 * (the HCA callback). Nothing is owed yet. They QUALIFY the first moment they
 * are both onboarded and eligible - whichever of the two happens second - and
 * each qualification is counted toward the inviter's milestones in
 * $lib/referral.ts.
 *
 * Eligibility is the anti-fraud. A qualified referral is a distinct person Hack
 * Club has verified, so a farm of throwaway accounts earns nothing. It is
 * checked once, at qualification, and a later loss of eligibility does not
 * claw a milestone back: the ledger never edits, and a reversal for somebody
 * else's ban would be a punishment for a thing the inviter did not do.
 *
 * These are the only ledger credits that are not a reviewer's award. Each is
 * keyed so it can happen once per person per milestone, whatever races or
 * retries: `referral:<userId>:milestone:<count>`.
 */

/** Qualified invites that pay out when reached. Stickers are not in here -
 *  they are claimed in the shop, see `stickersEarned`. */
const HOUR_MILESTONES = REFERRAL_MILESTONES.filter(
	(m): m is (typeof REFERRAL_MILESTONES)[number] & { seconds: number } => m.seconds !== null
);

/* ── the code ────────────────────────────────────────────────────────────── */

/** Five characters, upper and lower case and digits, less the ones that
 *  read as each other - 0/O/o and 1/l/I. 56 letters, so about 550 million
 *  codes for a program with a thousand people in it; a collision is caught by
 *  the unique index and drawn again. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function mintCode(): string {
	let code = '';
	while (code.length < 5) {
		/* Bytes past the last whole multiple of 56 are thrown away, so every
		   letter is equally likely rather than the first few favoured. */
		for (const byte of randomBytes(8)) {
			if (byte < 224 && code.length < 5) code += ALPHABET[byte % 56];
		}
	}
	return code;
}

/**
 * This person's invite code, minted the first time it is asked for.
 *
 * Lazily rather than at signup, so the thousand accounts that exist today get
 * one the first time they open the page that shows it, with no backfill.
 */
export async function inviteCodeFor(userId: string): Promise<string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const [row] = await db
			.select({ code: users.inviteCode })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		if (row?.code) return row.code;

		try {
			/* `is null` in the guard, so two tabs racing mint one code between them:
			   the loser updates nothing and reads the winner's on the next pass. */
			await db
				.update(users)
				.set({ inviteCode: mintCode() })
				.where(and(eq(users.id, userId), isNull(users.inviteCode)));
		} catch (error) {
			/* Somebody else already has this code. Draw again. */
			if (!isUniqueViolation(error)) throw error;
		}
	}
	throw new Error(`Could not mint an invite code for ${userId}.`);
}

/**
 * Who a code belongs to, for the front page's "invited you" notice. Their
 * Slack handle only - the one thing the inviter has already put on show by
 * sharing the link - or null for a code that names nobody, which the page
 * reads as "say nothing".
 */
export async function inviterFor(code: string): Promise<{ handle: string | null } | null> {
	const [row] = await db
		.select({ handle: users.slackUsername })
		.from(users)
		.where(eq(users.inviteCode, code))
		.limit(1);
	return row ? { handle: row.handle } : null;
}

/* ── qualifying ──────────────────────────────────────────────────────────── */

/**
 * Count this person toward whoever invited them, if they have just become
 * countable.
 *
 * Called wherever either half of the condition can become true - finishing
 * onboarding, and any fresh eligibility decision (sign-in, a page refresh, a
 * mutation's re-check). Cheap to call when nothing is due: the guarded update
 * matches no row and that is the end of it. Never throws; a referral is not a
 * reason to fail the sign-in or page it rides on.
 */
export async function qualifyReferral(userId: string): Promise<void> {
	try {
		const qualified = await db.transaction(async (tx) => {
			const [row] = await tx
				.update(users)
				.set({ referralQualifiedAt: new Date() })
				.where(
					and(
						eq(users.id, userId),
						isNotNull(users.referredByUserId),
						isNull(users.referralQualifiedAt),
						isNotNull(users.onboardedAt),
						eq(users.eligibility, 'eligible')
					)
				)
				.returning({ referrerId: users.referredByUserId });
			if (!row?.referrerId) return false;

			await recordAudit(
				{
					action: 'referral.qualified',
					subjectId: row.referrerId,
					metadata: { inviteeId: userId }
				},
				tx
			);
			await payMilestones(row.referrerId, tx);
			return true;
		});
		if (qualified) recordEvent('referral.qualified');
	} catch (error) {
		console.error('referrals: could not qualify', userId, error);
	}
}

/**
 * Post every hours milestone the inviter has reached and not yet been paid.
 *
 * The inviter's row is locked first. Without it, two friends qualifying at the
 * same moment would each count the other as not-yet-committed, both see two,
 * and the third milestone would be skipped by both. With it the second waits,
 * and its count - a fresh statement under read committed - sees the first.
 */
async function payMilestones(referrerId: string, tx: DbHandle): Promise<void> {
	await tx.select({ id: users.id }).from(users).where(eq(users.id, referrerId)).for('update');
	const qualified = await qualifiedCount(referrerId, tx);

	for (const milestone of HOUR_MILESTONES) {
		if (qualified < milestone.count) break;
		const posted = await postEntry(
			{
				userId: referrerId,
				amount: milestone.seconds,
				entryType: 'referral_reward',
				reason: `inviting ${milestone.count} friends`,
				idempotencyKey: `referral:${referrerId}:milestone:${milestone.count}`,
				metadata: { milestone: milestone.count }
			},
			tx
		);
		if (posted.created) {
			await recordAudit(
				{
					action: 'referral.rewarded',
					subjectId: referrerId,
					metadata: { milestone: milestone.count, seconds: milestone.seconds }
				},
				tx
			);
		}
	}
}

async function qualifiedCount(referrerId: string, handle: DbHandle = db): Promise<number> {
	const [row] = await handle
		.select({ n: count() })
		.from(users)
		.where(and(eq(users.referredByUserId, referrerId), isNotNull(users.referralQualifiedAt)));
	return row?.n ?? 0;
}

/* ── the stickers ────────────────────────────────────────────────────────── */

/** Whether this person has earned the stickers: the first milestone. */
export async function stickersEarned(userId: string, handle: DbHandle = db): Promise<boolean> {
	return (await qualifiedCount(userId, handle)) >= REFERRAL_MILESTONES[0].count;
}

/** Whether they already have a live sticker order - placed, held or sent. A
 *  rejected or cancelled one frees the claim again. */
export async function stickersClaimed(userId: string, handle: DbHandle = db): Promise<boolean> {
	const [row] = await handle
		.select({ id: orders.id })
		.from(orders)
		.innerJoin(products, eq(orders.productId, products.id))
		.where(
			and(
				eq(orders.userId, userId),
				eq(products.slug, REFERRAL_STICKERS_SLUG),
				inArray(orders.state, ['placed', 'on_hold', 'fulfilled', 'unfulfilled'])
			)
		)
		.limit(1);
	return Boolean(row);
}

/**
 * The credit that pays for a sticker order, posted inside the purchase just
 * before its debit, so the order is free and the ledger still balances.
 *
 * One per ORDER, keyed and tagged with it, and taken back when that order is
 * cancelled or rejected (see `reverseStickerCredit`) - so a claim nets to zero
 * and so does a cancellation. It used to be one per person, which capped what
 * a cancel could mint at one fragment but did not stop it: the refund came
 * back and the credit stayed.
 */
export async function creditStickers(
	userId: string,
	amount: number,
	orderId: string,
	tx: DbHandle
): Promise<void> {
	await postEntry(
		{
			userId,
			amount,
			entryType: 'referral_reward',
			reason: 'custom stickers',
			idempotencyKey: `referral:${userId}:stickers:${orderId}`,
			orderId,
			metadata: { milestone: REFERRAL_MILESTONES[0].count }
		},
		tx
	);
}

/** The key the one-per-person credit carried, before credits were per order. */
const LEGACY_STICKER_KEY = (userId: string) => `referral:${userId}:stickers`;

/**
 * Take back the credit that paid for a sticker order that is being cancelled
 * or rejected - called beside its refund, so the order unwinds to nothing
 * rather than to one free fragment.
 *
 * The order's own credit when it has one; for a claim from before credits
 * were per order, the person's one credit, if nothing has taken it back yet.
 * Not a sticker order, or nothing to take back: does nothing.
 */
export async function reverseStickerCredit(
	order: { id: string; userId: string; productId: string },
	actorId: string | null,
	tx: DbHandle
): Promise<void> {
	const [product] = await tx
		.select({ slug: products.slug })
		.from(products)
		.where(eq(products.id, order.productId))
		.limit(1);
	if (product?.slug !== REFERRAL_STICKERS_SLUG) return;

	const credits = await tx
		.select()
		.from(ledgerEntries)
		.where(
			and(
				eq(ledgerEntries.entryType, 'referral_reward'),
				or(
					eq(ledgerEntries.orderId, order.id),
					eq(ledgerEntries.idempotencyKey, LEGACY_STICKER_KEY(order.userId))
				)
			)
		);
	const credit =
		credits.find((entry) => entry.orderId === order.id) ??
		credits.find((entry) => entry.idempotencyKey === LEGACY_STICKER_KEY(order.userId));
	if (!credit) return;

	const [reversed] = await tx
		.select({ id: ledgerEntries.id })
		.from(ledgerEntries)
		.where(eq(ledgerEntries.reversesEntryId, credit.id))
		.limit(1);
	if (reversed) return;

	await reverseEntry(
		{
			userId: order.userId,
			original: credit,
			reason: 'custom stickers - order undone',
			actorId,
			metadata: { orderId: order.id }
		},
		tx
	);
}

/* ── the page ────────────────────────────────────────────────────────────── */

export type ReferralSummary = {
	code: string;
	/** Signed up through the link, whether or not they count yet. */
	joined: number;
	/** Onboarded and eligible: what the milestones count. */
	qualified: number;
	stickersClaimed: boolean;
};

export async function referralSummary(userId: string): Promise<ReferralSummary> {
	const [code, [joined], qualified, claimed] = await Promise.all([
		inviteCodeFor(userId),
		db.select({ n: count() }).from(users).where(eq(users.referredByUserId, userId)),
		qualifiedCount(userId),
		stickersClaimed(userId)
	]);
	return { code, joined: joined?.n ?? 0, qualified, stickersClaimed: claimed };
}

/* ── the console ─────────────────────────────────────────────────────────── */

export type ReferralGlance = {
	/** Everyone who signed up through somebody's code, and the ones of those
	 *  who count - onboarded and eligible. */
	joined: number;
	qualified: number;
	/** Joined in the last seven days. */
	joinedWeek: number;
	/** People whose code has brought at least one person in. */
	inviters: number;
	/** Hours milestones paid, in seconds. Not the stickers: their credit only
	 *  ever pays for the sticker order it rides in with. */
	paidSeconds: number;
	/** Live sticker orders - the first milestone, taken. */
	stickers: number;
	/** Joins a day, oldest first, zeros filled in. */
	days: { day: string; n: number }[];
};

/**
 * The program's referrals as counts. No names: this is what the console's
 * front page draws, and who invited whom is on the referrals page behind it.
 */
export async function referralGlance(days = 30): Promise<ReferralGlance> {
	const [totals, paid, stickers, series] = await Promise.all([
		db.execute<{ joined: number; qualified: number; week: number; inviters: number }>(raw`
			select
				count(*)::int as joined,
				count(*) filter (where referral_qualified_at is not null)::int as qualified,
				count(*) filter (where created_at >= now() - interval '7 days')::int as week,
				count(distinct referred_by_user_id)::int as inviters
			from users
			where referred_by_user_id is not null
		`),
		/* By the key's shape rather than the reason line, which is prose - see
		   the note on `reason` in the schema. */
		db.execute<{ seconds: number }>(raw`
			select coalesce(sum(amount), 0)::bigint as seconds
			from ledger_entries
			where entry_type = 'referral_reward' and idempotency_key like 'referral:%:milestone:%'
		`),
		db.execute<{ n: number }>(raw`
			select count(*)::int as n
			from orders o
			join products p on p.id = o.product_id
			where p.slug = ${REFERRAL_STICKERS_SLUG}
				and o.state in ('placed', 'on_hold', 'fulfilled', 'unfulfilled')
		`),
		db.execute<{ day: string; n: number }>(raw`
			select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as n
			from users
			where referred_by_user_id is not null
				and created_at >= now() - make_interval(days => ${days})
			group by 1
		`)
	]);

	const by = new Map(series.map((row) => [row.day, Number(row.n)]));
	const filled: { day: string; n: number }[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
		filled.push({ day, n: by.get(day) ?? 0 });
	}

	return {
		joined: Number(totals[0]?.joined ?? 0),
		qualified: Number(totals[0]?.qualified ?? 0),
		joinedWeek: Number(totals[0]?.week ?? 0),
		inviters: Number(totals[0]?.inviters ?? 0),
		paidSeconds: Number(paid[0]?.seconds ?? 0),
		stickers: Number(stickers[0]?.n ?? 0),
		days: filled
	};
}

/* ── the referrals page ──────────────────────────────────────────────────── */

export type Inviter = {
	id: string;
	name: string;
	avatarUrl: string | null;
	joined: number;
	qualified: number;
	/** Hours milestones paid to them, in seconds. */
	paidSeconds: number;
	stickersClaimed: boolean;
	/** When the most recent person they invited signed up. */
	lastJoinedAt: Date | null;
};

/** Everyone whose code has brought somebody in, most qualified first. */
export async function inviterBoard(): Promise<Inviter[]> {
	const rows = await db.execute<{
		id: string;
		name: string;
		avatar_url: string | null;
		joined: number;
		qualified: number;
		paid: number;
		stickers: boolean;
		last_at: string | Date | null;
	}>(raw`
		select
			inviter.id,
			coalesce(inviter.display_name, inviter.email) as name,
			inviter.avatar_url,
			count(*)::int as joined,
			count(*) filter (where invitee.referral_qualified_at is not null)::int as qualified,
			max(invitee.created_at) as last_at,
			(
				select coalesce(sum(le.amount), 0)::bigint
				from ledger_entries le
				where le.entry_type = 'referral_reward'
					and le.idempotency_key like ('referral:' || inviter.id::text || ':milestone:%')
			) as paid,
			exists (
				select 1
				from orders o
				join products p on p.id = o.product_id
				where o.user_id = inviter.id
					and p.slug = ${REFERRAL_STICKERS_SLUG}
					and o.state in ('placed', 'on_hold', 'fulfilled', 'unfulfilled')
			) as stickers
		from users invitee
		join users inviter on inviter.id = invitee.referred_by_user_id
		group by inviter.id
		order by qualified desc, joined desc, name
	`);

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		avatarUrl: row.avatar_url,
		joined: Number(row.joined),
		qualified: Number(row.qualified),
		paidSeconds: Number(row.paid),
		stickersClaimed: Boolean(row.stickers),
		lastJoinedAt: row.last_at ? new Date(row.last_at) : null
	}));
}

export type Invitee = {
	id: string;
	name: string;
	joinedAt: Date;
	onboarded: boolean;
	eligibility: EligibilityDecision;
	qualifiedAt: Date | null;
	inviterId: string;
	inviterName: string;
};

/** The people most recently brought in on a code, newest first. */
export async function recentInvitees(limit = 50): Promise<Invitee[]> {
	const rows = await db.execute<{
		id: string;
		name: string;
		created_at: string | Date;
		onboarded: boolean;
		eligibility: EligibilityDecision;
		qualified_at: string | Date | null;
		inviter_id: string;
		inviter_name: string;
	}>(raw`
		select
			invitee.id,
			coalesce(invitee.display_name, invitee.email) as name,
			invitee.created_at,
			invitee.onboarded_at is not null as onboarded,
			invitee.eligibility,
			invitee.referral_qualified_at as qualified_at,
			inviter.id as inviter_id,
			coalesce(inviter.display_name, inviter.email) as inviter_name
		from users invitee
		join users inviter on inviter.id = invitee.referred_by_user_id
		order by invitee.created_at desc
		limit ${limit}
	`);

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		joinedAt: new Date(row.created_at),
		onboarded: Boolean(row.onboarded),
		eligibility: row.eligibility,
		qualifiedAt: row.qualified_at ? new Date(row.qualified_at) : null,
		inviterId: row.inviter_id,
		inviterName: row.inviter_name
	}));
}
