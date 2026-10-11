import { desc, inArray } from 'drizzle-orm';

import { PAGE_SIZE, pageWindow, splitPage } from '$lib/paging';
import { listHackatimeProjects } from '$lib/server/auth/hackatime';
import { db } from '$lib/server/db/client';
import { submissions, type ProjectKind, type SubmissionState } from '$lib/server/db/schema';
import { NO_FILTERS, type ExploreFilters } from '$lib/explore/filters';
import { listHyperChroma, listShowcase, type ShowcaseRow } from '$lib/server/projects/showcase';
import { parseProjectNames, projectsForUser } from '$lib/server/projects/projects';

/**
 * One page of each card grid, shaped exactly as the browser receives it.
 *
 * This exists because every paged grid is now read from TWO places - the page's
 * own load for the first screenful, and an endpoint for each one after - and
 * those two must return identically shaped rows or the grid changes shape
 * halfway down as the reader scrolls. Writing the query and the shaping once,
 * here, is what makes that impossible rather than merely unlikely.
 *
 * Both return `more` alongside the rows, from the extra row `pageWindow` asks
 * for. See $lib/paging.ts for why that beats a second counting query.
 */

export type ShowcaseCard = {
	projectId: string;
	/** The public number, for the project's explore page. */
	number: number;
	kind: ProjectKind | null;
	upvotes: number;
	/** Whether the reader has upvoted it. */
	upvoted: boolean;
	/** Whether it is the reader's own - which cannot be upvoted. */
	mine: boolean;
	name: string;
	description: string | null;
	screenshotUrl: string | null;
	/** The author's Slack handle, never their name - this grid is read by every
	 *  participant. */
	authorUsername: string | null;
	totalApprovedSeconds: number;
	demoUrl: string | null;
	repoUrl: string | null;
	/** Marked exceptionally good - see projects/hyper-chroma.ts. */
	hyperChroma: boolean;
};

/* Named rather than spread. The showcase projection carries columns the
   gallery does not draw, and `...row` would put every one of them in the
   document - which is the habit that made this page heavy to begin with. */
function toCard(
	row: ShowcaseRow & { viewerUpvoted: boolean },
	viewerId: string | null
): ShowcaseCard {
	return {
		projectId: row.projectId,
		number: row.number,
		kind: row.kind,
		upvotes: row.upvotes,
		upvoted: row.viewerUpvoted,
		mine: viewerId !== null && row.ownerId === viewerId,
		name: row.name,
		description: row.description,
		screenshotUrl: row.screenshotUrl,
		authorUsername: row.authorUsername,
		totalApprovedSeconds: row.totalApprovedSeconds,
		demoUrl: row.demoUrl,
		repoUrl: row.repoUrl,
		hyperChroma: row.hyperChroma
	};
}

/** How many cards explore's "featured projects" panel shows. */
export const FEATURED_COUNT = 3;

/** The cards for explore's "featured projects" panel - the latest
 *  hyper-chroma ones - in the same shape as the grid's so one card draws
 *  both. `more` is whether there are others beyond them, read from one extra
 *  row the way the paged grids do (see $lib/paging.ts), for the panel's link
 *  to all of them. */
export async function hyperChromaCards(
	viewerId: string | null = null
): Promise<{ items: ShowcaseCard[]; more: boolean }> {
	const rows = await listHyperChroma(FEATURED_COUNT + 1, viewerId);
	return {
		items: rows.slice(0, FEATURED_COUNT).map((row) => toCard(row, viewerId)),
		more: rows.length > FEATURED_COUNT
	};
}

export async function showcasePage(
	offset = 0,
	filters: ExploreFilters = NO_FILTERS,
	viewerId: string | null = null
): Promise<{ items: ShowcaseCard[]; more: boolean; nextOffset: number }> {
	const window = pageWindow(offset);
	const { rows, more } = splitPage(
		await listShowcase(window.limit, window.offset, filters, viewerId)
	);

	return {
		items: rows.map((row) => toCard(row, viewerId)),
		more,
		nextOffset: window.offset + PAGE_SIZE
	};
}

export type ProjectCard = {
	number: number;
	name: string;
	description: string | null;
	screenshotUrl: string | null;
	state: SubmissionState | null;
	/** What Hackatime has for the project's linked Hackatime projects - the
	 *  same total a ship counts. Null when it cannot be asked: no linked
	 *  account, or Hackatime did not answer. */
	trackedSeconds: number | null;
	/** Whether any of its approved ships is hyper-chroma. */
	hyperChroma: boolean;
};

export async function projectsPage(
	userId: string,
	offset = 0,
	/** The projects in use, or the archived ones (their own page). */
	which: 'active' | 'archived' = 'active'
): Promise<{ items: ProjectCard[]; more: boolean; nextOffset: number }> {
	const window = pageWindow(offset);
	const { rows, more } = splitPage(
		await projectsForUser(userId, window.limit, window.offset, which)
	);

	/* The badge on each card is its newest submission's state. One query for the
	   whole page rather than one per card - the ordering does the picking, and
	   the first row seen for a project is its latest. Paging helps here twice:
	   this `in (...)` now names eighteen ids instead of every project the person
	   has ever made. */
	const ids = rows.map((project) => project.id);
	/* The card's figure is the time tracked, which is one Hackatime request
	   for the whole page: the account's per-project totals, summed per card.
	   A Hackatime that does not answer costs the figures, not the page. */
	const [states, hackatime] = await Promise.all([
		ids.length
			? db
					.select({
						projectId: submissions.projectId,
						state: submissions.state,
						hyperChroma: submissions.hyperChroma
					})
					.from(submissions)
					.where(inArray(submissions.projectId, ids))
					.orderBy(desc(submissions.createdAt))
			: Promise.resolve([]),
		rows.length ? listHackatimeProjects(userId).catch(() => null) : Promise.resolve(null)
	]);
	const secondsByName = new Map(
		(hackatime ?? []).map((project) => [project.name, project.totalSeconds])
	);

	const latest = new Map<string, SubmissionState>();
	/* Hyper-chroma from the same rows: any approved ship marked, not only the
	   latest - an update in review does not take the mark off the last one. */
	const hyperChroma = new Set<string>();
	for (const row of states) {
		if (!latest.has(row.projectId)) latest.set(row.projectId, row.state);
		if (row.state === 'approved' && row.hyperChroma) hyperChroma.add(row.projectId);
	}

	return {
		items: rows.map((project) => ({
			number: project.number,
			name: project.name,
			description: project.description,
			screenshotUrl: project.screenshotUrl,
			state: latest.get(project.id) ?? null,
			hyperChroma: hyperChroma.has(project.id),
			trackedSeconds: hackatime
				? parseProjectNames(project.hackatimeProjects).reduce(
						(sum, name) => sum + (secondsByName.get(name) ?? 0),
						0
					)
				: null
		})),
		more,
		nextOffset: window.offset + PAGE_SIZE
	};
}
