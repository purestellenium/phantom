import { aliasedTable, and, desc, eq, gte, ilike, lt, or, sql as raw, type SQL } from 'drizzle-orm';

import type { LogEntry } from '$lib/log';

import { db } from '$lib/server/db/client';
import { auditEvents, users, type AuditEvent } from '$lib/server/db/schema';

/**
 * Reading the audit table, for the page and for the file.
 *
 * One query behind both, because an export that ran a different query from
 * the page would be a file of something other than what the operator was
 * looking at. The filters come off the URL, so a result set is a link and the
 * download is that link with `/export` in it.
 */

export type AuditFilters = {
	/** Free text: the action, either party's email, or anything in the metadata. */
	term: string | null;
	/** An action prefix - `session`, `submission` - from the chips. */
	action: string | null;
	/** Who did it, and who it was done to, by name or email. */
	actor: string | null;
	subject: string | null;
	/** `YYYY-MM-DD`, inclusive at both ends. */
	from: string | null;
	to: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(value: string | null): string | null {
	return value && DAY.test(value) ? value : null;
}

function text(value: string | null): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function auditFiltersFrom(url: URL): AuditFilters {
	const q = url.searchParams;
	return {
		term: text(q.get('q')),
		action: text(q.get('action')),
		actor: text(q.get('actor')),
		subject: text(q.get('subject')),
		from: dateParam(q.get('from')),
		to: dateParam(q.get('to'))
	};
}

/** The same filters back as a query string, without the `?`, for the links. */
export function auditQuery(filters: AuditFilters): string {
	const q = new URLSearchParams();
	for (const [key, value] of Object.entries(filters))
		if (value) q.set(key === 'term' ? 'q' : key, value);
	return q.toString();
}

/* `%` and `_` are LIKE's own wildcards; a term carrying one meant itself. */
function like(term: string): string {
	return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export type AuditRow = {
	event: AuditEvent;
	actorEmail: string | null;
	actorName: string | null;
	actorAvatarUrl: string | null;
	subjectId: string | null;
	subjectEmail: string | null;
	subjectName: string | null;
};

export async function searchAudit(filters: AuditFilters, limit: number): Promise<AuditRow[]> {
	/* Two joins to the same table - the person who did it and the person it was
	   done to - so one of them needs an alias or the SQL is ambiguous. */
	const actor = aliasedTable(users, 'actor');
	const subject = aliasedTable(users, 'subject');

	const person = (table: typeof actor, term: string) =>
		or(ilike(table.email, like(term)), ilike(table.displayName, like(term)));

	const conditions: (SQL | undefined)[] = [];
	if (filters.action) conditions.push(ilike(auditEvents.action, `${filters.action}%`));
	if (filters.term) {
		conditions.push(
			or(
				ilike(auditEvents.action, like(filters.term)),
				ilike(actor.email, like(filters.term)),
				ilike(subject.email, like(filters.term)),
				ilike(raw`${auditEvents.metadata}::text`, like(filters.term))
			)
		);
	}
	if (filters.actor) conditions.push(person(actor, filters.actor));
	if (filters.subject) conditions.push(person(subject, filters.subject));
	/* Calendar days, UTC, the same boundary every per-day series on the console
	   uses. `to` is inclusive, so the bound is the start of the next day. */
	if (filters.from)
		conditions.push(gte(auditEvents.createdAt, new Date(`${filters.from}T00:00:00Z`)));
	if (filters.to) {
		const end = new Date(`${filters.to}T00:00:00Z`);
		end.setUTCDate(end.getUTCDate() + 1);
		conditions.push(lt(auditEvents.createdAt, end));
	}

	return db
		.select({
			event: auditEvents,
			actorEmail: actor.email,
			actorName: actor.displayName,
			actorAvatarUrl: actor.avatarUrl,
			subjectId: subject.id,
			subjectEmail: subject.email,
			subjectName: subject.displayName
		})
		.from(auditEvents)
		.leftJoin(actor, eq(actor.id, auditEvents.actorId))
		.leftJoin(subject, eq(subject.id, auditEvents.subjectId))
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(auditEvents.createdAt))
		.limit(limit);
}

/** The rows as the log draws them. Metadata as JSON, for the reason the page
 *  gives: a viewer that only knew the shapes it was written for would show
 *  nothing for the ones added afterwards. */
export function auditLog(rows: AuditRow[]): LogEntry[] {
	return rows.map((row) => ({
		id: row.event.id,
		actor:
			row.actorName || row.actorEmail
				? { name: row.actorName ?? row.actorEmail ?? '', avatarUrl: row.actorAvatarUrl }
				: null,
		badge: { label: row.event.action, tone: 'is-waiting' },
		message: row.subjectId ? `→ ${row.subjectName ?? row.subjectEmail}` : null,
		internal: row.event.metadata ? JSON.stringify(row.event.metadata, null, 2) : null,
		internalTag: 'metadata',
		at: row.event.createdAt
	}));
}

/** The prefixes that exist right now, counted, so the filters reflect what has
 *  actually been recorded rather than a list someone maintains by hand. */
export async function auditPrefixes(): Promise<{ prefix: string; count: number }[]> {
	return db
		.select({
			prefix: raw<string>`split_part(${auditEvents.action}, '.', 1)`,
			count: raw<number>`count(*)::int`
		})
		.from(auditEvents)
		.groupBy(raw`split_part(${auditEvents.action}, '.', 1)`)
		.orderBy(raw`count(*) desc`);
}
