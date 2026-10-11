import { sql as raw } from 'drizzle-orm';

import { db } from '$lib/server/db/client';
import type { OutboxStatus, SubmissionState, UserRole } from '$lib/server/db/schema';

/**
 * Who gets the credit for each ship filed to the YSWS base.
 *
 * A credit is a ship that went to Airtable, and it goes to whoever did that
 * ship's FIRST pass. The second pass is not credited, and a ship that never
 * reached Airtable - rejected, sent back, or approved to nothing by the
 * new-work cap - credits nobody, whatever review it had.
 *
 * Read off the rows that already record it rather than off a table of its
 * own: every Airtable filing is an `airtable.submission_approved` outbox row,
 * enqueued in the same transaction as the approval transition it came from
 * (so the two share a `created_at`, Postgres's `now()` being the
 * transaction's). Each row is matched to the latest approval on its
 * submission at or before it, and the first pass is read off that approval:
 *
 * - **Ari** (the transition's metadata carries `ari`): the reviewer Ari's
 *   `review.approved` names, who is the first-pass reviewer. Matched to a
 *   Phantom account by Slack id - at the time, or now, so somebody who signed
 *   up after reviewing still gets their earlier credits - and otherwise kept
 *   as the bare Slack id.
 * - **The old desk**: from `first_passed`, the actor of the first pass before
 *   it; straight from `pending`, an admin's full review, which was its own
 *   first pass.
 *
 * Read from the transitions, not `submissions.reviewer_id`: a requeue clears
 * that column, and the Airtable record it credited still stands.
 */

/** Statuses at which the record has gone to Airtable, or will without anyone
 *  stepping in. `failed` and `skipped` have not and will not, so they credit
 *  nobody; they are still listed on a reviewer's page. */
const CREDITED: readonly OutboxStatus[] = ['delivered', 'pending', 'retryable', 'ambiguous'];

export type Credit = {
	outboxId: string;
	status: OutboxStatus;
	credited: boolean;
	/** When the approval filed it. */
	at: Date;
	submissionId: string;
	submissionName: string;
	submissionState: SubmissionState;
	projectNumber: number;
	ownerName: string;
	awardedSeconds: number;
	source: 'ari' | 'desk';
	/** Who the credit goes to: a user id, a bare Slack id, `ari` for Ari's
	 *  automatic decisions, or null when the first pass cannot be told. */
	key: string | null;
	reviewerId: string | null;
	slackId: string | null;
};

type CreditRow = {
	outbox_id: string;
	status: OutboxStatus;
	created_at: Date | string;
	submission_id: string;
	submission_name: string;
	submission_state: SubmissionState;
	project_number: number;
	owner_name: string;
	awarded_seconds: number | string | null;
	from_ari: boolean;
	automatic: boolean;
	slack_id: string | null;
	reviewer_id: string | null;
};

export const AUTOMATIC_KEY = 'ari';

/** Every Airtable filing, newest first, with who its first pass credits. */
export async function airtableCredits(): Promise<Credit[]> {
	const rows = await db.execute<CreditRow>(raw`
		select
			o.id as outbox_id,
			o.status,
			o.created_at,
			s.id as submission_id,
			s.name as submission_name,
			s.state as submission_state,
			p.number as project_number,
			coalesce(owner.display_name, owner.email) as owner_name,
			coalesce((a.metadata->>'awardedSeconds')::bigint, s.awarded_seconds, 0) as awarded_seconds,
			(a.metadata ? 'ari') as from_ari,
			coalesce((a.metadata->'ari'->>'automatic')::boolean, false) as automatic,
			a.metadata->'ari'->>'reviewerSlackId' as slack_id,
			case
				when a.metadata ? 'ari' then coalesce(a.actor_id, by_slack.id)
				when a.from_state = 'first_passed' then first_pass.actor_id
				else a.actor_id
			end as reviewer_id
		from outbox_events o
		join submissions s on s.id = (o.payload->>'submissionId')::uuid
		join projects p on p.id = s.project_id
		join users owner on owner.id = s.user_id
		left join lateral (
			select t.actor_id, t.from_state, t.metadata, t.created_at
			from submission_transitions t
			where t.submission_id = s.id
				and t.to_state = 'approved'
				and t.created_at <= o.created_at
			order by t.created_at desc
			limit 1
		) a on true
		left join lateral (
			select t.actor_id
			from submission_transitions t
			where a.from_state = 'first_passed'
				and t.submission_id = s.id
				and t.to_state = 'first_passed'
				and t.created_at <= a.created_at
			order by t.created_at desc
			limit 1
		) first_pass on true
		left join users by_slack
			on a.metadata ? 'ari' and by_slack.slack_id = a.metadata->'ari'->>'reviewerSlackId'
		where o.effect = 'airtable.submission_approved'
		order by o.created_at desc
	`);

	return rows.map((row) => {
		const key = row.automatic
			? AUTOMATIC_KEY
			: (row.reviewer_id ?? (row.from_ari ? row.slack_id : null));
		return {
			outboxId: row.outbox_id,
			status: row.status,
			credited: CREDITED.includes(row.status),
			at: new Date(row.created_at),
			submissionId: row.submission_id,
			submissionName: row.submission_name,
			submissionState: row.submission_state,
			projectNumber: Number(row.project_number),
			ownerName: row.owner_name,
			awardedSeconds: Number(row.awarded_seconds ?? 0),
			source: row.from_ari ? 'ari' : 'desk',
			key,
			reviewerId: row.reviewer_id,
			slackId: row.slack_id
		};
	});
}

export type Reviewer = {
	key: string;
	userId: string | null;
	name: string;
	email: string | null;
	avatarUrl: string | null;
	role: UserRole | null;
	slackId: string | null;
	credited: number;
	week: number;
	month: number;
	creditedSeconds: number;
	/** Filings that went nowhere (failed or skipped) - not counted above. */
	unfiled: number;
	lastAt: Date | null;
};

type PersonRow = {
	id: string;
	display_name: string | null;
	email: string;
	avatar_url: string | null;
	role: UserRole;
	slack_id: string | null;
};

const DAY = 86_400_000;

/** The board: one row per person credited, most credits first. */
export async function reviewerBoard(credits: Credit[]): Promise<Reviewer[]> {
	const ids = [...new Set(credits.map((credit) => credit.reviewerId).filter(Boolean))] as string[];
	const people = new Map<string, PersonRow>();
	if (ids.length > 0) {
		const rows = await db.execute<PersonRow>(raw`
			select id, display_name, email, avatar_url, role, slack_id
			from users
			where id in (${raw.join(
				ids.map((id) => raw`${id}::uuid`),
				raw`, `
			)})
		`);
		for (const row of rows) people.set(row.id, row);
	}

	const now = Date.now();
	const board = new Map<string, Reviewer>();
	for (const credit of credits) {
		if (!credit.key) continue;
		let row = board.get(credit.key);
		if (!row) {
			const person = credit.reviewerId ? people.get(credit.reviewerId) : undefined;
			row = {
				key: credit.key,
				userId: person?.id ?? null,
				name:
					credit.key === AUTOMATIC_KEY
						? 'Ari (automatic)'
						: (person?.display_name ?? person?.email ?? credit.slackId ?? credit.key),
				email: person?.email ?? null,
				avatarUrl: person?.avatar_url ?? null,
				role: person?.role ?? null,
				slackId: person?.slack_id ?? credit.slackId,
				credited: 0,
				week: 0,
				month: 0,
				creditedSeconds: 0,
				unfiled: 0,
				lastAt: null
			};
			board.set(credit.key, row);
		}
		if (!credit.credited) {
			row.unfiled += 1;
			continue;
		}
		row.credited += 1;
		row.creditedSeconds += credit.awardedSeconds;
		const age = now - credit.at.getTime();
		if (age <= 7 * DAY) row.week += 1;
		if (age <= 30 * DAY) row.month += 1;
		if (!row.lastAt || credit.at > row.lastAt) row.lastAt = credit.at;
	}

	return [...board.values()]
		.filter((row) => row.credited > 0 || row.unfiled > 0)
		.sort((a, b) => b.credited - a.credited || b.creditedSeconds - a.creditedSeconds);
}

/** The console card: credits this week, and the top three of all time. */
export async function reviewerGlance(): Promise<{
	week: number;
	credited: number;
	top: { name: string; n: number }[];
}> {
	const credits = await airtableCredits();
	const board = await reviewerBoard(credits);
	return {
		week: board.reduce((sum, row) => sum + row.week, 0),
		credited: board.reduce((sum, row) => sum + row.credited, 0),
		top: board.slice(0, 3).map((row) => ({ name: row.name, n: row.credited }))
	};
}
