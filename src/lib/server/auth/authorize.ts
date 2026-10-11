import { error } from '@sveltejs/kit';

import { RANK, can, canAny, mayActOnSelf } from '$lib/server/auth/capabilities';
import { requireUser, type SessionUser } from '$lib/server/auth/session';
import type { Capability } from '$lib/server/db/schema';

/**
 * Applying the capability policy to a request.
 *
 * The policy itself - which role implies what, which capabilities may never be
 * implied, how ranks compare - is in lib/auth/capabilities.ts, which is pure and
 * importable from anywhere including a CLI. This module is the half that needs a
 * session and can refuse a page, and it lives under $lib/server for that reason.
 *
 * There is one rule here and everything else is its consequence: A CAPABILITY IS
 * CHECKED AT THE MUTATION. Not at the page that renders the button, not at the
 * nav that offers the link, not by a middleware matching a path prefix. Those
 * are all worth doing and none of them is the check - a form action is a POST
 * endpoint reachable by anything that can find its name, and a form that was
 * never rendered is not a form that cannot be submitted.
 *
 * The wiki's phrasing is "authorization must be enforced on the mutation, not
 * only queue membership or a hidden button", and the reason is practical
 * rather than a principle: when each route carries its own guards, which
 * checks apply depends on which file someone last edited.
 */

/* Re-exported so a call site needs one import rather than two, and so
   `capabilities.ts` stays the only place any of it is defined. */
export {
	BOOTSTRAP_CAPABILITIES,
	CAPABILITY_LABELS,
	CONSOLE_CAPABILITIES,
	EXPLICIT_ONLY,
	ROLE_CAPABILITIES,
	assignableRoles,
	can,
	canAny,
	capabilitiesOf,
	isOperator,
	mayActOnSelf,
	type Principal
} from '$lib/server/auth/capabilities';

/* ── enforcing ───────────────────────────────────────────────────────────── */

/**
 * The signed-in user, insisting they may do this.
 *
 * Not found, not forbidden. A 403 confirms the route exists and that the only
 * thing in the way is a permission, so a participant walking a wordlist against
 * /admin gets a map of the operator surface back. A refusal now answers the
 * same way a path that was never routed does.
 *
 * The cost is that a missing capability reads as a broken link. That
 * distinction lives in the server log, which is ours and not theirs.
 *
 * `requireUser` has already handled the anonymous case, and it redirects -
 * identically for every path, so it is not an oracle.
 */
export function requireCapability(action: Capability): SessionUser {
	const user = requireUser();
	if (!can(user, action)) error(404);
	return user;
}

/** The same for a surface several capabilities can reach. The page is then
 *  responsible for showing only the sections the holder can actually use - and
 *  each of those sections' mutations does its own `requireCapability`. */
export function requireAnyCapability(actions: readonly Capability[]): SessionUser {
	const user = requireUser();
	if (!canAny(user, actions)) error(404);
	return user;
}

/**
 * Refuse from a server route rather than a page.
 *
 * Server routes return responses; they cannot throw a navigation. One body,
 * one status, no reason - for the same reason `requireCapability` returns not
 * found: a handler that answers "unauthorized" to a bad credential and
 * "forbidden" to a good one with the wrong scope has told an attacker which of
 * the two they got wrong, and a handler that answers 503 when it is
 * misconfigured has told them the endpoint is real and worth coming back to.
 *
 * Everything a caller might legitimately need to know about a refusal is in the
 * server log.
 */
export function refuse(): Response {
	return new Response('Not Found', {
		status: 404,
		headers: { 'cache-control': 'no-store' }
	});
}

/* ── acting on other operators ───────────────────────────────────────────── */

export type ActionRefusal = { ok: false; reason: string };
export type ActionAllowed = { ok: true };

/**
 * Whether an operator may change another user's role or capabilities.
 *
 * Three refusals, and each one is a documented failure mode rather than
 * defensive programming:
 *
 * SELF. Nobody edits their own authority. Without this, `manage_users` is every
 * capability - an admin grants themselves `adjust_ledger` and the separation the
 * whole subsystem is built on evaporates in one click. The escape hatch is
 * another operator, or ADMIN_HCA_SUBJECTS and a sign-in, which is deliberately
 * inconvenient and deliberately audited.
 *
 * EQUAL OR HIGHER RANK. An admin cannot demote, promote or re-scope another
 * admin. Hackatime's rule, and it stops the "two admins fall out" scenario where
 * whoever clicks first wins.
 *
 * GRANTING WHAT YOU LACK. You cannot hand out a capability you do not hold. An
 * admin without `view_pii` cannot create an assistant who has it, which is what
 * makes the explicit-only list mean anything at all - otherwise every admin has
 * every capability, one indirection away.
 */
export function canActOn(
	actor: SessionUser,
	subject: Pick<SessionUser, 'id' | 'role'>
): ActionRefusal | ActionAllowed {
	if (!can(actor, 'manage_users')) {
		return { ok: false, reason: 'You cannot manage users.' };
	}
	if (actor.id === subject.id) {
		/* The owner exception, and it has to short-circuit the rank check below as
		   well as this one - an owner acting on themselves is acting on an equal
		   rank by definition, so reaching that check would refuse them twice. See
		   mayActOnSelf for what it is for and why it stops at owner. */
		return mayActOnSelf(actor)
			? { ok: true }
			: {
					ok: false,
					reason: 'You cannot change your own role or capabilities. Ask another operator.'
				};
	}
	if (RANK[subject.role] >= RANK[actor.role]) {
		return {
			ok: false,
			reason: `You cannot act on ${
				subject.role === actor.role
					? 'an operator of your own rank'
					: 'an operator ranked above you'
			}.`
		};
	}
	return { ok: true };
}

/** Whether this actor may grant or revoke this specific capability. Separate
 *  from `canActOn` because the subject check and the capability check refuse for
 *  different reasons and the operator should be told which. */
export function canGrant(actor: SessionUser, action: Capability): boolean {
	return can(actor, 'manage_users') && can(actor, action);
}
