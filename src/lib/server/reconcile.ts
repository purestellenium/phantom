import { sql as raw } from 'drizzle-orm';

import { db } from '$lib/server/db/client';

/**
 * Proving the books are right, or finding out exactly where they are not.
 *
 * Every check here is one of the wiki's integrity queries, and the reason they
 * are code rather than a document is that an integrity query nobody can run is
 * a claim rather than a check. They are read-only and they always have been:
 * this file NEVER REPAIRS ANYTHING. The wiki's operator pattern is
 * scan → print deterministic differences → require an explicit apply, and the
 * apply half is deliberately absent because every repair available here would
 * be an append to the ledger, which is a decision with a reason attached and
 * not something a button should do in a loop.
 *
 * "Never repair by directly editing balance. Append missing or corrective
 * entries with a repair run ID." When there is something to repair, an operator
 * makes an adjustment with the finding quoted in its reason, and the adjustment
 * is itself an auditable row.
 *
 * Raw SQL rather than the query builder throughout. These are aggregates,
 * anti-joins and window-free set comparisons - the shapes an ORM expresses
 * worst - and the point of a check is that a reader can see what it asks.
 */

export type Finding = {
	/** Stable identifier, so a finding can be referred to in an adjustment's
	 *  reason and found again later. */
	id: string;
	/** What is being checked, as a question with a right answer. */
	title: string;
	/** What a non-zero count means and what to do about it. */
	meaning: string;
	count: number;
	/** Up to a handful of offending rows, as text. Enough to start looking; not
	 *  a dump, because a check that returns ten thousand rows is one an operator
	 *  scrolls past. */
	sample: string[];
};

const SAMPLE_LIMIT = 5;

/** One row of a check's result. The columns differ per query - these are
 *  aggregate scans written as raw SQL - and every value is only ever printed,
 *  so the contract is "whatever a column can hold", named rather than open. */
type FindingRow = Record<string, string | number | boolean | Date | null>;

/** Run one query and shape it into a finding. Kept generic so each check below
 *  is only its SQL and its prose. */
async function check(
	id: string,
	title: string,
	meaning: string,
	query: ReturnType<typeof raw>
): Promise<Finding> {
	const rows = await db.execute<FindingRow>(query);
	return {
		id,
		title,
		meaning,
		count: rows.length,
		sample: rows.slice(0, SAMPLE_LIMIT).map((row) => describe(row))
	};
}

function describe(row: FindingRow): string {
	return Object.entries(row)
		.map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
		.join(' ');
}

/**
 * Every check, run.
 *
 * Sequential rather than parallel, and that is deliberate: these are aggregate
 * scans over the economic tables, and firing eight of them at once against a
 * single small Postgres to save a second on a page an operator loads twice a
 * week is the wrong trade.
 */
export async function reconcile(): Promise<Finding[]> {
	return [
		/* THE headline check, and the one that justifies caching a balance at all.
       lib/ledger.ts rewrites the cache from a fresh replay inside the same
       locked transaction as every entry, so this should always be empty - and
       "should always be empty" is exactly the claim worth testing, because the
       day it stops being true is the day somebody wrote to the table without
       going through postEntry(). */
		await check(
			'cached-balance-drift',
			'cached balances that disagree with the entries',
			'The cache is a projection and the entries are the authority. A row here ' +
				'means something wrote to ledger_entries outside lib/ledger.ts. The ' +
				'balance itself is not wrong - replay is - but the number people are ' +
				'being shown is.',
			raw`
        select a.id as account_id,
               a.user_id,
               a.cached_balance,
               coalesce(sum(e.amount), 0) as replayed
        from ledger_accounts a
        left join ledger_entries e on e.account_id = a.id
        group by a.id, a.user_id, a.cached_balance
        having a.cached_balance <> coalesce(sum(e.amount), 0)
      `
		),

		/* An order that took value but has no record of taking it. The wiki lists
       "order debit without order" and this is its mirror, which is the more
       dangerous direction: the person has the thing and the seconds. */
		await check(
			'order-without-debit',
			'orders with no matching debit',
			'Someone has an order that never cost them anything. Either the debit ' +
				'failed to write - impossible inside the purchase transaction - or the ' +
				'row was inserted by hand.',
			raw`
        select o.id as order_id, o.user_id, o.total_price, o.state
        from orders o
        where not exists (
          select 1 from ledger_entries e
          where e.order_id = o.id and e.entry_type = 'order_debit'
        )
      `
		),

		/* And the opposite: value taken for an order that does not exist. */
		await check(
			'debit-without-order',
			'order debits pointing at nothing',
			'A debit references an order that is not there. Orders are never deleted, ' +
				'so this means the reference was wrong when it was written.',
			raw`
        select e.id as entry_id, e.order_id, e.amount
        from ledger_entries e
        where e.entry_type = 'order_debit'
          and e.order_id is not null
          and not exists (select 1 from orders o where o.id = e.order_id)
      `
		),

		/* The amount taken must be the amount the order says it cost. A mismatch
       means the price moved between the two writes, which the purchase
       transaction makes impossible - it reads both from one frozen revision. */
		await check(
			'debit-amount-mismatch',
			"debits that do not match their order's total",
			'The order says one price and the ledger took another. The frozen total ' +
				'is what the participant agreed to; the ledger is what actually moved.',
			raw`
        select o.id as order_id, o.total_price, e.amount as debited
        from orders o
        join ledger_entries e
          on e.order_id = o.id and e.entry_type = 'order_debit'
        where e.amount <> -o.total_price
      `
		),

		/* Refund without a purchase. The wiki names this one directly. */
		await check(
			'refund-without-debit',
			'refunds with no purchase behind them',
			'Value was given back for an order that never took any. This is free ' +
				'currency and should be reversed with an adjustment quoting this check.',
			raw`
        select e.id as entry_id, e.order_id, e.amount
        from ledger_entries e
        where e.entry_type = 'order_refund'
          and not exists (
            select 1 from ledger_entries d
            where d.order_id = e.order_id and d.entry_type = 'order_debit'
          )
      `
		),

		/* A refunded order should be rejected or cancelled, and a rejected or
       cancelled order should be refunded. Both directions in one query, because
       either alone reads as a partial answer. */
		await check(
			'state-refund-mismatch',
			'orders whose state and refund disagree',
			'A rejected or cancelled order that was not refunded means somebody is ' +
				'out of pocket. A live order that WAS refunded means somebody has both ' +
				'the thing and the seconds.',
			raw`
        select o.id as order_id,
               o.state,
               exists (
                 select 1 from ledger_entries e
                 where e.order_id = o.id and e.entry_type = 'order_refund'
               ) as refunded
        from orders o
        where (o.state in ('rejected', 'cancelled')) <> exists (
          select 1 from ledger_entries e
          where e.order_id = o.id and e.entry_type = 'order_refund'
        )
      `
		),

		/* One effective reversal per original is a unique index, so this can only
       fire if the index is missing - which is worth knowing, because an index
       that was dropped in a migration takes its guarantee with it silently. */
		await check(
			'multiple-reversals',
			'entries reversed more than once',
			'The unique index on reverses_entry_id enforces this. A row here means ' +
				'the index is gone.',
			raw`
        select reverses_entry_id, count(*) as reversals
        from ledger_entries
        where reverses_entry_id is not null
        group by reverses_entry_id
        having count(*) > 1
      `
		),

		/* A reversal has to reverse something that exists and has to be its exact
       opposite. A partial reversal is not a reversal - see lib/ledger.ts, which
       does not let a caller choose the amount. */
		await check(
			'reversal-mismatch',
			'reversals that do not cancel their original',
			"A reversal must be the original's exact negation. Anything else is an " +
				"adjustment wearing a reversal's name.",
			raw`
        select r.id as reversal_id, r.amount as reversal, o.amount as original
        from ledger_entries r
        join ledger_entries o on o.id = r.reverses_entry_id
        where r.amount <> -o.amount
      `
		),

		/* Orders that name a frozen product version with no revision row. The
       purchase path refuses to sell in that state, so this is a check that the
       refusal is holding. */
		await check(
			'order-without-revision',
			'orders whose frozen product version is missing',
			'The order records what version it bought and that version has no ' +
				'revision row, so nothing can say what it was. This is the exact ' +
				'failure product_revisions exists to prevent.',
			raw`
        select o.id as order_id, o.product_id, o.product_version
        from orders o
        where not exists (
          select 1 from product_revisions r
          where r.product_id = o.product_id and r.version = o.product_version
        )
      `
		),

		/* The constraint says a non-physical order cannot hold an address. This
       checks the other half of the same rule: a physical order that has none
       cannot be shipped, and finding that out at fulfilment time is finding out
       too late. */
		await check(
			'physical-without-address',
			'physical orders with no address',
			'These cannot be shipped. The purchase path requires an address for ' +
				'physical products, so a row here predates that rule or was inserted ' +
				'by hand.',
			raw`
        select id as order_id, user_id, product_name, state
        from orders
        where product_kind = 'physical'
          and shipping_encrypted is null
          and state not in ('rejected', 'cancelled')
      `
		),

		/* Not an economic check - an operational one. The wiki's alert list opens
       with "stuck pending states", and an order nobody has touched in a
       fortnight is the shape that takes here. */
		await check(
			'stale-open-orders',
			'orders untouched for more than 14 days',
			'Nothing is wrong with the books; somebody is waiting. Fulfil, reject or ' + 'say something.',
			raw`
        select id as order_id, product_name, state, state_at
        from orders
        where state in ('placed', 'on_hold', 'unfulfilled')
          and state_at < now() - interval '14 days'
        order by state_at
      `
		),

		/* The outbox's own health. An ambiguous row is the one that must never be
       retried automatically, so it stays until a person resolves it - which
       means it needs somewhere to be seen. */
		await check(
			'outbox-needing-attention',
			'outbox rows that are failed or ambiguous',
			'Failed rows are effects that will not happen. Ambiguous rows are effects ' +
				'that may or may not have happened and must be established at the far ' +
				'end before anything is retried.',
			raw`
        select id, effect, dedupe_key, status, attempts, last_error
        from outbox_events
        where status in ('failed', 'ambiguous')
        order by updated_at desc
      `
		)
	];
}

/** Whether anything needs a human. What a job's result records and what an
 *  alert would fire on. */
export function hasFindings(findings: Finding[]): boolean {
	return findings.some((finding) => finding.count > 0);
}
