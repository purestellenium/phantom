import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { acknowledgeDelivery, ariConsole } from '$lib/server/ari-console';
import { recordAudit } from '$lib/server/audit';
import { requireCapability } from '$lib/server/auth/authorize';
import { runJob } from '$lib/server/jobs';
import { retryDelivery } from '$lib/server/projects/decisions';

/**
 * Phantom and Ari, side by side: the deliveries that did not apply, the ships
 * that never reached Ari, and what the last reconcile found. See
 * lib/server/ari-console.ts. `run_jobs`, like the outbox - it is the same
 * kind of operator's page, about the same kind of thing.
 */
export const load: PageServerLoad = async () => {
	requireCapability('run_jobs');
	return ariConsole();
};

/* The two jobs that settle most of what this page shows, by hand. */
const RUNNABLE = new Set(['ari.reconcile', 'ari.backfill']);

export const actions: Actions = {
	run: async ({ request }) => {
		const actor = requireCapability('run_jobs');
		const name = String((await request.formData()).get('job') ?? '');
		if (!RUNNABLE.has(name)) return fail(400, { error: 'That is not one of the Ari jobs.' });
		const outcome = await runJob(name, actor.id);
		if (!outcome.ok) return fail(409, { error: outcome.message });
		return { ran: name, status: outcome.run.status };
	},

	/* An ignored delivery run again, once whatever stopped it is fixed -
	   see retryDelivery. */
	retry: async ({ request }) => {
		const actor = requireCapability('run_jobs');
		const deliveryId = String((await request.formData()).get('deliveryId') ?? '');
		const result = await retryDelivery(deliveryId, actor.id);
		if (!result.ok) return fail(409, { error: result.error });
		return {
			retried: deliveryId,
			retryOutcome: result.outcome,
			retryDetail: result.detail
		};
	},

	/* An ignored delivery someone has read and dealt with. */
	acknowledge: async ({ request }) => {
		const actor = requireCapability('run_jobs');
		const deliveryId = String((await request.formData()).get('deliveryId') ?? '');
		if (!(await acknowledgeDelivery(deliveryId))) {
			return fail(400, { error: 'That delivery is not waiting to be acknowledged.' });
		}
		await recordAudit({
			action: 'ari.delivery_acknowledged',
			actorId: actor.id,
			metadata: { deliveryId }
		});
		return { acknowledged: deliveryId };
	}
};
