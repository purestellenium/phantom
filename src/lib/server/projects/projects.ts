import { and, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql as raw } from 'drizzle-orm';

import { recordAudit, type DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import {
	projects,
	submissions,
	users,
	type Project,
	type ProjectKind
} from '$lib/server/db/schema';
import { personMatches } from '$lib/server/people';
import { cleanUrl } from '$lib/url';

/**
 * Projects: the owner's editable working copy.
 *
 * Mutable, like a catalog product. What makes an edit safe while a ship is in
 * review is that a submission froze its own copy - see lib/projects/review.ts -
 * so nothing here can change what a reviewer is judging. Deletion is allowed only
 * before a project has ever been shipped; once it has a submission it is part of
 * the record (an approved one is tied to append-only ledger entries).
 */

export type ProjectDraft = {
	name: string;
	description: string | null;
	repoUrl: string | null;
	demoUrl: string | null;
	screenshotUrl: string | null;
	/** Comma-separated Hackatime project names. */
	hackatimeProjects: string | null;
	aiDeclaration: string | null;
	/** The owner's "this is an update to something that already existed"
	 *  declaration. Non-null is the mark. */
	updateDeclaration: string | null;
	/** Anything else the owner wants the reviewer to know. Free text, no
	 *  question attached. */
	notesForReviewer: string | null;
	/** The changelog for the next update ship, drafted ahead of it. Only the
	 *  project page carries it; left out, a save keeps what is stored. */
	changelogDraft?: string | null;
	/** Software or hardware. Only the new-project flow asks, so only a create
	 *  reads it - `normalise` drops it, which is what keeps a save on the
	 *  project page from clearing an answer it never showed. */
	kind?: ProjectKind | null;
};

/** A form value that is one of the kinds - the new-project flow and the ship
 *  question both take it from a form, which is to say from anybody. */
export function isProjectKind(value: unknown): value is ProjectKind {
	return value === 'software' || value === 'hardware';
}

export class ProjectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectError';
	}
}

function normalise(draft: ProjectDraft): ProjectDraft {
	return {
		name: draft.name.trim(),
		description: draft.description?.trim() || null,
		repoUrl: cleanUrl(draft.repoUrl),
		demoUrl: cleanUrl(draft.demoUrl),
		screenshotUrl: cleanUrl(draft.screenshotUrl),
		hackatimeProjects: draft.hackatimeProjects?.trim() || null,
		aiDeclaration: draft.aiDeclaration?.trim() || null,
		updateDeclaration: draft.updateDeclaration?.trim() || null,
		notesForReviewer: draft.notesForReviewer?.trim() || null,
		...(draft.changelogDraft !== undefined
			? { changelogDraft: draft.changelogDraft?.trim() || null }
			: {})
	};
}

/* ── reading ─────────────────────────────────────────────────────────────── */

/**
 * Look a project up by its public, front-facing number (1, 2, 3, ...) rather
 * than the UUID primary key - the number is what the URL and every other
 * user-facing surface carries. The UUID stays internal, reached only through
 * the row this returns.
 */
export async function projectByNumber(number: number): Promise<Project | null> {
	if (!Number.isInteger(number) || number <= 0) return null;
	const [row] = await db.select().from(projects).where(eq(projects.number, number)).limit(1);
	return row ?? null;
}

export async function projectsForUser(
	userId: string,
	limit?: number,
	offset = 0,
	/** Which of their projects: the ones in use (the default), or the
	 *  archived ones - see `archiveProject`. */
	which: 'active' | 'archived' = 'active'
): Promise<Project[]> {
	const query = db
		.select()
		.from(projects)
		.where(
			and(
				eq(projects.userId, userId),
				which === 'archived' ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt)
			)
		)
		/* Newest first, then number, for the reason listShowcase gives: paging
		   walks this with limit/offset, and two projects created in the same
		   millisecond - which the seed manages routinely - have no defined order
		   without a tiebreak, so a row can appear on two pages or on none. */
		.orderBy(desc(projects.createdAt), desc(projects.number))
		.offset(offset);

	/* Undefined means every row, which is what the callers that are not paging
	   want; `.limit(undefined)` is not a way to say that. */
	return limit === undefined ? query : query.limit(limit);
}

/** The stored column - a comma-separated list - as the names it means. Here
 *  rather than in review.ts because this is the shape of a projects column, and
 *  both the claim rule below and the ship path need to read it the same way. */
export function parseProjectNames(list: string | null): string[] {
	if (!list) return [];
	return list
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
}

/**
 * Hackatime project names already claimed by this user's OTHER projects.
 *
 * The picker uses this to grey out a name elsewhere in the same account: two
 * Phantom projects both drawing hours from the same Hackatime project would
 * double-count the same tracked time as new work in both submissions.
 */
export async function hackatimeNamesInUse(
	userId: string,
	exceptProjectId: string,
	handle: DbHandle = db
): Promise<Set<string>> {
	const rows = await handle
		.select({ hackatimeProjects: projects.hackatimeProjects })
		.from(projects)
		.where(and(eq(projects.userId, userId), ne(projects.id, exceptProjectId)));

	const names = new Set<string>();
	for (const row of rows) {
		for (const name of parseProjectNames(row.hackatimeProjects)) names.add(name);
	}
	const history = await handle
		.select({ hackatimeProjects: submissions.hackatimeProjects })
		.from(submissions)
		.where(and(eq(submissions.userId, userId), ne(submissions.projectId, exceptProjectId)));
	for (const row of history) {
		for (const name of parseProjectNames(row.hackatimeProjects)) names.add(name);
	}
	return names;
}

/**
 * ONE Hackatime project's hours may be claimed by ONE Phantom project.
 *
 * This is an economic rule and not a tidiness one, which is why it is enforced
 * here and not only drawn in the picker. A submission's award is its claimed
 * seconds minus the baseline of the PROJECT it belongs to, and those baselines
 * are tracked per project - so the same ten recorded hours listed on two
 * projects are ten hours of new work on each, and a participant who gets both
 * approved is paid twice for work they did once. The picker greys out a name
 * spoken for elsewhere, and the picker is a drawing of the rule rather than the
 * rule: the field it feeds is a text input in a form, and the form is a POST
 * endpoint.
 *
 * Returns the offending names so the refusal can say which ones, because "one
 * of these is already used" against a list of eight is not something anybody
 * can act on.
 */
export async function claimedElsewhere(
	userId: string,
	exceptProjectId: string,
	list: string | null,
	handle: DbHandle = db
): Promise<string[]> {
	const wanted = parseProjectNames(list);
	if (wanted.length === 0) return [];
	const inUse = await hackatimeNamesInUse(userId, exceptProjectId, handle);
	return [...new Set(wanted.filter((name) => inUse.has(name)))];
}

/** The refusal, in one place: the save action and the ship path both give it,
 *  and two wordings for one rule is two rules as far as a reader is concerned. */
export function claimedElsewhereError(names: string[]): string {
	return names.length === 1
		? `${names[0]} is already linked to another of your projects.`
		: `${names.join(', ')} are already linked to other projects of yours.`;
}

/**
 * Hold every claim this user has, for the length of the transaction.
 *
 * The check above reads the sibling projects and the write that follows changes
 * one of them, and between those two moments a second request of this user's
 * can do the same thing - so two concurrent saves can each look, each see the
 * name free, and each take it. An advisory lock keyed on the USER is what makes
 * the pair atomic.
 *
 * Keyed on the user rather than on the rows, and taken before any row lock,
 * deliberately. Locking "my other projects" means a save on project A waits on
 * B's row while a save on B waits on A's, which is a deadlock rather than a
 * queue. One lock per person has no such cycle, contends only with that same
 * person's other requests, and is released by the commit whatever happens.
 */
export async function lockClaims(handle: DbHandle, userId: string): Promise<void> {
	await handle.execute(raw`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * `handle` so a caller can make the project part of something larger - the
 * onboarding finish creates the first project and marks setup done as one
 * write. Inside a caller's transaction this one nests as a savepoint, so the
 * claim lock and the audit row still travel with the insert.
 */
export async function createProject(
	userId: string,
	draft: ProjectDraft,
	handle: DbHandle = db
): Promise<Project> {
	const clean = normalise(draft);
	if (!clean.name) throw new ProjectError('A project needs a name.');

	return handle.transaction(async (tx) => {
		await lockClaims(tx, userId);
		const id = crypto.randomUUID();
		const taken = await claimedElsewhere(userId, id, clean.hackatimeProjects, tx);
		if (taken.length > 0) throw new ProjectError(claimedElsewhereError(taken));
		const [project] = await tx
			.insert(projects)
			.values({ id, userId, ...clean, kind: draft.kind ?? null })
			.returning();

		await recordAudit(
			{
				action: 'project.created',
				actorId: userId,
				subjectId: userId,
				metadata: { projectId: project.id }
			},
			tx
		);

		return project;
	});
}

/**
 * Answer the kind question for a project made before it was asked.
 *
 * Only ever fills a blank: `isNull` in the write means an answer already on
 * the row is never replaced from here, so a stale tab or a replayed ship
 * cannot flip a hardware project to software. Owner-scoped like every other
 * write in this file.
 */
export async function fillProjectKind(
	projectNumber: number,
	userId: string,
	kind: ProjectKind
): Promise<void> {
	await db
		.update(projects)
		.set({ kind, updatedAt: new Date() })
		.where(
			and(eq(projects.number, projectNumber), eq(projects.userId, userId), isNull(projects.kind))
		);
}

/* ── archiving ───────────────────────────────────────────────────────────── */

/** How many of someone's projects are archived, for the link to them. */
export async function archivedCount(userId: string): Promise<number> {
	const [row] = await db
		.select({ n: raw<number>`count(*)::int` })
		.from(projects)
		.where(and(eq(projects.userId, userId), isNotNull(projects.archivedAt)));
	return row?.n ?? 0;
}

export type ArchiveResult = { ok: true } | { ok: false; error: string };

/**
 * Put a project away, or bring it back.
 *
 * Archiving is for what deleting cannot reach: a project that was shipped -
 * so it is part of the record - and was never approved. One with an approval
 * is earned work and stays where it is; one in review or waiting on changes
 * is still going somewhere. Bringing one back is always allowed.
 *
 * Owner-scoped like every edit here, and decided under the project's row lock
 * so a ship cannot land between the check and the write.
 */
export async function archiveProject(
	projectNumber: number,
	userId: string,
	archived: boolean
): Promise<ArchiveResult> {
	return db.transaction(async (tx) => {
		const [project] = await tx
			.select({ id: projects.id, archivedAt: projects.archivedAt })
			.from(projects)
			.where(and(eq(projects.number, projectNumber), eq(projects.userId, userId)))
			.for('update')
			.limit(1);
		if (!project) return { ok: false, error: 'That project does not exist.' };
		if ((project.archivedAt !== null) === archived) return { ok: true };

		if (archived) {
			const states = await tx
				.select({ state: submissions.state })
				.from(submissions)
				.where(eq(submissions.projectId, project.id));
			if (states.length === 0) {
				return { ok: false, error: 'A project that was never shipped can be deleted instead.' };
			}
			if (states.some((row) => row.state === 'approved' || row.state === 'revoked')) {
				return { ok: false, error: 'A project with an approved ship cannot be archived.' };
			}
			if (
				states.some(
					(row) =>
						row.state === 'pending' ||
						row.state === 'first_passed' ||
						row.state === 'changes_requested'
				)
			) {
				return { ok: false, error: 'This project is still in review.' };
			}
		}

		await tx
			.update(projects)
			.set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
			.where(eq(projects.id, project.id));
		await recordAudit(
			{
				action: archived ? 'project.archived' : 'project.unarchived',
				actorId: userId,
				subjectId: userId,
				metadata: { projectId: project.id }
			},
			tx
		);
		return { ok: true };
	});
}

/** What an edit to a project under review is told, in one place so the check
 *  that happens before an upload and the check that happens at the write
 *  cannot end up saying two different things. */
export const UNDER_REVIEW = 'This project is under review and cannot be edited.';

/**
 * Whether this project has a review open on it right now.
 *
 * Exported so a caller can ask BEFORE doing expensive work on the strength of
 * an edit that is going to be refused. The project page is the caller: it was
 * uploading a screenshot to the CDN and then discovering the project was
 * locked, which turns a refusal into a free file upload for anybody willing to
 * submit a form they know will fail.
 *
 * It is not the authorization. `updateProject` asks again as part of the write,
 * because a check that runs before one is a check something can slip past.
 */
export async function isUnderReview(
	projectNumber: number,
	userId: string,
	handle: DbHandle = db
): Promise<boolean> {
	const [open] = await handle
		.select({ id: submissions.id })
		.from(submissions)
		.innerJoin(projects, eq(projects.id, submissions.projectId))
		.where(
			and(
				eq(projects.number, projectNumber),
				eq(projects.userId, userId),
				inArray(submissions.state, ['pending', 'first_passed'])
			)
		)
		.limit(1);
	return open !== undefined;
}

export type UpdateResult = { ok: true; project: Project } | { ok: false; error: string };

export async function updateProject(
	projectNumber: number,
	userId: string,
	draft: ProjectDraft
): Promise<UpdateResult> {
	const clean = normalise(draft);
	if (!clean.name) return { ok: false, error: 'A project needs a name.' };

	/* Locked while a review is open. The submission froze its own copy, so an
	   edit could not change what the reviewer sees - but the author editing
	   under a review and the reviewer judging what they shipped is two
	   versions of one project, and the page shows the working copy. */
	if (await isUnderReview(projectNumber, userId)) return { ok: false, error: UNDER_REVIEW };

	return db.transaction(async (tx) => {
		await lockClaims(tx, userId);

		/* The row first, because the claim rule is "not on my OTHER projects" and
		   that needs this project's id to exclude it - a project must be allowed
		   to keep the names it already has. Owner-scoped, so someone else's number
		   in the URL finds nothing rather than reading a project that is not
		   theirs. */
		const [current] = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.number, projectNumber), eq(projects.userId, userId)))
			.for('update')
			.limit(1);
		if (!current) return { ok: false, error: 'That project does not exist.' };
		if (await isUnderReview(projectNumber, userId, tx)) {
			return { ok: false, error: UNDER_REVIEW };
		}

		const taken = await claimedElsewhere(userId, current.id, clean.hackatimeProjects, tx);
		if (taken.length > 0) return { ok: false, error: claimedElsewhereError(taken) };

		/* The kind, when the form said one: `normalise` leaves it out so a form
		   that never showed it cannot clear it, and a form that did - the
		   project page's software/hardware switch - sets it here. */
		const kind = isProjectKind(draft.kind) ? { kind: draft.kind } : {};
		const [updated] = await tx
			.update(projects)
			.set({ ...clean, ...kind, updatedAt: new Date() })
			.where(eq(projects.id, current.id))
			.returning();

		if (!updated) return { ok: false, error: 'That project does not exist.' };
		return { ok: true, project: updated };
	});
}

export type DeleteResult = { ok: true } | { ok: false; error: string };

/** Delete a project, but only if it has never been shipped. */
export async function deleteProject(projectNumber: number, userId: string): Promise<DeleteResult> {
	return db.transaction(async (tx) => {
		const [project] = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.number, projectNumber), eq(projects.userId, userId)))
			.for('update')
			.limit(1);
		if (!project) return { ok: false, error: 'That project does not exist.' };

		const [{ count }] = await tx
			.select({ count: raw<number>`count(*)::int` })
			.from(submissions)
			.where(eq(submissions.projectId, project.id));
		if (count > 0) {
			return { ok: false, error: 'A project that has been shipped cannot be deleted.' };
		}

		await tx.delete(projects).where(eq(projects.id, project.id));
		await recordAudit(
			{
				action: 'project.deleted',
				actorId: userId,
				subjectId: userId,
				metadata: { projectId: project.id }
			},
			tx
		);
		return { ok: true };
	});
}

/* ── the operator's view ─────────────────────────────────────────────────── */

/**
 * Where a project stands, in one word, derived from its submissions.
 *
 * `draft` is the one that needed a name. A project with no submissions is
 * invisible to every other surface in the application - the review queue is
 * built from open submissions, explore from approved ones, and the owner's own
 * list was the only place one ever appeared - so "never shipped" was a state
 * nobody could look at in aggregate. It is also the state most worth looking
 * at: a hundred drafts and no ships is a different program from ten of each.
 *
 * The order the checks run in is urgency, not chronology: a project with a
 * review open IS in review, whatever else it has been.
 */
export type ProjectStatus = 'draft' | 'review' | 'approved' | 'rejected';

export type ProjectRow = {
	id: string;
	number: number;
	name: string;
	hackatimeProjects: string | null;
	fraudHold: boolean;
	/** Put away by its owner - see `archiveProject`. */
	archived: boolean;
	createdAt: Date;
	status: ProjectStatus;
	/** How many times it has been shipped. Zero is what makes it a draft. */
	ships: number;
	/** The sum of every approved grant on it, in seconds. */
	approvedSeconds: number;
	/** Whether any of its approved ships is hyper-chroma. */
	hyperChroma: boolean;
	/** Null on the per-person list, which already knows whose page it is on. */
	owner: { id: string; name: string | null; email: string } | null;
};

/**
 * One row per project's submissions, joined once - not one query per project.
 *
 * Same reason `lastApprovedByProject` exists: a list page that costs a query
 * per row is a list page that falls over on the day the program gets big. Five
 * aggregates over one scan of `submissions` instead.
 *
 * Written as SQL rather than as a Drizzle subquery object because of how the
 * two render. A `sql``.as('ships')` column inside a `.as('project_stats')`
 * subquery comes back OUT of it as a bare `"ships"` - unqualified - and a bare
 * name in a query that also joins `projects` and `users` is one same-named
 * column away from being ambiguous, at which point Postgres refuses the whole
 * statement. Naming the alias in every reference costs a few characters and
 * cannot break that way.
 *
 * `in_review` and `has_approval` rather than `open` and `approved` for a
 * related reason: both of those are keywords elsewhere in the grammar, and an
 * unquoted alias is not the place to find out which ones the parser minds.
 */
const STATS_SOURCE = raw`(
		select
			${submissions.projectId} as project_id,
			count(*)::int as ships,
			bool_or(${submissions.state} in ('pending', 'first_passed', 'changes_requested')) as in_review,
			bool_or(${submissions.state} = 'approved') as has_approval,
			bool_or(${submissions.state} = 'approved' and ${submissions.hyperChroma}) as hyper_chroma,
			coalesce(sum(${submissions.awardedSeconds}) filter (where ${submissions.state} = 'approved'), 0)::bigint as approved_seconds
		from ${submissions}
		group by ${submissions.projectId}
	) as project_stats`;

const STATS_ON = raw`project_stats.project_id = ${projects.id}`;

/** The stats columns, one definition each, so the select list and the filters
 *  below cannot come to spell them differently. Every one is nullable: the join
 *  is a LEFT one and a draft is precisely the row it misses. */
const STATS = {
	ships: raw<number | null>`project_stats.ships`,
	inReview: raw<boolean | null>`project_stats.in_review`,
	hasApproval: raw<boolean | null>`project_stats.has_approval`,
	hyperChroma: raw<boolean | null>`project_stats.hyper_chroma`,
	approvedSeconds: raw<string | null>`project_stats.approved_seconds`
};

/**
 * The `status` filter, as a condition on the joined stats.
 *
 * Undefined for "all", which is also where an unrecognised value lands: this is
 * a query parameter people bookmark and send each other, and a 500 because a
 * word was renamed is a worse outcome than showing everything. The same
 * reasoning the orders queue applies to its own state parameter.
 */
function statusCondition(status: string | null) {
	switch (status) {
		case 'draft':
			return raw`project_stats.ships is null`;
		case 'review':
			return raw`project_stats.in_review`;
		case 'approved':
			return raw`project_stats.has_approval and not project_stats.in_review`;
		case 'rejected':
			return raw`project_stats.ships is not null and not project_stats.in_review and not project_stats.has_approval`;
		default:
			return undefined;
	}
}

/** The same derivation those conditions express in SQL, applied to a row that
 *  has already come back - so a project the filter includes is a project this
 *  labels the same way. Both read the same three columns. */
function statusOf(row: {
	ships: number | null;
	inReview: boolean | null;
	hasApproval: boolean | null;
}): ProjectStatus {
	if (row.ships === null) return 'draft';
	if (row.inReview) return 'review';
	return row.hasApproval ? 'approved' : 'rejected';
}

/** `%` and `_` are LIKE's own wildcards, so a term carrying one meant something
 *  other than itself. Escaped with the backslash LIKE takes by default - the
 *  value is a bind parameter either way, so this is about the search being
 *  right rather than being safe. Same rule as `personMatches`. */
function contains(term: string): string {
	return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The half of a row that is the same on both lists below. */
function toRow(row: {
	id: string;
	number: number;
	name: string;
	hackatimeProjects: string | null;
	fraudHold: boolean;
	archivedAt: Date | null;
	createdAt: Date;
	ships: number | null;
	inReview: boolean | null;
	hasApproval: boolean | null;
	hyperChroma: boolean | null;
	approvedSeconds: string | null;
}): Omit<ProjectRow, 'owner'> {
	return {
		id: row.id,
		number: row.number,
		name: row.name,
		hackatimeProjects: row.hackatimeProjects,
		fraudHold: row.fraudHold,
		archived: row.archivedAt !== null,
		createdAt: row.createdAt,
		status: statusOf(row),
		ships: row.ships ?? 0,
		/* A `::bigint` comes back from the driver as a string - db/client.ts
		   overrides only the date parser - so the conversion happens here rather
		   than in whatever renders it. */
		approvedSeconds: Number(row.approvedSeconds ?? 0),
		hyperChroma: row.hyperChroma === true
	};
}

/**
 * Every project, searchable and filterable - the operator's list.
 *
 * The term matches three different things at once, deliberately: the project's
 * name, the Hackatime project names linked to it, and the owner by anything
 * `personMatches` accepts. Somebody arriving from a Slack thread is holding a
 * Slack id, somebody arriving from Hackatime is holding a Hackatime project
 * name, and somebody arriving from a conversation has half a title. One box
 * takes all three, because an operator should not have to work out which kind
 * of thing they were handed before they can look it up.
 */
export async function searchProjects(input: {
	term: string | null;
	status: string | null;
	/** One page's worth, from `pageWindow` - which asks for one row more than
	 *  the page needs so the caller learns whether there is a next one without
	 *  a second `count(*)` round trip. Defaulted so a caller that wants a
	 *  bounded read and no paging does not have to invent a window. */
	limit?: number;
	offset?: number;
}): Promise<ProjectRow[]> {
	const term = input.term?.trim() || null;

	const conditions = [
		term
			? or(
					ilike(projects.name, contains(term)),
					ilike(projects.hackatimeProjects, contains(term)),
					personMatches(term)
				)
			: undefined,
		statusCondition(input.status)
	].filter((condition) => condition !== undefined);

	const rows = await db
		.select({
			id: projects.id,
			number: projects.number,
			name: projects.name,
			hackatimeProjects: projects.hackatimeProjects,
			fraudHold: projects.fraudHold,
			archivedAt: projects.archivedAt,
			createdAt: projects.createdAt,
			...STATS,
			ownerId: users.id,
			ownerName: users.displayName,
			ownerEmail: users.email
		})
		.from(projects)
		.innerJoin(users, eq(users.id, projects.userId))
		.leftJoin(STATS_SOURCE, STATS_ON)
		.where(conditions.length > 0 ? and(...conditions) : raw`true`)
		/* Newest first, then number, for the reason `projectsForUser` gives: two
		   rows created in the same millisecond have no defined order without a
		   tiebreak, so one can appear twice or not at all. */
		.orderBy(desc(projects.createdAt), desc(projects.number))
		.limit(input.limit ?? 50)
		.offset(Math.max(0, input.offset ?? 0));

	return rows.map((row) => ({
		...toRow(row),
		owner: { id: row.ownerId, name: row.ownerName, email: row.ownerEmail }
	}));
}

/**
 * The same rows for ONE person, drafts included, for their operator page.
 *
 * Bounded, though the bound is generous. This is a panel on somebody's page
 * rather than a list in its own right, and the answer it exists to give -
 * "what has this person actually made" - is legible in the first twenty rows
 * for every real account. What it must not be is unbounded: one person with a
 * runaway script is all it takes for a page with no limit on it to be the
 * slowest thing in the console, and the limit costs nothing on the accounts
 * where it never bites.
 *
 * The caller asks for one more than it will draw and links the remainder to the
 * full list, filtered to this person - so the panel stopping is a door rather
 * than a wall.
 */
export async function projectRowsForUser(userId: string, limit = 21): Promise<ProjectRow[]> {
	const rows = await db
		.select({
			id: projects.id,
			number: projects.number,
			name: projects.name,
			hackatimeProjects: projects.hackatimeProjects,
			fraudHold: projects.fraudHold,
			archivedAt: projects.archivedAt,
			createdAt: projects.createdAt,
			...STATS
		})
		.from(projects)
		.leftJoin(STATS_SOURCE, STATS_ON)
		.where(eq(projects.userId, userId))
		.orderBy(desc(projects.createdAt), desc(projects.number))
		.limit(limit);

	return rows.map((row) => ({ ...toRow(row), owner: null }));
}

/**
 * How many projects are in each status, across the whole program.
 *
 * For the filter tabs, which is why it ignores the search term: a count beside
 * a tab that moved every time somebody typed would be measuring the search
 * rather than the thing the tab names. One scan with four filters over the same
 * joined stats `searchProjects` uses, so the tallies and the rows can never
 * disagree about what "draft" means.
 */
export async function projectStatusCounts(): Promise<Record<ProjectStatus | 'all', number>> {
	const [row] = await db
		.select({
			all: raw<number>`count(*)::int`,
			draft: raw<number>`count(*) filter (where project_stats.ships is null)::int`,
			review: raw<number>`count(*) filter (where project_stats.in_review)::int`,
			approved: raw<number>`count(*) filter (where project_stats.has_approval and not project_stats.in_review)::int`,
			rejected: raw<number>`count(*) filter (where project_stats.ships is not null and not project_stats.in_review and not project_stats.has_approval)::int`
		})
		.from(projects)
		.leftJoin(STATS_SOURCE, STATS_ON);

	return row ?? { all: 0, draft: 0, review: 0, approved: 0, rejected: 0 };
}
