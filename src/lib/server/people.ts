import { ilike, inArray, or, type SQL } from 'drizzle-orm';

import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';

export type Person = { name: string; avatarUrl: string | null };

/**
 * What it means to look someone up by typing something into a box.
 *
 * One definition, because there is now more than one box. The people list has
 * always had one; the projects list needs the same question asked about a
 * project's OWNER, and "searchable by" drifting between the two is how an
 * operator learns that a Slack id works on one page and not the other.
 *
 * Five identifiers, each because a real conversation arrives carrying it: the
 * display name and the email are what a person calls themselves, the HCA
 * subject is what another Hack Club service quotes, and the Slack id and handle
 * are what get pasted out of a thread - which is most of them, since most of
 * them happen in Slack. A leading `@` is dropped, because a handle copied out
 * of Slack arrives with one and the column stores it without.
 *
 * Callers join `users` themselves and hand this the term; it returns the
 * condition, or undefined for an empty one so a `where` can drop it.
 *
 * `pii: false` leaves out the email and the HCA subject. A search answers
 * which rows matched even when it returns nothing else, so matching on a column
 * lets the searcher read it back a character at a time - a reader without
 * `view_pii` must not be able to search by what they may not see. The console
 * searches pass nothing and keep all five: their pages are for operators.
 */
export function personMatches(term: string, options: { pii?: boolean } = {}): SQL | undefined {
	const { pii = true } = options;
	const trimmed = term.trim().replace(/^@/, '');
	if (!trimmed) return undefined;
	/* `%` and `_` are LIKE's own wildcards, and a term carrying one meant
	   something other than itself - `a_b` quietly matched `axb`. Escaped with
	   the backslash LIKE takes by default; the value is a bind parameter either
	   way, so this is about the search being right rather than being safe. */
	const like = `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
	return or(
		ilike(users.displayName, like),
		pii ? ilike(users.email, like) : undefined,
		pii ? ilike(users.hcaSubject, like) : undefined,
		ilike(users.slackId, like),
		ilike(users.slackUsername, like)
	);
}

/**
 * What somebody with no display name is called.
 *
 * Their email address is NOT the fallback, and that is the whole point of this
 * constant existing. These maps name the actor on a log, and several of those
 * logs are participant-facing - an order's history names the operator who put
 * it on hold, a project's names the reviewer who passed it. Falling back to the
 * email handed a staff member's private address to whoever the log was drawn
 * for, which is a disclosure nothing on those pages asked for. A log that says
 * `phantom` is a log missing a name; one that says an address is a leak.
 *
 * The same word Log.svelte already uses for an actorless entry, so a nameless
 * person and the system read alike rather than one of them reading as a bug.
 */
const ANONYMOUS = 'phantom';

/** Names and faces for a set of user ids, for putting on a log. One query,
 *  nulls skipped, missing ids simply absent. */
export async function peopleById(ids: (string | null | undefined)[]): Promise<Map<string, Person>> {
	const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
	if (wanted.length === 0) return new Map();
	const rows = await db
		.select({
			id: users.id,
			displayName: users.displayName,
			avatarUrl: users.avatarUrl
		})
		.from(users)
		.where(inArray(users.id, wanted));
	return new Map(
		rows.map((row) => [row.id, { name: row.displayName ?? ANONYMOUS, avatarUrl: row.avatarUrl }])
	);
}
