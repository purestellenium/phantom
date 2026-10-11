import { FLOW_STEP, flowValues, type FlowValues } from '$lib/project-flow';
import { isProjectKind, type ProjectDraft } from '$lib/server/projects/projects';

/**
 * What the new-project flow posts, read and checked once for both places it
 * posts to - the projects page's create and onboarding's finish. Two copies
 * of these rules were two chances for one to accept what the other refused.
 *
 * A refusal says which screen its problem is on, and carries everything that
 * was typed back so the flow reopens there with it all in place.
 */
export type FlowRead =
	| { ok: true; draft: ProjectDraft; values: FlowValues }
	| { ok: false; error: string; step: number; values: FlowValues };

function trimmed(form: FormData, key: string): string | null {
	const value = form.get(key);
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readFlow(form: FormData): FlowRead {
	const values = flowValues(form);
	const kind = form.get('kind');
	const description = trimmed(form, 'description');
	const name = trimmed(form, 'name');

	if (!isProjectKind(kind)) {
		return { ok: false, error: 'Pick software or hardware.', step: FLOW_STEP.kind, values };
	}
	if (!description) {
		return { ok: false, error: 'Tell us what you want to make.', step: FLOW_STEP.idea, values };
	}
	if (!name) {
		return { ok: false, error: 'Give your project a name.', step: FLOW_STEP.name, values };
	}

	return {
		ok: true,
		values,
		draft: {
			name,
			kind,
			description,
			repoUrl: trimmed(form, 'repo_url'),
			demoUrl: trimmed(form, 'demo_url'),
			screenshotUrl: null,
			hackatimeProjects: trimmed(form, 'hackatime_projects'),
			aiDeclaration: null,
			updateDeclaration: null,
			notesForReviewer: null
		}
	};
}

/** Where createProject's own refusal belongs. Everything above is checked
 *  first, so what it can still refuse is a Hackatime project another of
 *  theirs already claims - picked on the links screen. */
export const PROJECT_ERROR_STEP = FLOW_STEP.links;
