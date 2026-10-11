import { eq } from 'drizzle-orm';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { recordAudit } from '$lib/server/audit';
import { requireCapability } from '$lib/server/auth/authorize';
import { redirectUri } from '$lib/server/auth/origin';
import { db } from '$lib/server/db/client';
import { siteSettings } from '$lib/server/db/schema';
import {
	cronSecret,
	missingProviderVars,
	providerConfigured,
	slackConfigured
} from '$lib/server/env';
import { invalidateLaunchCache } from '$lib/server/launch';

/**
 * The switches, and a report on what this deployment is actually wired to.
 *
 * The second half is the configuration rule made visible: startup validates
 * required variables for enabled integrations and prints only enabled/disabled
 * state. Names and yes/no, never values - an operator needs to know Slack is
 * off and which variable turns it on, and nobody needs the token rendered into
 * a page.
 */

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` with no zone. This is the server's
 *  UTC rendering of the stored instant, which is what the field will then send
 *  back - the alternative is the browser's local zone, and a value that means a
 *  different moment depending on who opened the page. */
function forDateTimeInput(date: Date | null): string {
	if (!date) return '';
	return date.toISOString().slice(0, 16);
}

export const load: PageServerLoad = async () => {
	requireCapability('manage_settings');

	const [settings] = await db.select().from(siteSettings).limit(1);

	/* Printed rather than described, because these are the only values an
	   operator has to copy anywhere. They are derived from the request being
	   served, so what is on screen is exactly what this deployment will send - a
	   staging or preview host shows its own, and there is no variable that can
	   disagree with it. */
	const callbacks = await Promise.all([
		redirectUri('hca').then((uri) => ({ name: 'hca', uri })),
		redirectUri('hackatime').then((uri) => ({ name: 'hackatime', uri }))
	]);

	return {
		launched: settings?.launched ?? false,
		prelaunchMessage: settings?.prelaunchMessage ?? '',
		shopOpen: settings?.shopOpen ?? false,
		shopClosesAt: forDateTimeInput(settings?.shopClosesAt ?? null),
		shopClosedMessage: settings?.shopClosedMessage ?? '',
		updatedAt: settings?.updatedAt ?? null,
		callbacks,
		integrations: [
			{
				name: 'Hack Club auth',
				on: providerConfigured('hca'),
				missing: missingProviderVars('hca'),
				note: 'sign-in. without it nobody can get in at all.'
			},
			{
				name: 'hackatime',
				on: providerConfigured('hackatime'),
				missing: missingProviderVars('hackatime'),
				note: 'account linking, and eventually where hours come from.'
			},
			{
				name: 'slack',
				on: slackConfigured(),
				missing: ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'],
				note: 'order notifications. off means outbox rows wait as pending rather than failing.'
			},
			{
				name: 'job runner',
				on: cronSecret() !== null,
				missing: ['CRON_SECRET'],
				note: 'the scheduler endpoint. off means nothing runs on a schedule and the endpoint answers 404, the same as a wrong credential.'
			}
		]
	};
};

/** The singleton predicate, written once.
 *
 *  An UPDATE with no WHERE would work - the check constraint pins the table to
 *  one row - but it would also be an unqualified update on a settings table,
 *  which is the shape of statement that goes very wrong the day somebody
 *  relaxes the constraint. */
function eqSingleton() {
	return eq(siteSettings.id, 'singleton');
}

/**
 * The two switches, and the dates attached to them.
 *
 * Both write to the settings singleton and both invalidate the cache
 * immediately afterwards, because the fifteen-second TTL in $lib/server/launch.ts
 * is a good trade for readers and a terrible one for the person who just
 * flipped the switch and reloaded to check.
 *
 * They are two actions rather than one settings form because they are two
 * decisions made by different people at different moments - opening the site is
 * a launch, closing the shop is a Tuesday - and a single save button means
 * touching one of them re-writes the other.
 */
export const actions: Actions = {
	launch: async ({ request }) => {
		const actor = requireCapability('manage_settings');
		const form = await request.formData();

		const launched = form.get('launched') === 'on';
		const message = String(form.get('prelaunchMessage') ?? '').trim() || null;

		await db.transaction(async (tx) => {
			const [before] = await tx.select().from(siteSettings).limit(1);

			await tx
				.update(siteSettings)
				.set({ launched, prelaunchMessage: message, updatedAt: new Date(), updatedBy: actor.id })
				.where(eqSingleton());

			await recordAudit(
				{
					action: 'settings.launch',
					actorId: actor.id,
					/* The before and after, both. "Launched: true" on its own does not
					   say whether anything changed, and the question asked of this row
					   later is always "when did it open", which needs the transition and
					   not the state. */
					metadata: { from: before?.launched ?? null, to: launched }
				},
				tx
			);
		});

		await invalidateLaunchCache();
		redirect(303, '/admin/settings');
	},

	shop: async ({ request }) => {
		const actor = requireCapability('manage_settings');
		const form = await request.formData();

		const shopOpen = form.get('shopOpen') === 'on';
		const raw = String(form.get('shopClosesAt') ?? '').trim();
		const message = String(form.get('shopClosedMessage') ?? '').trim() || null;

		let closesAt: Date | null = null;
		if (raw) {
			const parsed = new Date(raw);
			/* An unparseable date must not become null. Null means "no deadline",
			   which is the opposite of what somebody typing a date into this field
			   wants, and silently opening the shop forever because of a typo is the
			   worst available outcome. */
			if (Number.isNaN(parsed.getTime())) {
				return fail(400, { error: 'That closing date could not be read.' });
			}
			closesAt = parsed;
		}

		await db.transaction(async (tx) => {
			const [before] = await tx.select().from(siteSettings).limit(1);

			await tx
				.update(siteSettings)
				.set({
					shopOpen,
					shopClosesAt: closesAt,
					shopClosedMessage: message,
					updatedAt: new Date(),
					updatedBy: actor.id
				})
				.where(eqSingleton());

			await recordAudit(
				{
					action: 'settings.shop_window',
					actorId: actor.id,
					metadata: {
						openFrom: before?.shopOpen ?? null,
						openTo: shopOpen,
						closesAtFrom: before?.shopClosesAt?.toISOString() ?? null,
						closesAtTo: closesAt?.toISOString() ?? null
					}
				},
				tx
			);
		});

		await invalidateLaunchCache();
		redirect(303, '/admin/settings');
	}
};
