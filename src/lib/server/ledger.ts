import { and, desc, eq, inArray, sql as raw } from 'drizzle-orm';

import type { DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import {
	ledgerAccounts,
	ledgerEntries,
	type LedgerAccount,
	type LedgerEntry,
	type LedgerEntryType
} from '$lib/server/db/schema';
import type { JsonObject } from '$lib/json';

/**
 * The ledger. Every seconds a participant has, where it came from, and what
 * happened to it.
 *
 * Three rules, and everything in this file is one of them being enforced.
 *
 * ONE. NOTHING IS EVER UPDATED OR DELETED. A mistake is corrected by appending
 * its opposite, linked to the original. That is not bookkeeping pedantry - it is
 * the only way to answer "why is my balance this number" a month later, and the
 * wiki's integrity queries are all queries over entries that would have nothing
 * to read if the entries had been edited in place.
 *
 * TWO. THE CACHED BALANCE NEVER AUTHORISES A SPEND. `ledger_accounts.cached_
 * balance` exists so a page can show a number without summing a table. Every
 * spend recomputes from the entries, under a lock, and the cache is rewritten
 * from that same recomputation - so it self-heals rather than drifting, and
 * lib/reconcile.ts can still prove it.
 *
 * THREE. EVERY WRITE HOLDS THE ACCOUNT LOCK. Not just spends. A balance check
 * that is correct in isolation still permits overspend when two requests read
 * it at once, which is the wiki's opening sentence on the subject. Serialising
 * every write per account costs a row lock on a table with one row per user, and removes the entire class.
 */

/** What a caller must say to move value. The shape is the wiki's entry
 *  contract: account, signed amount, type, reason, source, actor, key. */
export type EntryInput = {
	userId: string;
	/** Signed, whole seconds. Positive credits, negative debits. Zero is
	 *  rejected by a check constraint - see the schema. */
	amount: number;
	entryType: LedgerEntryType;
	/** One line of prose for a person reading a statement. Nothing parses it. */
	reason: string;
	/** The key that makes a retry safe. Shapes are documented on the column. */
	idempotencyKey: string;
	orderId?: string | null;
	reversesEntryId?: string | null;
	actorId?: string | null;
	metadata?: JsonObject;
};

export type PostedEntry = {
	entry: LedgerEntry;
	/** False when the idempotency key already existed, which is a success. The
	 *  caller usually does not care; the admin surfaces say "already recorded"
	 *  rather than pretending a second correction was made. */
	created: boolean;
	/** The account balance after this entry, replayed rather than cached. */
	balance: number;
};

export class InsufficientBalance extends Error {
	readonly balance: number;
	readonly required: number;

	constructor(balance: number, required: number) {
		super(`Balance is ${balance} seconds and this costs ${required}. ` + 'Nothing was written.');
		this.name = 'InsufficientBalance';
		this.balance = balance;
		this.required = required;
	}
}

/* ── accounts ────────────────────────────────────────────────────────────── */

/**
 * This user's account, creating it if they have never had one.
 *
 * Get-or-create rather than a row written at signup, because a row written at
 * signup is a row that is missing for everyone who signed up before the ledger
 * existed - and this application already has users. `onConflictDoNothing`
 * followed by a select makes two concurrent first-purchases produce one account
 * rather than a unique-violation on whichever lost.
 */
export async function accountFor(userId: string, handle: DbHandle = db): Promise<LedgerAccount> {
	const [created] = await handle
		.insert(ledgerAccounts)
		.values({ userId, currency: 'seconds' })
		.onConflictDoNothing({
			target: [ledgerAccounts.userId, ledgerAccounts.currency]
		})
		.returning();
	if (created) return created;

	const [existing] = await handle
		.select()
		.from(ledgerAccounts)
		.where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.currency, 'seconds')))
		.limit(1);

	/* Unreachable: the insert either created it or a concurrent transaction did.
     Thrown rather than asserted non-null because a null here would otherwise
     surface as an unrelated error three lines later. */
	if (!existing) {
		throw new Error(`Ledger account for user ${userId} could neither be created nor found.`);
	}
	return existing;
}

/**
 * Take the account lock.
 *
 * Every writer in this file calls this before touching anything, so the lock
 * orders all economic activity for one participant. It must be called inside a
 * transaction - outside one, Postgres releases the lock at the end of the
 * statement and the protection is imaginary.
 *
 * `for update` on the ACCOUNT rather than on the user: locking the user row
 * would serialise a purchase against every login, identity refresh and role
 * change, for a guarantee about neither.
 */
async function lockAccount(userId: string, tx: DbHandle): Promise<LedgerAccount> {
	const account = await accountFor(userId, tx);

	const [locked] = await tx
		.select()
		.from(ledgerAccounts)
		.where(eq(ledgerAccounts.id, account.id))
		.for('update')
		.limit(1);

	return locked ?? account;
}

/* ── reading ─────────────────────────────────────────────────────────────── */

/**
 * The balance, summed from the entries.
 *
 * This is the authority. `coalesce` because a user with no entries sums to
 * null, and a null balance would compare false against every threshold - which
 * fails open on any check written as `balance < price`.
 */
export async function replayBalance(accountId: string, handle: DbHandle = db): Promise<number> {
	const [row] = await handle
		.select({
			total: raw<number>`coalesce(sum(${ledgerEntries.amount}), 0)::bigint`
		})
		.from(ledgerEntries)
		.where(eq(ledgerEntries.accountId, accountId));

	/* postgres-js returns bigint as a string to avoid a lossy conversion. These
     are seconds - a number holds every value this can produce with fifty bits
     to spare - so it is narrowed here once rather than at every call site. */
	return Number(row?.total ?? 0);
}

/**
 * The number to show someone.
 *
 * Reads the cache, and is the only function here that does. It is for display:
 * a dashboard, a badge, a figure. Nothing that authorises anything may call it,
 * which is why it is named for what it is rather than being called
 * `getBalance`.
 */
export async function cachedBalance(userId: string): Promise<number> {
	const [row] = await db
		.select({ balance: ledgerAccounts.cachedBalance })
		.from(ledgerAccounts)
		.where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.currency, 'seconds')))
		.limit(1);

	/* No account is a real answer: they have never earned or spent anything. */
	return row?.balance ?? 0;
}

/**
 * Seconds a participant has EARNED - for a progress-toward-the-goal meter, not
 * for spending.
 *
 * The balance answers "what can I spend"; this answers "how far am I toward
 * qualifying", and the two part company the moment anything is bought: a
 * purchase debits the balance but does not un-earn the approved hours behind it,
 * and a rejected order's refund must not re-count them. So this sums the earning
 * side of the ledger only - awards, admin adjustments, and the reversals that
 * unwind them - and ignores the order debit/refund round trip entirely.
 * Qualification is independent of the shop by construction.
 *
 * Until reviews exist there are no `submission_award` rows, so in practice this
 * is whatever an operator has adjusted - which is the honest number to show.
 */
export async function earnedSeconds(userId: string): Promise<number> {
	const [account] = await db
		.select({ id: ledgerAccounts.id })
		.from(ledgerAccounts)
		.where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.currency, 'seconds')))
		.limit(1);
	if (!account) return 0;

	const [row] = await db
		.select({
			total: raw<number>`coalesce(sum(${ledgerEntries.amount}), 0)::bigint`
		})
		.from(ledgerEntries)
		.where(
			and(
				eq(ledgerEntries.accountId, account.id),
				inArray(ledgerEntries.entryType, ['submission_award', 'admin_adjustment', 'reversal'])
			)
		);

	return Number(row?.total ?? 0);
}

/** A user's entries, newest first. The statement. */
export async function entriesFor(userId: string, limit = 50): Promise<LedgerEntry[]> {
	const [account] = await db
		.select({ id: ledgerAccounts.id })
		.from(ledgerAccounts)
		.where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.currency, 'seconds')))
		.limit(1);
	if (!account) return [];

	return db
		.select()
		.from(ledgerEntries)
		.where(eq(ledgerEntries.accountId, account.id))
		.orderBy(desc(ledgerEntries.createdAt))
		.limit(limit);
}

/** The entries attached to one order - its debit and, if it was refunded, its
 *  refund. Shown on the order page so the economic half is visible next to the
 *  operational one rather than inferred from the state. */
export async function entriesForOrder(orderId: string): Promise<LedgerEntry[]> {
	return db
		.select()
		.from(ledgerEntries)
		.where(eq(ledgerEntries.orderId, orderId))
		.orderBy(ledgerEntries.createdAt);
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * Append one entry, exactly once, and leave the cache correct.
 *
 * The idempotency is the unique index doing the work: a second attempt with the
 * same key inserts nothing, and the existing row is returned instead. That is
 * the whole mechanism - there is no attempt counter and no advisory
 * "already-done" flag, because both would be a second source of truth about
 * whether something happened.
 *
 * The cache is rewritten from a fresh replay rather than incremented. An
 * increment is correct if every past increment was correct, which is an
 * assumption that gets weaker every deploy; a replay under the lock is right
 * regardless of what happened before it, so a cache that has drifted for any
 * reason repairs itself the next time the account is touched.
 *
 * MUST be called inside a transaction. Two things depend on it: the lock is
 * only a lock for the length of one, and the caller's own writes - an order
 * row, an outbox row, an audit event - have to commit with this or not at all.
 */
export async function postEntry(input: EntryInput, tx: DbHandle): Promise<PostedEntry> {
	const account = await lockAccount(input.userId, tx);

	const [inserted] = await tx
		.insert(ledgerEntries)
		.values({
			accountId: account.id,
			currency: 'seconds',
			amount: input.amount,
			entryType: input.entryType,
			reason: input.reason,
			idempotencyKey: input.idempotencyKey,
			orderId: input.orderId ?? null,
			reversesEntryId: input.reversesEntryId ?? null,
			actorId: input.actorId ?? null,
			metadata: input.metadata ?? null
		})
		/* No target, so EVERY unique conflict is absorbed rather than just the
       idempotency one. With a target, a clash on `reverses_entry_id` raised
       before this line and the legible refusal below could never run - the
       branch existed and was unreachable. Untargeted, both conflicts land here
       and the lookup tells them apart: found means the idempotent retry it was
       written for, not found means something else already reversed this entry. */
		.onConflictDoNothing()
		.returning();

	const balance = await replayBalance(account.id, tx);

	if (!inserted) {
		const [existing] = await tx
			.select()
			.from(ledgerEntries)
			.where(eq(ledgerEntries.idempotencyKey, input.idempotencyKey))
			.limit(1);

		if (!existing) {
			/* The insert conflicted and the conflicting row is not there. The only
         way that happens is a conflict on a DIFFERENT unique index -
         `reverses_entry_id`, which enforces one effective reversal per
         original. Saying so is the difference between a legible refusal and a
         null dereference two frames up. */
			throw new Error(
				`Entry ${input.idempotencyKey} conflicted with an existing row that is ` +
					'not it. This is the one-reversal-per-entry constraint: something has ' +
					`already reversed entry ${input.reversesEntryId ?? '(none given)'}.`
			);
		}
		return { entry: existing, created: false, balance };
	}

	await tx
		.update(ledgerAccounts)
		.set({ cachedBalance: balance, updatedAt: new Date() })
		.where(eq(ledgerAccounts.id, account.id));

	return { entry: inserted, created: true, balance };
}

/**
 * Take value, refusing if it is not there.
 *
 * The sequence is the wiki's recommended invariant, in order: lock the account,
 * recompute the spendable balance from the authoritative entries, then append
 * the debit. Callers do the stock and quota guards between the lock and the
 * debit - that is why this takes a transaction rather than opening one.
 *
 * `amount` is positive here and negated on the way in, because a caller passing
 * a negative to a function called `spend` would eventually pass a positive and
 * credit somebody by accident.
 */
export async function spend(
	input: Omit<EntryInput, 'amount' | 'entryType'> & {
		amount: number;
		entryType?: Extract<LedgerEntryType, 'order_debit'>;
	},
	tx: DbHandle
): Promise<PostedEntry> {
	if (input.amount <= 0) {
		throw new Error(`spend() needs a positive amount, got ${input.amount}.`);
	}

	const account = await lockAccount(input.userId, tx);
	const balance = await replayBalance(account.id, tx);

	if (balance < input.amount) throw new InsufficientBalance(balance, input.amount);

	return postEntry({ ...input, amount: -input.amount, entryType: 'order_debit' }, tx);
}

/**
 * Give value back.
 *
 * A new positive entry linked to the same order, never an edit to the debit and
 * never a deletion of it. The wiki's compensating-actions page is explicit that
 * a reversal must not reuse the original transition, and this is the ledger half
 * of that: the order's state machine records that it was rejected, and this
 * records that the seconds came back. Both facts survive.
 *
 * There is no balance check. A refund can only increase a balance, and refusing
 * one because of some other condition would be inventing a way to owe somebody
 * money the system will not pay.
 */
export async function refund(
	input: Omit<EntryInput, 'amount' | 'entryType'> & { amount: number },
	tx: DbHandle
): Promise<PostedEntry> {
	if (input.amount <= 0) {
		throw new Error(`refund() needs a positive amount, got ${input.amount}.`);
	}
	return postEntry({ ...input, entryType: 'order_refund' }, tx);
}

/**
 * An operator moving a balance by hand.
 *
 * Signed, because both directions are real: a credit for work that was recorded
 * wrong, a debit for value that should not have been granted. Both require
 * `adjust_ledger`, which no role implies - checked at the call site, because
 * this module knows nothing about who is asking.
 *
 * An adjustment may take a balance negative and that is deliberate. The wiki
 * asks for the decision to be explicit, and this is it: forbidding it would mean
 * an operator clawing back value that has already been spent has no
 * representable way to say so, and would have to leave the discrepancy
 * unrecorded. A negative balance blocks every purchase on its own - the spend
 * check is `balance < price` - so it shows as a debt rather than as a hole.
 */
export async function adjust(
	input: Omit<EntryInput, 'entryType'>,
	tx: DbHandle
): Promise<PostedEntry> {
	return postEntry({ ...input, entryType: 'admin_adjustment' }, tx);
}

/**
 * Undo an award that should not have happened.
 *
 * Distinct from a refund, which reverses a purchase. This reverses an EARNING -
 * an approval that was overturned, a duplicate credit - and the two are separate
 * types because they have different authority and different evidence, and one
 * type for both would make them indistinguishable in the audit query that needs
 * to tell them apart.
 *
 * The amount is the original's, negated, and cannot be given by the caller: a
 * partial reversal is not a reversal, and letting a number be passed here is how
 * one gets written.
 */
export async function reverseEntry(
	input: {
		userId: string;
		original: LedgerEntry;
		reason: string;
		/** Null when no person did it - Ari taking a decision back. */
		actorId: string | null;
		metadata?: JsonObject;
	},
	tx: DbHandle
): Promise<PostedEntry> {
	return postEntry(
		{
			userId: input.userId,
			amount: -input.original.amount,
			entryType: 'reversal',
			reason: input.reason,
			idempotencyKey: `reverse:${input.original.id}`,
			reversesEntryId: input.original.id,
			orderId: input.original.orderId,
			actorId: input.actorId,
			metadata: {
				...input.metadata,
				originalType: input.original.entryType,
				originalAmount: input.original.amount
			}
		},
		tx
	);
}
