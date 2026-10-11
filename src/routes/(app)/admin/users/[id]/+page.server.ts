import { and, eq } from 'drizzle-orm';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { ledgerEntriesToLog } from '$lib/server/log';
import { peopleById } from '$lib/server/people';

import { recordAudit } from '$lib/server/audit';
import {
	CAPABILITY_LABELS,
	assignableRoles,
	can,
	canActOn,
	canGrant,
	requireCapability
} from '$lib/server/auth/authorize';
import { listActiveSessions, revokeAllSessions } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import {
	capability as capabilityEnum,
	ledgerAccounts,
	userRole,
	users,
	type Capability
} from '$lib/server/db/schema';
import { adjust, cachedBalance, entriesFor, replayBalance } from '$lib/server/ledger';
import { projectRowsForUser } from '$lib/server/projects/projects';
import { ordersFor } from '$lib/server/shop/orders';
import { isUuid } from '$lib/uuid';

/**
 * One person: what they are, what they can do, what they have, and what they
 * have bought.
 *
 * The balance is shown twice on purpose - the cached number and a live replay
 * of the entries - because this is the page an operator is on when somebody has
 * written in to say their balance is wrong. Seeing the two agree answers the
 * question immediately; seeing them disagree is a finding, and the same one
 * $lib/server/reconcile.ts reports on a schedule.
 *
 * Every form here is drawn only if the reader can use it, and every one of them
 * is re-authorised in the action. The forms are a courtesy; the actions are the
 * rule.
 */
/** How many of someone's projects the panel draws before handing off to the
 *  full list. Twenty covers every real account; the point of the bound is the
 *  account that is not real. */
const PROJECTS_SHOWN = 20;

export const load: PageServerLoad = async ({ params }) => {
	const actor = requireCapability('manage_users');

	const subject = await subjectOf(params.id);
	if (!subject) error(404);

	const [account] = await db
		.select()
		.from(ledgerAccounts)
		.where(and(eq(ledgerAccounts.userId, subject.id), eq(ledgerAccounts.currency, 'seconds')))
		.limit(1);

	const [cached, replayed, entries, orders, sessions, projects] = await Promise.all([
		cachedBalance(subject.id),
		account ? replayBalance(account.id) : Promise.resolve(0),
		entriesFor(subject.id, 25),
		ordersFor(subject.id),
		listActiveSessions(subject.id),
		/* Drafts included, and that is the point: what somebody has STARTED is as
		   much a part of answering "who is this" as what they have shipped, and a
		   never-shipped project appears on no other operator screen. */
		projectRowsForUser(subject.id, PROJECTS_SHOWN + 1)
	]);

	/* One more was asked for than is drawn - the same trick lib/paging.ts uses -
	   so the panel knows there is a remainder without a second count query. The
	   remainder links to the full list filtered to this person rather than
	   growing the panel. */
	const moreProjects = projects.length > PROJECTS_SHOWN;

	const acting = canActOn(actor, subject);

	/* Which role options this actor may set. The same call the action makes,
	   rather than a second copy of the arithmetic and a second rank table - the
	   form must not offer what the action will refuse. */
	const roles = assignableRoles(actor);

	const people = await peopleById(entries.map((e) => e.actorId));
	const log = ledgerEntriesToLog(entries, people);

	return {
		log,
		subject: {
			id: subject.id,
			displayName: subject.displayName,
			email: subject.email,
			role: subject.role,
			verificationStatus: subject.verificationStatus,
			eligibility: subject.eligibility,
			eligibilityRule: subject.eligibilityRule,
			eligibilityAt: subject.eligibilityAt,
			hcaSubject: subject.hcaSubject,
			slackId: subject.slackId,
			slackUsername: subject.slackUsername,
			createdAt: subject.createdAt,
			lastSeenAt: subject.lastSeenAt,
			capabilityCount: subject.capabilities.length,
			shopLocked: subject.shopLocked
		},
		acting,
		cached,
		replayed,
		orders,
		projects: projects.slice(0, PROJECTS_SHOWN),
		moreProjects,
		sessions,
		canAdjust: can(actor, 'adjust_ledger'),
		roles,
		selectedRole: roles.includes(subject.role) ? subject.role : roles[0],
		capabilities: capabilityEnum.enumValues.map((action) => ({
			name: action,
			label: CAPABILITY_LABELS[action],
			held: subject.capabilities.includes(action),
			mayTouch: canGrant(actor, action)
		}))
	};
};

/** The subject, read fresh. Never the row the page rendered from - a role that
 *  changed in between is exactly the case the rank check exists for. */
async function subjectOf(userId: string) {
	if (!isUuid(userId)) return null;
	const [subject] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	return subject ?? null;
}

/**
 * Changing what someone is and what they can do.
 *
 * These are the most dangerous mutations in the application - one of them
 * hands out the ability to read other people's addresses, another mints
 * currency - so every one of them re-derives the whole authorization decision
 * from the database rather than trusting anything the form said.
 *
 * The three refusals in `canActOn` are the interesting part and the reasoning
 * is written out there: no self-edits, no acting on an equal or higher rank, and
 * no granting a capability you do not hold yourself. Without the last one, every
 * admin has every capability one indirection away and the explicit-only list
 * means nothing.
 */
export const actions: Actions = {
	role: async ({ params, request }) => {
		const actor = requireCapability('manage_users');
		const form = await request.formData();
		const submittedRole = String(form.get('role') ?? '');

		const subject = await subjectOf(params.id);
		if (!subject) redirect(303, '/admin/users');

		/* The enum is the allowlist. A string from a form must never reach a
		   column typed as an enum without something having checked it belongs
		   there - Postgres would refuse it, but as a 500 rather than as a
		   sentence. */
		const role = userRole.enumValues.find((known) => known === submittedRole);
		if (role === undefined) return fail(400, { error: `${submittedRole} is not a role.` });

		const allowed = canActOn(actor, subject);
		if (!allowed.ok) return fail(403, { error: allowed.reason });

		/* Promoting to a rank at or above your own is the same escalation as
		   editing yourself, taking one extra step. An admin cannot make another
		   admin; an owner may appoint both, which is what the rank above admin is
		   for. */
		if (!assignableRoles(actor).includes(role)) {
			return fail(403, { error: 'You cannot promote anyone to that rank.' });
		}

		await db.transaction(async (tx) => {
			await tx.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, subject.id));

			await recordAudit(
				{
					action: 'role.changed',
					actorId: actor.id,
					subjectId: subject.id,
					metadata: { from: subject.role, to: role }
				},
				tx
			);
		});

		redirect(303, `/admin/users/${subject.id}`);
	},

	/**
	 * Replace someone's granted capabilities with exactly what was ticked.
	 *
	 * A whole-set write rather than a grant/revoke pair, because two operations
	 * mean an ordering question - and because the form shows the complete
	 * picture, so what was submitted IS the intent. What it must not do is let an
	 * operator clear a capability they cannot themselves grant: that would be a
	 * way to strip `view_pii` from a colleague without holding it.
	 *
	 * So the new set is: everything the subject holds that the actor cannot
	 * touch, plus everything the actor ticked and is allowed to touch.
	 */
	capabilities: async ({ params, request }) => {
		const actor = requireCapability('manage_users');
		const form = await request.formData();

		const subject = await subjectOf(params.id);
		if (!subject) redirect(303, '/admin/users');

		const allowed = canActOn(actor, subject);
		if (!allowed.ok) return fail(403, { error: allowed.reason });

		const ticked = new Set(
			form.getAll('capability').filter((value): value is string => typeof value === 'string')
		);

		const next: Capability[] = [];
		for (const action of capabilityEnum.enumValues) {
			const held = subject.capabilities.includes(action);
			if (!canGrant(actor, action)) {
				/* Untouchable by this actor: preserved exactly as it was, whether or
				   not the form mentioned it. */
				if (held) next.push(action);
				continue;
			}
			if (ticked.has(action)) next.push(action);
		}

		const added = next.filter((action) => !subject.capabilities.includes(action));
		const removed = subject.capabilities.filter((action) => !next.includes(action));

		if (added.length === 0 && removed.length === 0) return { notice: 'Nothing changed.' };

		await db.transaction(async (tx) => {
			await tx
				.update(users)
				.set({ capabilities: next, updatedAt: new Date() })
				.where(eq(users.id, subject.id));

			await recordAudit(
				{
					action: 'capabilities.changed',
					actorId: actor.id,
					subjectId: subject.id,
					metadata: { added, removed, result: next }
				},
				tx
			);
		});

		redirect(303, `/admin/users/${subject.id}`);
	},

	/**
	 * Move a balance by hand.
	 *
	 * `adjust_ledger`, which no role implies. The reason is required and is
	 * stored on the entry: this is the one path that creates value out of
	 * nothing, and an entry that cannot say why it exists is one nobody can
	 * audit.
	 *
	 * The idempotency key is a fresh uuid per submission rather than derived from
	 * the inputs, and that is deliberate: two identical corrections on the same
	 * day are two real corrections, and collapsing them would silently discard
	 * the second. Double-submit protection here is the redirect after it, and the
	 * cost of getting it wrong is one visible, reversible entry rather than a
	 * lost one.
	 */
	adjust: async ({ params, request }) => {
		const actor = requireCapability('adjust_ledger');
		const form = await request.formData();

		/* Typed in minutes, stored in seconds: the ledger's unit is the second,
		   but nobody grants 5400 of anything by hand. */
		const minutes = Number(form.get('minutes') ?? 0);
		const amount = minutes * 60;
		const reason = String(form.get('reason') ?? '').trim();

		const subject = await subjectOf(params.id);
		if (!subject) redirect(303, '/admin/users');

		/* The same subject check every other action here makes. `adjust_ledger`
		   is the one capability that mints currency, and without this an operator
		   could post it to their own id - the exact escalation `canActOn` exists
		   to stop. */
		const allowed = canActOn(actor, subject);
		if (!allowed.ok) return fail(403, { error: allowed.reason });

		/* Integer AND in range. `Number.isInteger(5e18)` is true, and two of
		   those put `sum(amount)` past what `::bigint` can hold in replayBalance -
		   at which point the account cannot be read, cannot be spent, and cannot
		   be corrected, because posting the reversing entry replays the balance
		   first. An irreversible state is worse than a refused form. */
		const LIMIT = 1_000_000_000; // seconds; ~31 years, far past any real grant
		if (!Number.isInteger(minutes) || minutes === 0) {
			return fail(400, { error: 'The amount must be a whole number of minutes, and not zero.' });
		}
		if (Math.abs(amount) > LIMIT) {
			return fail(400, { error: `An adjustment cannot be larger than ${LIMIT / 60} minutes.` });
		}
		if (!reason) return fail(400, { error: 'An adjustment needs a reason.' });

		await db.transaction(async (tx) => {
			const posted = await adjust(
				{
					userId: subject.id,
					amount,
					reason,
					idempotencyKey: `adjust:${crypto.randomUUID()}`,
					actorId: actor.id
				},
				tx
			);

			await recordAudit(
				{
					action: 'ledger.adjusted',
					actorId: actor.id,
					subjectId: subject.id,
					metadata: { amount, reason, entryId: posted.entry.id, balanceAfter: posted.balance }
				},
				tx
			);
		});

		redirect(303, `/admin/users/${subject.id}`);
	},

	/**
	 * End every session this person has.
	 *
	 * It does not disable the account - the next sign-in works - because locking
	 * someone out is a different decision with different evidence behind it, and
	 * conflating the two means the mild action is unavailable when it is the
	 * right one.
	 */
	/**
	 * Hold someone to the event in the shop - the invite and the flight
	 * stipend only - or let them go. See $lib/shop/locked.ts. The checkbox is
	 * the whole intent: ticked locks, unticked unlocks.
	 */
	shopLock: async ({ params, request }) => {
		const actor = requireCapability('manage_users');
		const locked = (await request.formData()).get('shop_locked') === 'on';

		const subject = await subjectOf(params.id);
		if (!subject) redirect(303, '/admin/users');

		const allowed = canActOn(actor, subject);
		if (!allowed.ok) return fail(403, { error: allowed.reason });

		if (subject.shopLocked !== locked) {
			await db.transaction(async (tx) => {
				await tx
					.update(users)
					.set({ shopLocked: locked, updatedAt: new Date() })
					.where(eq(users.id, subject.id));

				await recordAudit(
					{
						action: locked ? 'shop.locked' : 'shop.unlocked',
						actorId: actor.id,
						subjectId: subject.id,
						metadata: { shopLocked: locked }
					},
					tx
				);
			});
		}

		redirect(303, `/admin/users/${subject.id}`);
	},

	sessions: async ({ params }) => {
		const actor = requireCapability('manage_users');

		const subject = await subjectOf(params.id);
		if (!subject) redirect(303, '/admin/users');

		const allowed = canActOn(actor, subject);
		if (!allowed.ok) return fail(403, { error: allowed.reason });

		await db.transaction(async (tx) => {
			const revoked = await revokeAllSessions(subject.id, tx);

			await recordAudit(
				{
					action: 'session.revoked_by_operator',
					actorId: actor.id,
					subjectId: subject.id,
					metadata: { revoked }
				},
				tx
			);
		});

		redirect(303, `/admin/users/${subject.id}`);
	}
};
