import { and, eq } from 'drizzle-orm';

import type { SessionUser } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import { projectShowcase, projectUpvotes, projects } from '$lib/server/db/schema';

/**
 * Upvotes on explore.
 *
 * One per person per project - the table's primary key - so a double-click,
 * a retried request or two tabs vote once, and taking a vote back deletes the
 * row. Only a project on explore can be upvoted (one with an approved ship),
 * and never by its owner: an upvote is somebody else liking the thing.
 */

export type UpvoteResult = { ok: true; upvoted: boolean } | { ok: false; error: string };

export async function setUpvote(input: {
	user: SessionUser;
	projectNumber: number;
	up: boolean;
}): Promise<UpvoteResult> {
	const [project] = await db
		.select({ id: projects.id, userId: projects.userId })
		.from(projects)
		.innerJoin(projectShowcase, eq(projectShowcase.projectId, projects.id))
		.where(eq(projects.number, input.projectNumber))
		.limit(1);
	if (!project) return { ok: false, error: 'That project is not on explore.' };
	if (project.userId === input.user.id) {
		return { ok: false, error: 'You cannot upvote your own project.' };
	}

	if (input.up) {
		await db
			.insert(projectUpvotes)
			.values({ projectId: project.id, userId: input.user.id })
			.onConflictDoNothing();
	} else {
		await db
			.delete(projectUpvotes)
			.where(
				and(eq(projectUpvotes.projectId, project.id), eq(projectUpvotes.userId, input.user.id))
			);
	}
	return { ok: true, upvoted: input.up };
}

/** Whether this person has upvoted this project. */
export async function hasUpvoted(userId: string, projectId: string): Promise<boolean> {
	const [row] = await db
		.select({ userId: projectUpvotes.userId })
		.from(projectUpvotes)
		.where(and(eq(projectUpvotes.projectId, projectId), eq(projectUpvotes.userId, userId)))
		.limit(1);
	return row !== undefined;
}
