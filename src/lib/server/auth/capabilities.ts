/* Relative on purpose: the seed script runs this under bun, outside the
   SvelteKit build, where the $lib alias only resolves through the generated
   tsconfig. A path that needs no alias needs no generated file. */
import { capability, userRole } from '../db/schema';
import type { Capability, UserRole } from '../db/schema';

/**
 * Who may do what, as pure data and pure functions.
 *
 * Split from lib/auth/authorize.ts, which is the same policy applied to a
 * request - that module lives under $lib/server because it reads the session
 * and can throw a redirect, and SvelteKit refuses to bundle it anywhere else.
 * Which means the seed script could not ask what a bootstrap admin should hold,
 * and the policy would have had to be written down a second time somewhere a
 * CLI could reach. Two copies of an authorization table is exactly the shape of
 * bug this whole subsystem exists to avoid.
 *
 * So: the decisions live here, with no I/O and no framework, and the
 * enforcement lives next door. Nothing in this file can reach a database, a
 * cookie or a secret, which is also what makes it the part worth testing.
 */

/**
 * The base set for each role, before anything is granted individually.
 *
 * The absences are the design. An `admin` cannot read a shipping address, mint
 * currency, act on a fraud case, or move real money - not because those are
 * unimplemented but because becoming an admin should not silently confer them.
 * Sidekick separates viewing an order from revealing its address, Fallout
 * reserves HCB mutations for a role that cannot be assigned through the admin
 * UI at all, and Stasis keeps attendance out of general admin. Same idea: the
 * dangerous capabilities are granted to a person, by a person, and the grant is
 * an audit row.
 *
 * A total Record over the role enum, so adding a role is a type error here
 * until someone decides what it may do. That is the right moment to decide it.
 */
export const ROLE_CAPABILITIES = {
	participant: [],

	/* Reviewing itself happens on Ari now. What the role still gives here is a
     look at other people's project pages and their history's internal side;
     it does not imply the catalog's internals or the audit log, because a
     reviewer is a volunteer rather than an operator with a console. */
	reviewer: ['review_submissions'],

	/* Everything, the same as an owner. The one difference is rank, not a
	   capability: `assignableRoles` caps an admin at appointing reviewers and
	   `canActOn` refuses them a subject of equal or higher rank, so an admin
	   can mint hours, read an address, place a hold, change every setting and
	   grant a reviewer anything - and cannot make another admin. */
	admin: capability.enumValues,

	/* Everything, read off the enum rather than listed, so it cannot drift: a
     capability added to the schema is held by an owner from the moment it
     exists. Writing the list out again here would mean a new capability was
     silently withheld from the only role whose definition is holding all of
     them, and nothing would say so.

     Owner and admin are the two roles permitted to imply the explicit-only
     three, and the check below is narrowed to allow exactly them. */
	owner: capability.enumValues
} satisfies Record<UserRole, readonly Capability[]>;

/**
 * Capabilities that may never be implied by a role and must be granted to a
 * named person.
 *
 * Enforced rather than merely documented: the loop below runs at module load,
 * so a later edit that quietly adds `adjust_ledger` to the admin base set fails
 * on import instead of shipping.
 */
export const EXPLICIT_ONLY: readonly Capability[] = ['view_pii', 'adjust_ledger', 'manage_fraud'];

for (const [role, granted] of Object.entries(ROLE_CAPABILITIES)) {
	/* Owner is exempt, and is the only exemption there should ever be.
     What this rule protects is a specific sentence - becoming an ADMIN does not
     confer reading an address or moving money - and owner is the rank whose
     entire definition is holding everything. Conferring it is still a named
     person saying so, in an audit row, which is what the rule is actually
     asking for.

     The alternative was worse in a way worth recording: with owner capped at
     the admin base set, promoting somebody to owner would have had to be
     followed by a separate grant of the three, and `canActOn` refuses an equal
     rank - so the moment the promotion landed, the promoter could no longer
     grant them anything. Correct only if performed in the right order, silently
     broken in the other, which is not a rule anyone should have to remember. */
	if (role === 'owner' || role === 'admin') continue;

	for (const action of granted) {
		if (EXPLICIT_ONLY.includes(action)) {
			throw new Error(
				`Role ${role} implies ${action}, which is on the explicit-only list. ` +
					'Grant it to a person, or take it off the list - but it cannot be both.'
			);
		}
	}
}

/**
 * The capability set an ADMIN_HCA_SUBJECTS bootstrap admin starts with.
 *
 * The break-glass path, and the answer to "who grants the first grant". Without
 * it the explicit-only list is unreachable: no operator holds `adjust_ledger`,
 * `canGrant` refuses everyone, and the first ledger correction needs a psql
 * session. With it, the people named in the environment at deploy time hold
 * everything the application implements, and everyone else is granted upward by
 * name.
 *
 * `manage_fraud` and `fulfil_orders` are absent because the admin and owner
 * roles already imply every capability; this list only matters for what a
 * person keeps if their role is later lowered, and a fraud hold is not that.
 */
export const BOOTSTRAP_CAPABILITIES: readonly Capability[] = [
	'manage_users',
	'manage_catalog',
	'manage_orders',
	'manage_settings',
	'view_audit',
	'run_jobs',
	'view_pii',
	'adjust_ledger'
];

/**
 * A capability list as a Postgres array literal, for the two places that need
 * to union it into the column in SQL.
 *
 * It exists because Drizzle's `sql` template expands a JS array into a tuple of
 * parameters - which is right for `in (...)` and wrong here, where one array
 * value is wanted. Passing the literal as a single text parameter and casting it
 * is the fix, and doing it in one function means the sign-in callback and the
 * seed script cannot diverge on the encoding.
 *
 * Safe by construction rather than by escaping: every element is a member of a
 * Postgres enum whose labels are lowercase identifiers, so none of them can
 * contain a comma, a quote or a brace. Nothing here comes from user input.
 */
export function capabilityArrayLiteral(actions: readonly Capability[]): string {
	return `{${actions.join(',')}}`;
}

/** The capabilities that put something on the console. `review_submissions` is
 *  absent because reviewing is not a console page - it happens on Ari - and a
 *  volunteer who can only review has nothing here. */
export const CONSOLE_CAPABILITIES: readonly Capability[] = [
	'manage_users',
	'manage_catalog',
	'manage_orders',
	'manage_settings',
	'view_audit',
	'run_jobs',
	'view_pii',
	'adjust_ledger'
];

/**
 * Rank, for the one question that needs one: may this person change that
 * person.
 *
 * Deliberately a table rather than the enum's own ordering. The wiki is
 * explicit - "never compare historical enum integers as privilege rank unless
 * that is the declared contract" - and a Postgres enum's ordinal is an
 * implementation detail an ALTER TYPE can renumber.
 */
export const RANK = {
	participant: 0,
	reviewer: 1,
	admin: 2,
	owner: 3
} satisfies Record<UserRole, number>;

/** The narrowest thing that answers "may they". Taking a whole user row would
 *  invite call sites to pass something assembled from a token claim or a
 *  header, which is how a role acquires a second source of truth. */
export type Principal = { role: UserRole; capabilities: Capability[] };

/** Everything this user may do: the role's base set plus their own grants. */
export function capabilitiesOf(user: Principal): Set<Capability> {
	return new Set<Capability>([...ROLE_CAPABILITIES[user.role], ...user.capabilities]);
}

/** Whether a user may perform an action. The one predicate; there is no
 *  `isAdmin` anywhere in this codebase and there should not be one. */
export function can(user: Principal | null, action: Capability): boolean {
	if (!user) return false;
	return capabilitiesOf(user).has(action);
}

/** Whether a user may do ANY of these. For a console page that lists several
 *  sections and should be reachable if one of them is. */
export function canAny(user: Principal | null, actions: readonly Capability[]): boolean {
	return actions.some((action) => can(user, action));
}

/**
 * Whether this user has any operator business at all.
 *
 * Derived from the capability set rather than from `role !== "participant"`, so
 * a participant granted `view_pii` for a fulfilment shift reaches the console
 * and a reviewer with only a queue does not. It decides one thing - whether the
 * console link appears - and no mutation depends on it.
 */
export function isOperator(user: Principal | null): boolean {
	return canAny(user, CONSOLE_CAPABILITIES);
}

/**
 * Whether this person may act on THEMSELVES - edit their own authority, move
 * their own balance, review their own project.
 *
 * Owner only, and it is a hole rather than a principle. Everything else in this
 * subsystem exists to keep the two halves of a decision in different hands:
 * `canActOn` refuses a self-edit because otherwise `manage_users` is every
 * capability one click away, and review.ts refuses a self-review because the
 * thing being checked is whether somebody else's work is worth minting hours
 * for. Neither of those reasons stops being true for an owner.
 *
 * What changes for an owner is who is left to ask. Every account on this
 * platform comes from a real Hack Club identity, and the seeded demo people
 * cannot sign in - so exercising ship → review → approve end to end otherwise
 * needs two real humans with two real HCA accounts, and the owner testing the
 * thing they are building has nobody to hand it to at two in the morning.
 *
 * Kept narrow on purpose: `owner`, never `admin`, because admin is a rank
 * meant to be handed out and this is not. It is not a capability either - a
 * capability can be granted to somebody, and the whole point is that this
 * cannot be.
 *
 * Nothing here hides. A self-action writes an audit row whose actor and subject
 * are the same id, self-reviews are counted and flagged on the reviewer board
 * (see reviewers.ts), and the ledger entry a self-approval mints is as
 * append-only as every other. The trade is that an owner may do these things,
 * not that it goes unrecorded.
 */
export function mayActOnSelf(user: Principal): boolean {
	return user.role === 'owner';
}

/**
 * The roles this actor may set on somebody else.
 *
 * One definition, read by both the form that offers the options and the action
 * that applies one, so the select can never offer what the action will refuse.
 * They were two copies of the same arithmetic - including two separate
 * hand-written rank tables - which is the shape of bug this whole subsystem
 * exists to avoid.
 *
 * Everyone is capped strictly below their own rank: promoting somebody to your
 * own rank is the escalation `canActOn` refuses, arrived at in two steps
 * instead of one. An owner is the exception and it is what the rank is for -
 * the top of the tree appoints its own peers, or the first owner is the only
 * one there can ever be and the bus factor is one. That is not an escalation:
 * `canActOn` has already refused unless the subject ranks strictly below the
 * actor, so an owner may create a peer but still cannot edit one.
 */
export function assignableRoles(actor: Principal): readonly UserRole[] {
	const ceiling = actor.role === 'owner' ? RANK.owner : RANK[actor.role] - 1;
	return userRole.enumValues.filter((role) => RANK[role] <= ceiling);
}

/** One line per capability, for the grant form and the user page. Total over
 *  the enum, so a new capability is a type error until somebody says what it
 *  means - the same trick components/status.ts uses on the identity enums. */
export const CAPABILITY_LABELS = {
	manage_users: 'change roles and capabilities',
	manage_catalog: 'create and edit products',
	manage_orders: 'move orders, refund them, restock',
	manage_settings: 'launch switch and shop window',
	view_audit: 'read the audit log',
	run_jobs: 'run scheduled jobs by hand',
	view_pii: "reveal an order's shipping address",
	adjust_ledger: 'credit and debit balances by hand',
	review_submissions: "see other people's project pages (review itself is on Ari)",
	approve_submissions: 'nothing now - approvals come from Ari',
	manage_fraud: 'lift a fraud block so a project can ship again',
	fulfil_orders: 'pack and ship orders (page not built yet)'
} satisfies Record<Capability, string>;
