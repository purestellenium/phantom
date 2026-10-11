/**
 * Histories, built once.
 *
 * Six loaders draw a log and four of them were building the same rows: an
 * order's moves, a ledger entry's badge and figure, and the merge of the two
 * into one list in the order things happened. The rules for what a state or an
 * entry type looks like belong in one place - a tone that differs by page is a
 * bug nobody reports, because each page looks right on its own.
 *
 * The shapes these return are $lib/log's LogEntry, which Log.svelte draws.
 */
import type { LogEntry } from '$lib/log';
import type { LedgerEntry, OrderTransition } from '$lib/server/db/schema';
import type { Person } from '$lib/server/people';
import { ENTRY_TYPE, ORDER_STATE } from '$lib/status';

/** Who did it, out of a `peopleById` map. Null is the system. */
function actorOf(people: Map<string, Person>, actorId: string | null): Person | null {
	return people.get(actorId ?? '') ?? null;
}

/** One move of an order: the state it landed in, and why. */
export function orderTransitionsToLog(
	transitions: OrderTransition[],
	people: Map<string, Person>
): LogEntry[] {
	return transitions.map((t) => ({
		id: t.id,
		actor: actorOf(people, t.actorId),
		badge: ORDER_STATE[t.toState],
		message: t.reason,
		at: t.createdAt
	}));
}

/** One ledger entry: what it was, how much, and why. A debit reads as waiting
 *  rather than bad - the fragments are spent, not refused. */
export function ledgerEntryLog(entry: LedgerEntry, actor: Person | null): LogEntry {
	return {
		id: entry.id,
		actor,
		badge: {
			label: ENTRY_TYPE[entry.entryType],
			tone: entry.amount < 0 ? 'is-waiting' : 'is-good'
		},
		fragments: { seconds: entry.amount, signed: true },
		message: entry.reason,
		at: entry.createdAt
	};
}

export function ledgerEntriesToLog(
	entries: LedgerEntry[],
	people: Map<string, Person>
): LogEntry[] {
	return entries.map((entry) => ledgerEntryLog(entry, actorOf(people, entry.actorId)));
}

/**
 * An order's whole history: the moves and the money, interleaved.
 *
 * They are two halves of one event and are shown together on purpose - a
 * rejected order whose refund is on another screen is how somebody ends up
 * asking whether they were refunded at all.
 */
export function orderHistory(
	transitions: OrderTransition[],
	entries: LedgerEntry[],
	people: Map<string, Person>
): LogEntry[] {
	return [
		...orderTransitionsToLog(transitions, people),
		...ledgerEntriesToLog(entries, people)
	].sort((a, b) => a.at.getTime() - b.at.getTime());
}
