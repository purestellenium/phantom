import { and, desc, eq, ilike, inArray, sql as raw, type SQL } from 'drizzle-orm';
import { resolve } from '$app/paths';
import type { PageServerLoad } from './$types';

import { ledgerEntryLog } from '$lib/server/log';
import { personMatches } from '$lib/server/people';

import { requireCapability } from '$lib/server/auth/authorize';
import { db } from '$lib/server/db/client';
import { ledgerAccounts, ledgerEntries, ledgerEntryType, users } from '$lib/server/db/schema';

/**
 * Every entry in the program, newest first.
 *
 * Behind `adjust_ledger` rather than `view_audit`, and that is deliberate: this
 * is a complete picture of what everybody has and where it came from, which is
 * closer to a bank statement for the whole program than to a log. The people
 * who need it are the ones trusted to change it.
 *
 * The totals at the top are the balance projection, done once over the whole
 * table: what has been awarded, what has been spent, what has been given back,
 * and what is therefore outstanding. A program that cannot say how much it
 * owes cannot plan for it.
 */
/** The last `days` UTC calendar days, oldest first, as `YYYY-MM-DD`. */
function dayKeys(days: number): string[] {
	const out: string[] = [];
	for (let i = days - 1; i >= 0; i--) {
		out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
	}
	return out;
}

export const load: PageServerLoad = async ({ url }) => {
	requireCapability('adjust_ledger');
	const type = url.searchParams.get('type');

	const requested = ledgerEntryType.enumValues.find((known) => known === type);
	const filter = requested === undefined ? null : [requested];

	/* Whose, and what for. The person is matched the way every other box on
	   the console matches one; the reason is the free text the entry carries -
	   a project's name on an award, an operator's note on an adjustment. */
	const person = url.searchParams.get('person')?.trim() || null;
	const term = url.searchParams.get('q')?.trim() || null;
	const conditions: (SQL | undefined)[] = [
		filter ? inArray(ledgerEntries.entryType, filter) : undefined,
		person ? personMatches(person) : undefined,
		term
			? ilike(ledgerEntries.reason, `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`)
			: undefined
	];

	const [rows, totals, series] = await Promise.all([
		db
			.select({
				entry: ledgerEntries,
				email: users.email,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				userId: users.id
			})
			.from(ledgerEntries)
			.innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
			.innerJoin(users, eq(users.id, ledgerAccounts.userId))
			.where(and(...conditions))
			.orderBy(desc(ledgerEntries.createdAt))
			.limit(200),

		/* One pass, grouped. The alternative is a query per type, which is five
		   round trips for five numbers read together. */
		db
			.select({
				entryType: ledgerEntries.entryType,
				total: raw<number>`coalesce(sum(${ledgerEntries.amount}), 0)::bigint`,
				count: raw<number>`count(*)::int`
			})
			.from(ledgerEntries)
			.groupBy(ledgerEntries.entryType),

		/* The last thirty days, minted against spent, one row per day that had
		   either. Unfiltered on purpose: this is the program's pulse, and a
		   chart that changed shape with the search box would read as a chart
		   of the search. */
		db.execute<{ day: string; awarded: string | number; spent: string | number }>(raw`
			select
				to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
				coalesce(sum(amount) filter (where entry_type = 'submission_award'), 0)::bigint as awarded,
				coalesce(-sum(amount) filter (where entry_type = 'order_debit'), 0)::bigint as spent
			from ledger_entries
			where created_at >= now() - interval '30 days'
			group by 1
		`)
	]);
	const byDay = new Map(series.map((row) => [row.day, row]));
	const days = dayKeys(30);

	const byType = new Map(totals.map((row) => [row.entryType, row]));
	const sum = (name: (typeof ledgerEntryType.enumValues)[number]) =>
		Number(byType.get(name)?.total ?? 0);

	/* Each entry on the account it belongs to: the owner is the face, and the
	   name goes to their page. */
	const log = rows.map((row) => ({
		...ledgerEntryLog(row.entry, { name: row.displayName ?? row.email, avatarUrl: row.avatarUrl }),
		href: `/admin/users/${row.userId}`
	}));

	/* A type chip keeps the person and the reason typed beside it. Resolved
	   here, where the filters are. */
	const chip = (value: string | null) => {
		const q = new URLSearchParams();
		if (value) q.set('type', value);
		if (person) q.set('person', person);
		if (term) q.set('q', term);
		const query = q.toString();
		return query ? resolve(`/admin/ledger?${query}`) : resolve('/admin/ledger');
	};

	return {
		person,
		term,
		allHref: chip(null),
		chart: {
			awarded: days.map((key) => Number(byDay.get(key)?.awarded ?? 0)),
			spent: days.map((key) => Number(byDay.get(key)?.spent ?? 0))
		},
		log,
		outstanding: totals.reduce((running, row) => running + Number(row.total), 0),
		awarded: sum('submission_award'),
		spent: Math.abs(sum('order_debit')),
		refunded: sum('order_refund'),
		adjusted: sum('admin_adjustment'),
		types: ledgerEntryType.enumValues.map((value) => ({
			value,
			count: byType.get(value)?.count ?? 0,
			href: chip(value)
		}))
	};
};
