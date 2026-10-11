import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordAudit } from '$lib/server/audit';
import { requireCapability } from '$lib/server/auth/authorize';
import { knownEffects } from '$lib/server/effects';
import { slackConfigured } from '$lib/server/env';
import {
	dismissEvent,
	outboxCounts,
	recentEvents,
	resolveAmbiguous,
	retryEvent
} from '$lib/server/outbox';

/**
 * What the application owes the outside world.
 *
 * The ambiguous rows are the reason this page exists. Everything else here is
 * legible from a count - pending will go out, delivered went out, failed will
 * not - but an ambiguous row is a question only a person can answer, by going
 * and looking at the far end, and it will sit here until somebody does. That is
 * correct behaviour and the page says so rather than offering a retry button
 * that would quietly duplicate the effect.
 */
export const load: PageServerLoad = async () => {
	requireCapability('run_jobs');

	const [events, counts] = await Promise.all([recentEvents(100), outboxCounts()]);

	return {
		events,
		counts,
		effects: knownEffects(),
		slack: slackConfigured()
	};
};

/**
 * The two things an operator can do to an outbox row, and the one they cannot.
 *
 * They cannot retry an ambiguous row. `retryEvent` refuses the state outright,
 * and that refusal is the whole reason the state exists: ambiguous means the
 * call went out and we do not know whether it landed, so firing again may
 * duplicate an effect that has already happened.
 *
 * What they can do instead is establish what happened at the far end and record
 * it - `resolveAmbiguous`, which needs the remote identifier as evidence for a
 * delivered verdict. A claim that it landed with nothing to point at is a guess
 * wearing a resolution.
 */
export const actions: Actions = {
	retry: async ({ request }) => {
		const actor = requireCapability('run_jobs');
		const form = await request.formData();
		const id = String(form.get('eventId') ?? '');

		const done = await retryEvent(id);
		if (!done) {
			return fail(400, {
				error:
					'That row could not be requeued. Ambiguous rows are refused on purpose - establish what happened at the far end and resolve it instead.'
			});
		}

		await recordAudit({ action: 'outbox.retried', actorId: actor.id, metadata: { eventId: id } });

		redirect(303, '/admin/outbox');
	},

	resolve: async ({ request }) => {
		const actor = requireCapability('run_jobs');
		const form = await request.formData();

		const id = String(form.get('eventId') ?? '');
		const delivered = form.get('verdict') === 'delivered';
		const remoteId = String(form.get('remoteId') ?? '').trim();
		const note = String(form.get('note') ?? '').trim();

		if (delivered && !remoteId) {
			return fail(400, {
				error:
					'Marking a row delivered needs the remote identifier - the Slack message timestamp, the remote record id. Evidence, not a conclusion.'
			});
		}
		if (!delivered && !note) {
			return fail(400, { error: 'Reopening a row needs a note saying what you found.' });
		}

		const done = await resolveAmbiguous(
			id,
			delivered ? { delivered: true, remoteId } : { delivered: false, note }
		);

		if (!done) return fail(400, { error: 'That row is no longer ambiguous.' });

		await recordAudit({
			action: 'outbox.resolved',
			actorId: actor.id,
			metadata: { eventId: id, delivered, remoteId: remoteId || null, note: note || null }
		});

		redirect(303, '/admin/outbox');
	},

	/* An effect that cannot happen - see dismissEvent. The reason is required,
	   since the row stops asking for attention and this is what the next
	   person reading it has to go on. */
	dismiss: async ({ request }) => {
		const actor = requireCapability('run_jobs');
		const form = await request.formData();
		const id = String(form.get('eventId') ?? '');
		const note = String(form.get('note') ?? '').trim();

		if (!note) {
			return fail(400, { error: 'Dismissing a row needs a note saying why it cannot happen.' });
		}
		if (!(await dismissEvent(id, note))) {
			return fail(400, {
				error: 'That row cannot be dismissed - it may have been delivered or already dismissed.'
			});
		}

		await recordAudit({
			action: 'outbox.dismissed',
			actorId: actor.id,
			metadata: { eventId: id, note }
		});

		redirect(303, '/admin/outbox');
	}
};
