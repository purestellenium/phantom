import { and, desc, eq, getTableColumns, ilike, isNotNull, or, sql as raw } from 'drizzle-orm';

import type { DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import {
	projectShowcase,
	projectUpvotes,
	projects,
	submissions,
	users,
	type ProjectKind,
	type ProjectShowcase
} from '$lib/server/db/schema';
import { NO_FILTERS, type ExploreFilters } from '$lib/explore/filters';

/**
 * The explore projection.
 *
 * Refreshed at terminal approval from the approved submission's snapshot, so the
 * public page shows each project AS IT WAS APPROVED - editing the working copy
 * afterward changes nothing until the next approval. Display-safe fields only; no
 * address, no email, no real name - the author is joined in live, by Slack
 * handle, when the gallery is read.
 */

/** Rebuild the showcase row for a project from its latest approved submission.
 *  Must run in the approval transaction so the page and the award commit together. */
export async function refreshShowcase(projectId: string, handle: DbHandle = db): Promise<void> {
	const [owner] = await handle
		.select({ userId: projects.userId })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!owner) return;

	const [latest] = await handle
		.select()
		.from(submissions)
		.where(and(eq(submissions.projectId, projectId), eq(submissions.state, 'approved')))
		.orderBy(desc(submissions.createdAt))
		.limit(1);
	/* Nothing approved any more - its only approval was revoked - so it has no
	   place on explore. Deleted rather than left frozen at the old total. */
	if (!latest) {
		await handle.delete(projectShowcase).where(eq(projectShowcase.projectId, projectId));
		return;
	}

	const [totals] = await handle
		.select({ total: raw<number>`coalesce(sum(${submissions.awardedSeconds}), 0)::bigint` })
		.from(submissions)
		.where(and(eq(submissions.projectId, projectId), eq(submissions.state, 'approved')));

	const row = {
		name: latest.name,
		description: latest.description,
		screenshotUrl: latest.screenshotUrl,
		demoUrl: latest.demoUrl,
		repoUrl: latest.repoUrl,
		totalApprovedSeconds: Number(totals?.total ?? 0),
		updatedAt: new Date()
	};

	await handle
		.insert(projectShowcase)
		.values({ projectId, ...row })
		.onConflictDoUpdate({ target: projectShowcase.projectId, set: row });
}

/* How many upvotes a showcase row's project has - a correlated count, cheap
   against the primary key on (project_id, user_id). */
const upvoteCount = raw<number>`(select count(*)::int from ${projectUpvotes} where ${projectUpvotes.projectId} = ${projectShowcase.projectId})`;

/* When a showcase row's project most recently became hyper-chroma: the latest
   mark among its approved ships, or null when none is marked. Correlated, like
   the upvote count - a project has a handful of ships. A mark on a ship that is
   no longer approved does not count; see projects/hyper-chroma.ts. Selected as
   text rather than as a timestamp, because a raw expression skips the column's
   date mapping - it is only ever compared and ordered by, here. */
const hyperChromaSince = raw<
	string | null
>`(select max(${submissions.hyperChromaAt}) from ${submissions} where ${submissions.projectId} = ${projectShowcase.projectId} and ${submissions.state} = 'approved' and ${submissions.hyperChroma})`;

export type ShowcaseRow = ProjectShowcase & {
	number: number;
	kind: ProjectKind | null;
	ownerId: string;
	authorUsername: string | null;
	upvotes: number;
	hyperChroma: boolean;
};

const SHOWCASE_COLUMNS = {
	...getTableColumns(projectShowcase),
	number: projects.number,
	kind: projects.kind,
	ownerId: projects.userId,
	authorUsername: users.slackUsername,
	upvotes: upvoteCount,
	hyperChroma: raw<boolean>`(${hyperChromaSince} is not null)`
};

/* Whether the reader has upvoted a showcase row's project. */
function viewerUpvotedOf(viewerId: string | null) {
	return viewerId
		? raw<boolean>`exists (select 1 from ${projectUpvotes} where ${projectUpvotes.projectId} = ${projectShowcase.projectId} and ${projectUpvotes.userId} = ${viewerId})`
		: raw<boolean>`false`;
}

/**
 * The public gallery, filtered and ordered as explore asks, each row with its
 * author's Slack handle - read live rather than frozen with the rest of the
 * row, so a handle changed in Slack shows here from its owner's next sign-in -
 * and its upvote count.
 *
 * Every ordering ends in the project id. The tiebreak is not decoration:
 * paging walks this ordering with limit/offset, and two projects on the same
 * figure have no defined order without it - so a row could sit on two pages,
 * or on neither. A total order is what makes an offset mean the same thing
 * twice.
 */
export async function listShowcase(
	limit = 60,
	offset = 0,
	filters: ExploreFilters = NO_FILTERS,
	/** Whose upvotes to mark - the reader's. */
	viewerId: string | null = null
): Promise<(ShowcaseRow & { viewerUpvoted: boolean })[]> {
	/* The search term is matched literally: `%`, `_` and `\` are escaped so a
	   name containing them finds itself rather than acting as a wildcard. */
	const like = filters.q ? `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
	const order =
		filters.sort === 'hours'
			? [desc(projectShowcase.totalApprovedSeconds), projectShowcase.projectId]
			: filters.sort === 'upvotes'
				? [desc(upvoteCount), desc(projectShowcase.totalApprovedSeconds), projectShowcase.projectId]
				: [desc(projectShowcase.updatedAt), projectShowcase.projectId];
	return db
		.select({ ...SHOWCASE_COLUMNS, viewerUpvoted: viewerUpvotedOf(viewerId) })
		.from(projectShowcase)
		.innerJoin(projects, eq(projects.id, projectShowcase.projectId))
		.innerJoin(users, eq(users.id, projects.userId))
		.where(
			and(
				filters.kind ? eq(projects.kind, filters.kind) : undefined,
				filters.hyperChroma ? isNotNull(hyperChromaSince) : undefined,
				like
					? or(
							ilike(projectShowcase.name, like),
							ilike(projectShowcase.description, like),
							ilike(users.slackUsername, like)
						)
					: undefined
			)
		)
		.orderBy(...order)
		.limit(limit)
		.offset(offset);
}

/**
 * The projects most recently marked hyper-chroma, newest mark first, for the
 * panel above explore's grid. Unfiltered: the panel is the same whatever the
 * grid below it is narrowed to. Ordered by when each became hyper-chroma rather
 * than when it was approved, so a project marked by hand long after its
 * approval still arrives at the front.
 */
export async function listHyperChroma(
	limit = 3,
	viewerId: string | null = null
): Promise<(ShowcaseRow & { viewerUpvoted: boolean })[]> {
	return db
		.select({ ...SHOWCASE_COLUMNS, viewerUpvoted: viewerUpvotedOf(viewerId) })
		.from(projectShowcase)
		.innerJoin(projects, eq(projects.id, projectShowcase.projectId))
		.innerJoin(users, eq(users.id, projects.userId))
		.where(isNotNull(hyperChromaSince))
		.orderBy(desc(hyperChromaSince), projectShowcase.projectId)
		.limit(limit);
}

/** One project as explore shows it, by its public number, or null when it is
 *  not on explore (never approved, or its approval taken back). */
export async function showcaseByNumber(number: number): Promise<ShowcaseRow | null> {
	const [row] = await db
		.select(SHOWCASE_COLUMNS)
		.from(projectShowcase)
		.innerJoin(projects, eq(projects.id, projectShowcase.projectId))
		.innerJoin(users, eq(users.id, projects.userId))
		.where(eq(projects.number, number))
		.limit(1);
	return row ?? null;
}

/** How many times a project has been approved: 1 for a first ship, more for
 *  each update approved since. Approvals Ari has since taken back are not
 *  counted - the same rule as the hours explore shows. */
export async function approvedShips(projectId: string): Promise<number> {
	const [row] = await db
		.select({ count: raw<number>`count(*)::int` })
		.from(submissions)
		.where(and(eq(submissions.projectId, projectId), eq(submissions.state, 'approved')));
	return row?.count ?? 0;
}
