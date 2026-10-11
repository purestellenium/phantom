/**
 * The new-project flow's screens, in order - shared by the flow itself
 * (ProjectSteps.svelte) and by the two actions that receive it: creating a
 * project from the projects page, and the first one at the end of onboarding.
 *
 * A refusal names the screen its problem is on by number, so the flow can put
 * the person back there. With the numbers written out in three files they
 * drifted the moment one list changed; here there is one list.
 */
export const FLOW_STEPS = ['kind', 'idea', 'name', 'links', 'review'] as const;

export const FLOW_STEP = {
	kind: 0,
	idea: 1,
	name: 2,
	links: 3,
	review: 4
} as const satisfies Record<(typeof FLOW_STEPS)[number], number>;

/** What a refusal hands back, so the flow reopens with every word in place. */
export type FlowValues = {
	kind: string;
	name: string;
	description: string;
	repoUrl: string;
	demoUrl: string;
	hackatimeProjects: string;
};

export function flowValues(form: FormData): FlowValues {
	return {
		kind: String(form.get('kind') ?? ''),
		name: String(form.get('name') ?? ''),
		description: String(form.get('description') ?? ''),
		repoUrl: String(form.get('repo_url') ?? ''),
		demoUrl: String(form.get('demo_url') ?? ''),
		hackatimeProjects: String(form.get('hackatime_projects') ?? '')
	};
}
