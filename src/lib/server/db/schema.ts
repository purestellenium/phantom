import { relations, sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	serial,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { JsonObject, JsonValue } from '../../json';

/**
 * The database.
 *
 * Identity and access, the reward ledger, the catalog, orders, the projection
 * outbox, the job log, and the operator audit trail. Projects and reviews are
 * deliberately absent - they are a later piece of work, and modelling them now
 * would mean guessing at their shape and then living with the guess. So is
 * fulfilment execution: nothing here talks to a warehouse, a carrier or HCB.
 *
 * What is here is shaped so those arrive as new tables rather than as a
 * migration through these ones. The platform baseline's warning is the reason:
 * the failure mode in this family of applications is one row that accumulates
 * every mutable fact about a participant until nothing can be said about what
 * was true at the moment a decision was made. Provider accounts are already
 * their own table for that reason, not columns on the user; the ledger is
 * append-only for the same reason; and an order freezes what it was sold rather
 * than pointing at a catalog row that will be edited next week.
 *
 * The seams left for the deferred work are named where they occur. The short
 * version: a review decision becomes a `submission_award` entry with an
 * idempotency key of `submission:<id>:award`, and fulfilment adds its own
 * columns and states to `orders` rather than reinterpreting the ones here.
 */

/* ── enums ───────────────────────────────────────────────────────────────── */

/**
 * What someone may do. Checked on the user row rather than derived from an
 * environment variable at request time.
 *
 * More than one source of truth for one question is how a user ends up
 * authorized on one route and rejected on another. Here the environment can
 * only seed this column; every check reads the column.
 *
 * `reviewer` exists with nothing yet to review. It is in the enum because
 * adding a value to a Postgres enum later is a migration that cannot run inside
 * a transaction with the code that uses it, and because the launch gate below
 * already needs to name the staff who bypass it.
 *
 * `owner` is the rank above admin, and it exists because the rank rule in
 * lib/auth/authorize.ts refuses an operator acting on an equal rank. With admin
 * at the top of the ladder that made promoting anyone TO admin, or widening an
 * existing admin's capabilities, impossible from inside the application - the
 * only way to do either was a psql session, which is precisely the situation
 * ADMIN_HCA_SUBJECTS was invented to avoid and does not actually cover, since
 * that variable only ever seeds the people named in it at deploy time. An owner
 * outranks admins and can therefore appoint them, and appoint other owners.
 *
 * The order of the values here is NOT the rank. RANK in
 * lib/auth/capabilities.ts is, for the reason stated there.
 */
export const userRole = pgEnum('user_role', ['participant', 'reviewer', 'admin', 'owner']);

/**
 * What someone may DO, as opposed to what they are called.
 *
 * The role above is a rank; this is the permission system. They are separate
 * because "admin" is not one capability, and every platform the wiki inspected
 * that treated it as one grew a hole: Fallout reserves real money movement for a
 * role ordinary admins cannot assign themselves, Stasis deliberately keeps
 * attendance management out of general admin, and Hackatime requires a higher
 * tier for a red conviction than for a shadowban. The rule the wiki states is
 * "define actions, not titles", and these are the actions.
 *
 * A role implies a base set (see lib/auth/capabilities.ts) and the array column
 * on the user adds to it. Admin and owner hold everything; the one difference
 * is `manage_users`, which only an owner has - an admin runs the program but
 * cannot promote or grant anyone. Reviewers and participants hold nothing
 * consequential unless a named person grants it, and the granting is an audit
 * row.
 *
 * One value has no call site yet: `fulfil_orders` waits on a fulfilment page
 * (the one that packs and ships, as distinct from `manage_orders`, which moves
 * an order through its states). It is in the enum now for the same reason
 * `reviewer` is in the role enum: adding a value to a Postgres enum later is a
 * migration that cannot run in the same transaction as the code that uses it,
 * and the cost of carrying an unused label is a line in a list. When that page
 * exists it gates itself with `requireCapability('fulfil_orders')` and takes a
 * row in the console's SECTIONS list with `needs: 'fulfil_orders'`.
 */
export const capability = pgEnum('capability', [
	/* Implemented and in use. */
	'manage_users',
	'manage_catalog',
	'manage_orders',
	'manage_settings',
	'view_audit',
	'run_jobs',
	/* Implemented, and deliberately not implied by any role. */
	'view_pii',
	'adjust_ledger',
	/* Declared, waiting on the subsystem that would check them. */
	'review_submissions',
	'approve_submissions',
	'manage_fraud',
	'fulfil_orders'
]);

/** Which upstream service a linked account belongs to. */
export const providerKind = pgEnum('provider_kind', ['hca', 'hackatime']);

/**
 * Identity verification, as the `verification_status` claim reports it.
 *
 * These are HCA's own derived identity states: permabanned or fatally rejected
 * gives `ineligible`, an active approved verification gives `verified`, an
 * active pending one gives `pending`, and nothing decisive gives
 * `needs_submission`.
 *
 * `unknown` is ours, not HCA's. It covers the claim being absent - because the
 * scope was not granted, or because the field simply was not in the response -
 * and the wiki is explicit that an absent field must not be read as an empty
 * value. Collapsing "we were not told" into "not verified" is how an outage
 * turns into a mass lockout.
 *
 * Stored as a string the app compares rather than a boolean it derives: the
 * difference between "has not submitted" and "was refused" is a real one a
 * boolean throws away, and a new state appearing upstream should show up as an
 * unrecognised value to look at rather than silently becoming `false`.
 */
export const verificationStatus = pgEnum('verification_status', [
	'needs_submission',
	'pending',
	'verified',
	'ineligible',
	'unknown'
]);

/**
 * The result of HCA's public identity check, which is a DIFFERENT set of values
 * from the claim above and must not be conflated with it.
 *
 * This is the trap the wiki warns about hardest. `verified` on the claim means
 * an approved verification exists; it does not mean the person is young enough
 * to be eligible, and verified adults are routinely `verified` and ineligible at
 * the same time. This endpoint answers the eligibility question directly, which
 * is why it is worth a second call and its own column.
 *
 * `unavailable` is ours: the endpoint timed out, 5xx'd, or could not be reached.
 * It is deliberately a value rather than a null so that "we asked and could not
 * find out" is distinguishable from "we never asked", which is the distinction
 * that decides whether a gate should be retried or refused.
 */
export const identityCheckResult = pgEnum('identity_check_result', [
	'needs_submission',
	'pending',
	'verified_eligible',
	'verified_but_over_18',
	'rejected',
	'not_found',
	'unavailable'
]);

/**
 * Our own decision, derived from everything above by exactly one function.
 *
 * Stored rather than computed at each call site so that every gate - project
 * submission and the shop alike - asks the same question and gets the same
 * answer. One derivation, one stored decision, and every gate reads this.
 */
export const eligibilityDecision = pgEnum('eligibility_decision', [
	'eligible',
	'blocked_age',
	'blocked_over_18',
	'blocked_rejected',
	'blocked_unverified',
	'undetermined'
]);

/* ── the economy ─────────────────────────────────────────────────────────── */

/**
 * The unit of value. One value, and this is the deliberate part.
 *
 * Phantom follows OneKey: approved coding seconds ARE the currency, so progress
 * and purchasing power are the same number and there is no exchange rate to
 * explain, freeze, or get wrong. The wiki's decision table calls that the
 * strongest option for "simple participant explanation" and the weakest for
 * "distinguish design from build" - which is a trade we can make, because there
 * are no stages here to distinguish.
 *
 * An enum with one member rather than no column at all, because the wiki's
 * earning key is `(decision_id, beneficiary_id, currency, reason)` and a ledger
 * that cannot name its unit cannot grow a second one without rewriting every
 * row. If a stage currency ever arrives it is a value here, not a migration
 * through the entries table.
 *
 * Amounts are stored in whole seconds. There is no fractional unit, so there is
 * no rounding policy to get wrong - the thing the wiki's reviewer-payment page
 * spends half its length on.
 */
export const ledgerCurrency = pgEnum('ledger_currency', ['seconds']);

/**
 * Why an entry exists.
 *
 * Every entry has exactly one of these and it never changes, because the type is
 * what makes the trail auditable: "approved decisions missing award entries" and
 * "order debit without order" are both queries over this column, and both are on
 * the wiki's integrity list.
 *
 * `submission_award` has no writer yet - reviews do not exist. It is here
 * because the shape of the earning transition is already decided and writing it
 * down is what stops it being guessed at later: a hard approval posts ONE entry
 * of this type, for the delta beyond the last approved baseline, keyed
 * `submission:<id>:award`. Nothing else may mint value.
 *
 * `referral_reward` is a milestone for inviting friends, keyed
 * `referral:<userId>:milestone:<count>`, or the credit that pays for the free
 * referral stickers, keyed `referral:<userId>:stickers`. The one exception to
 * awards being the only minting: see lib/server/referrals.ts.
 *
 * `reversal` is the compensating entry for an award that should not have
 * happened. It is a separate type from `order_refund` on purpose: refunding a
 * purchase and unwinding an approval have different authority, different
 * evidence, and different reversal rules, and one type for both would make them
 * indistinguishable in exactly the query that needs to tell them apart.
 */
export const ledgerEntryType = pgEnum('ledger_entry_type', [
	'submission_award',
	'admin_adjustment',
	'order_debit',
	'order_refund',
	'reversal',
	'referral_reward'
]);

/**
 * What kind of thing a product is, which decides what buying it requires.
 *
 * `physical` is the only kind that requires a shipping snapshot, and that is the
 * whole reason this column exists rather than a bare `requires_shipping`
 * boolean: Fallout stores nil shipping PII for non-shipping orders, and the way
 * to guarantee that is for the requirement to be a property of the product kind
 * rather than a flag someone can set independently of it.
 *
 * There were three. `grant` was speculative - a product whose effect is granted
 * at purchase - and nothing ever had one; it is a CATEGORY now, which is the
 * right shelf for it: a category is what a thing is filed under and a kind is
 * what buying it requires, and "granted at purchase" was only ever the former
 * wearing the latter's clothes. A kind earns its place by changing what the
 * purchase transaction has to do, and only `physical` does that.
 *
 * The label is gone from the Postgres type too, in migration 0009, and the
 * timing is the whole argument. Removing one from an enum means casting every
 * column that uses it out to text, dropping the type, recreating it and casting
 * back - three tables rewritten, one of them `orders`. That is a real cost on a
 * shop with a history and very close to free on one with two products, five
 * revisions and no orders at all, which is what this had when the change was
 * made. Leaving the orphan would have meant carrying a value the code does not
 * know about for as long as the table lives, and paying more to remove it every
 * month it stayed.
 */
export const productKind = pgEnum('product_kind', ['physical', 'digital']);

/**
 * Where an order is, operationally.
 *
 * A closed state machine, so an order cannot move backwards, twice, or
 * invisibly. The set is closed, the transitions are named in lib/shop/orders.ts, every
 * one of them checks the state it expects to be leaving, and every one of them
 * writes a row to `order_transitions`.
 *
 * Two of these are terminal: `rejected` and `cancelled`. Nothing moves out of
 * them. `fulfilled` is nearly so - its one way out is `unfulfilled`, for an
 * order that was sent and then came back (returned to sender, lost, wrong
 * thing shipped). From there an operator reships it or refunds it; the
 * participant cannot cancel it, since the goods may already be on their way
 * back to them. Reopening a rejected order is not a transition
 * - it is a new order, linked to the old one, which is the only version of
 * "reopen" that re-checks affordability. Fallout's does not, and the result is
 * an order that is live again with no funds behind it.
 *
 * Shipping states are absent because shipping is absent. When fulfilment lands
 * it adds its own values here rather than overloading `fulfilled`, and the
 * wiki's own advice is the reason: independent dimensions should not overwrite
 * one another.
 */
export const orderState = pgEnum('order_state', [
	'placed',
	'on_hold',
	'fulfilled',
	'rejected',
	'cancelled',
	'unfulfilled'
]);

/**
 * How far a projection has got.
 *
 * `ambiguous` is the one that earns its place. It means we called something
 * external, did not get an answer we could interpret, and DO NOT KNOW whether
 * the effect happened. The wiki's rule is that an ambiguous row blocks further
 * attempts until reconciliation resolves it, because retrying an effect that may
 * already have landed is how one notification becomes four and one transfer
 * becomes two.
 *
 * `skipped` is terminal and means an effect that will never be delivered and
 * does not need to be - its subject was deleted before the notification went
 * out. Not `delivered`, which would be a lie, and not `failed`, which would page
 * somebody about a resolved situation.
 *
 * An unconfigured provider is NOT this. That is a fact about the deployment
 * rather than the event and one variable changes it, so those rows stay
 * `pending` with a delay and deliver themselves once the variable is set. See
 * the `deferred` outcome in lib/outbox.ts.
 */
export const outboxStatus = pgEnum('outbox_status', [
	'pending',
	'delivered',
	'retryable',
	'failed',
	'ambiguous',
	'skipped'
]);

/** How a job run ended. `partial` covers a run that did some of its work and
 *  then hit something it could not do - which is a different operational
 *  question from one that never started. */
export const jobStatus = pgEnum('job_status', ['running', 'succeeded', 'partial', 'failed']);

/**
 * Where a project submission is in review.
 *
 * Review happens on Ari, Hack Club's review platform, and every move here
 * after the ship is Ari telling us what one of its reviewers decided - see
 * lib/server/ari.ts and lib/server/projects/decisions.ts. Phantom no longer
 * decides anything itself.
 *
 * `pending` is waiting on Ari, wherever the ship is there. `approved` minted the grant; `rejected` did not. `changes_requested`
 * is waiting on the author, who fixes the project and sends it back - the
 * same row, back to `pending`, and Ari keeps its old place in its queue.
 *
 * Ari can take a decision back two ways. `review.requeued` puts the ship back
 * on its queue for a fresh look, so it goes back to `pending` (and an approval
 * it undoes gives its hours back). `review.reverted` takes the decision back
 * and leaves the ship closed: that is `reverted`. Neither consumes the hours -
 * the project can ship that time again.
 *
 * `revoked` is the older, Phantom-side withdrawal of an approval, kept for the
 * submissions it was used on: its hours stay consumed (see BASELINE_STATES).
 * `first_passed` is the old on-platform two-step's middle state; nothing
 * enters it any more, and Ari's own internal phases are invisible here.
 */
export const submissionState = pgEnum('submission_state', [
	'pending',
	'first_passed',
	'approved',
	'rejected',
	'revoked',
	'changes_requested',
	'reverted'
]);

/* ── users ───────────────────────────────────────────────────────────────── */

export const users = pgTable(
	'users',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/**
		 * The HCA subject claim: our permanent join to the identity provider.
		 *
		 * Everything else HCA tells us can change - people change their email, their
		 * name, their Slack account - so any of those as the key would silently
		 * split one person into two accounts the first time they did. This is the
		 * only field upstream promises is stable, and it is the only one we key on.
		 */
		hcaSubject: text('hca_subject').notNull(),

		/* A cache of the last identity payload we were given, not an authority.
       These are refreshed from userinfo on every login, and anything that
       actually gates access re-reads them rather than trusting a stale row. */
		email: text('email').notNull(),
		displayName: text('display_name'),
		avatarUrl: text('avatar_url'),

		/** Hack Club's Slack account, when the user has one linked upstream. Kept
		 *  separate from the subject because it is a different namespace and is
		 *  absent for anyone who has not joined Slack. */
		slackId: text('slack_id'),
		/** Their Slack handle, fetched from Slack beside the avatar on every
		 *  sign-in. What a participant is called anywhere other participants can
		 *  see them - the explore page - because the display name is their real
		 *  name and nobody asked to publish it. Null until the first sign-in that
		 *  reaches Slack, or for anyone without a Slack account. */
		slackUsername: text('slack_username'),

		/** The partner that sent them, when one did - `stardance` - from the
		 *  `?utm_source=` link they arrived by. Written once, when the account is
		 *  created, and never on a later sign-in: it is where they came from,
		 *  not where they were last. See lib/referral.ts. */
		referralSource: text('referral_source'),

		/* ── personal referrals ────────────────────────────────────────────────
       A participant inviting a friend, as opposed to a partner sending a
       cohort. See lib/server/referrals.ts. */
		/** This person's own invite code, the `?ref=` in their link. Minted
		 *  the first time they are shown it. */
		inviteCode: text('invite_code'),
		/** Who invited them. Written once, when the account is created, from the
		 *  invite cookie - never afterwards, so nobody can be re-credited. */
		referredByUserId: uuid('referred_by_user_id').references((): AnyPgColumn => users.id, {
			onDelete: 'set null'
		}),
		/** When they started counting toward their inviter's milestones: the
		 *  first moment they were both onboarded and eligible. Set once. */
		referralQualifiedAt: timestamp('referral_qualified_at', { withTimezone: true }),

		/* ── identity signals ──────────────────────────────────────────────────
       Four fields, each recording WHAT we were told, by WHICH source, and WHEN.

       They are kept apart on purpose. The claim and the check disagree by
       design - one says whether a verification exists, the other whether the
       person is young enough to qualify - and a schema that merges them into one
       column makes the disagreement unrepresentable rather than resolving it.
       Every observation carries its own timestamp because they are fetched at
       different moments and a stale one is only dangerous if you cannot tell it
       is stale. */

		/** The `verification_status` claim, exactly as released. */
		verificationStatus: verificationStatus('verification_status').notNull().default('unknown'),
		verificationStatusAt: timestamp('verification_status_at', {
			withTimezone: true
		}),

		/**
		 * The `ysws_eligible` claim, exactly as released.
		 *
		 * Nullable, and null is meaningful: it is what we store when the claim was
		 * absent, which is not the same as it being present and false.
		 */
		yswsEligibleClaim: boolean('ysws_eligible_claim'),
		yswsEligibleClaimAt: timestamp('ysws_eligible_claim_at', {
			withTimezone: true
		}),

		/** The public identity check's result, on its own value set. */
		identityCheckResult: identityCheckResult('identity_check_result'),
		identityCheckAt: timestamp('identity_check_at', { withTimezone: true }),

		/**
		 * Calendar date, never a timestamp.
		 *
		 * A birthdate has no time of day and no time zone, and storing it as one
		 * makes eligibility depend on the server's offset - a UTC midnight rendered
		 * in a negative-offset zone is the previous day, which moves people across
		 * the 13 and 18 boundaries. The driver is configured to keep this a string
		 * for the same reason (see db/client.ts).
		 */
		birthdate: date('birthdate'),

		/**
		 * Our decision, and the rule that produced it.
		 *
		 * The version string is what makes a past decision explicable. When the
		 * rule changes - and it will, because eligibility policy is a program
		 * decision rather than a technical one - every row still records which
		 * version of it was applied, so a user asking why they were blocked in
		 * October can be answered without archaeology. Recomputing silently under a
		 * new rule would erase exactly that.
		 */
		eligibility: eligibilityDecision('eligibility').notNull().default('undetermined'),
		eligibilityAt: timestamp('eligibility_at', { withTimezone: true }),
		eligibilityRule: text('eligibility_rule'),

		role: userRole('role').notNull().default('participant'),

		/**
		 * Capabilities granted to this user BEYOND what their role implies.
		 *
		 * Additive, never subtractive: this array cannot take away something the
		 * role gives, because a permission system with both grants and revocations
		 * has an ordering question and therefore two answers. If a role should not
		 * imply something, it is removed from the role's base set in
		 * lib/auth/authorize.ts, which is one edit that applies to everyone rather
		 * than a revocation row per person.
		 *
		 * A column rather than a table, and that is a real trade. A table would
		 * record who granted each capability and when, which the wiki asks for -
		 * but every authenticated request would carry the join, and the grant
		 * history it would hold is already written to `audit_events` by the only
		 * code path that can change this. So: current state here, history there.
		 */
		capabilities: capability('capabilities')
			.array()
			.notNull()
			.default(sql`'{}'::capability[]`),

		/** Set when the user finishes onboarding. Null means they are still in it,
		 *  which is what the app routes on - a boolean would answer "did they
		 *  finish" without answering "when", and the when is what makes a funnel
		 *  countable. */
		/** Which of the addresses saved on the user's Hack Club account Phantom
		 *  ships to. HCA's own id for it; the address itself is never stored
		 *  here. Null means HCA's primary. Re-checked against the live list
		 *  every time it is used, so a deleted address falls back rather than
		 *  pointing at nothing. */
		defaultAddressId: text('default_address_id'),
		onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
		/**
		 * Held to the event: this person can buy only the invite and the flight
		 * stipend (see $lib/shop/locked.ts), nothing else in the shop. Set by an
		 * operator on the person's admin page - for someone whose fragments are
		 * meant for getting to Phantom and nothing else.
		 */
		shopLocked: boolean('shop_locked').notNull().default(false),

		/**
		 * The country of the address Phantom would ship to (the default, else
		 * HCA's primary, else the first), as an ISO 3166-1 alpha-2 code. A cache,
		 * not an authority: written whenever the address list is read anyway and
		 * at each sign-in (see lib/server/address.ts), so the shop can hide what
		 * is blocked there without asking HCA on every page. Null until it has
		 * been read, or when the address names no country we recognise.
		 */
		country: text('country'),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
	},
	(table) => [
		/* The constraint that makes repeat logins idempotent. Without it a slow
       callback racing itself creates two accounts for one person, and the
       second one wins silently. */
		uniqueIndex('users_hca_subject_idx').on(table.hcaSubject),
		/* Not unique. Email is mutable upstream and two subjects legitimately
       arriving with the same address is a support question, not a database
       error that should break a login. */
		index('users_email_idx').on(table.email),
		index('users_slack_id_idx').on(table.slackId),
		uniqueIndex('users_invite_code_idx').on(table.inviteCode),
		index('users_referred_by_idx').on(table.referredByUserId)
	]
);

/* ── sessions ────────────────────────────────────────────────────────────── */

export const sessions = pgTable(
	'sessions',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		userId: uuid('user_id')
			.notNull()
			/* A deleted user's sessions go with them, in the same statement. Left
         behind, they are credentials pointing at a row that no longer exists -
         and whether that fails open or closed depends on how carefully every
         lookup was written. */
			.references(() => users.id, { onDelete: 'cascade' }),

		/**
		 * SHA-256 of the token, never the token.
		 *
		 * The browser holds the only copy of the real value. Read access to this
		 * table therefore yields nothing usable, which is the entire point of
		 * hashing something that is already unguessable.
		 */
		tokenHash: text('token_hash').notNull(),

		/* Absolute expiry, written at creation and never extended in place. A
       sliding window implemented by moving this forward means a stolen session
       stays alive for as long as it is being used, which is exactly backwards. */
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

		/* Set when the session ends, rather than deleting the row: a session that
       was signed out is a different fact from a session that never existed, and
       telling them apart is what makes a support conversation possible. */
		revokedAt: timestamp('revoked_at', { withTimezone: true }),

		/* Coarse provenance, for showing someone their own active sessions. The IP
       is truncated before it gets here (see auth/session.ts) - the useful
       signal is "somewhere else entirely", which a /24 answers, and the exact
       address is more precise than the feature needs. */
		userAgent: text('user_agent'),
		ipPrefix: text('ip_prefix'),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
		index('sessions_user_id_idx').on(table.userId),
		/* Sweeping expired rows is a range scan over this. */
		index('sessions_expires_at_idx').on(table.expiresAt)
	]
);

/* ── oauth flows in progress ─────────────────────────────────────────────── */

/**
 * One row per authorization request we have sent and not yet seen come back.
 *
 * Server-side rather than in a cookie because this holds the PKCE verifier,
 * and a verifier the browser carries is a verifier an attacker who can read the
 * browser carries. It also gives single use somewhere to be enforced: the row
 * is consumed on the way through, so replaying a callback URL finds nothing.
 */
export const oauthStates = pgTable(
	'oauth_states',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/** The opaque value echoed back as `state`. */
		state: text('state').notNull(),

		/** The PKCE verifier whose challenge went out with the request. */
		codeVerifier: text('code_verifier').notNull(),

		/**
		 * Truncated client address, for the only rate limit this app has.
		 *
		 * Starting a login is the one unauthenticated write in the application: no
		 * session, no credential, one row per request. The TTL and the prune bound
		 * how long each row lives, not how many arrive, so this column is what lets
		 * a flood be counted before it is written. Same /24 or /48 truncation
		 * `sessions.ip_prefix` uses, and for the same reason - enough to count, not
		 * enough to be a location history.
		 */
		ipPrefix: text('ip_prefix'),

		provider: providerKind('provider').notNull(),

		/**
		 * Who started this flow, when we already know.
		 *
		 * Null for a sign-in, since there is no session yet. Set for a Hackatime
		 * link, and checked against the live session at the callback - otherwise a
		 * link callback completed in someone else's browser attaches their
		 * Hackatime account to whoever happens to be signed in there.
		 */
		userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

		/**
		 * Where to go afterwards. Stored here rather than round-tripped through the
		 * provider so it cannot be edited in flight: a redirect target that arrives
		 * back from a third party is an open redirect waiting to be found. It is
		 * still validated as a relative path before use.
		 */
		redirectTo: text('redirect_to'),

		/* Set the moment the row is spent. A callback that finds this already
       populated is a replay and is refused. */
		consumedAt: timestamp('consumed_at', { withTimezone: true }),

		/* Short - minutes, not hours. This is the window in which a leaked state
       value is worth anything. */
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('oauth_states_state_idx').on(table.state),
		index('oauth_states_expires_at_idx').on(table.expiresAt)
	]
);

/* ── linked provider accounts ────────────────────────────────────────────── */

/**
 * An account at an upstream service, and the credentials we hold for it.
 *
 * Its own table rather than columns on the user, so a second or third provider
 * is a row and not a migration, and so tokens live in one place that can be
 * audited for how they are stored.
 */
export const providerAccounts = pgTable(
	'provider_accounts',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		provider: providerKind('provider').notNull(),

		/** The stable identifier this provider knows the user by. */
		providerAccountId: text('provider_account_id').notNull(),

		/* Ciphertext, always - AES-256-GCM, format documented in lib/crypto.ts.
       The column types are text because that is what the encoding produces; a
       value that ever looks like a bare JWT in here is a bug. */
		accessTokenEncrypted: text('access_token_encrypted'),
		refreshTokenEncrypted: text('refresh_token_encrypted'),

		/**
		 * What the token is actually allowed to do, as granted rather than as
		 * requested.
		 *
		 * A provider may return narrower scopes than were asked for, and code that
		 * assumes it got what it asked for fails at the call site with a confusing
		 * 403 rather than here with an obvious one.
		 */
		scope: text('scope'),

		accessTokenExpiresAt: timestamp('access_token_expires_at', {
			withTimezone: true
		}),

		/** A copy of the provider's own profile payload, for support and for
		 *  showing the user which account they linked. Never read for
		 *  authorization - that always goes back to the source. */
		profile: jsonb('profile').$type<JsonObject>(),

		linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		/* One account per provider per user: linking Hackatime again updates the
       row rather than accumulating dead credentials beside it. */
		uniqueIndex('provider_accounts_user_provider_idx').on(table.userId, table.provider),
		/* And one user per upstream account. Without this, two people can link the
       same Hackatime account - which, once hours mean something, is the first
       way anyone would try to claim someone else's work. Enforcing it now costs
       nothing; retrofitting it means reconciling duplicates that already exist. */
		uniqueIndex('provider_accounts_provider_account_idx').on(
			table.provider,
			table.providerAccountId
		)
	]
);

/* ── site settings ───────────────────────────────────────────────────────── */

/**
 * Operator switches. Exactly one row, pinned by a check constraint.
 *
 * A settings table that can hold two rows will eventually hold two rows, and
 * then the answer to "are we launched" depends on which one a query happened to
 * read. The constraint makes that unrepresentable rather than merely unlikely.
 */
export const siteSettings = pgTable(
	'site_settings',
	{
		/* Always 1. The check constraint below is what makes this a singleton. */
		id: text('id').primaryKey().default('singleton'),

		/**
		 * The launch gate.
		 *
		 * While false the site is closed to everyone but staff and a narrow
		 * allowlist of public paths. OneKey cached this for fifteen seconds, which
		 * is the right trade - it is read on essentially every request, and being
		 * fifteen seconds stale at launch is not a problem where a database round
		 * trip per page load is.
		 */
		launched: boolean('launched').notNull().default(false),

		/** Shown on the closed page. Copy lives in the database so opening or
		 *  delaying a launch does not require a deploy. */
		prelaunchMessage: text('prelaunch_message'),

		/**
		 * The shop's own gate, separate from the launch gate.
		 *
		 * Two switches because they answer two questions and get flipped by
		 * different people at different times: launch decides whether the site
		 * exists, the shop window decides whether anything can be bought. Folding
		 * them together means closing the shop for a restock takes the whole
		 * platform down with it.
		 *
		 * Default false for the same reason `launched` is: the honest answer on an
		 * unseeded database is that the shop is not open.
		 */
		shopOpen: boolean('shop_open').notNull().default(false),

		/**
		 * A hard close, in addition to the switch above.
		 *
		 * The wiki lists `SHOP_CLOSES_AT` under lifecycle gates and requires it to
		 * be server-authoritative and dated. A date rather than a person remembering
		 * to flip a boolean at midnight is the entire point; null means no deadline,
		 * and a deadline in the past closes the shop regardless of `shopOpen`.
		 */
		shopClosesAt: timestamp('shop_closes_at', { withTimezone: true }),

		/** Shown where the catalog would be. Same argument as the prelaunch
		 *  message: closing early is an operator decision, not a deploy. */
		shopClosedMessage: text('shop_closed_message'),

		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		updatedBy: uuid('updated_by').references(() => users.id, {
			onDelete: 'set null'
		})
	},
	(table) => [
		/* What actually pins the table to one row. */
		check('site_settings_singleton', sql`${table.id} = 'singleton'`)
	]
);

/* ── the ledger ──────────────────────────────────────────────────────────── */

/**
 * One account per participant: the thing a spend locks, and the only place a
 * cached balance is allowed to live.
 *
 * Its own table rather than a column on the user, for two reasons that both
 * matter. The first is the lock: a purchase does `select ... for update` on this
 * row, and locking the user row instead would serialise every purchase against
 * every login, every identity refresh and every role change. The second is the
 * cache invariant below, which is a claim about this table and would be a claim
 * about the whole user record if it lived there.
 *
 * THE CACHED BALANCE IS NOT AUTHORITATIVE. The entries are. This column exists
 * so a dashboard can render a number without summing a growing table, and the
 * wiki's rule is the one lib/ledger.ts enforces: it is only ever written in the
 * same transaction as the entry that changed it, and a spend authorises itself
 * against a fresh sum rather than against this. `ledger.cachedBalance` in
 * lib/reconcile.ts is the integrity query that proves the two agree.
 */
export const ledgerAccounts = pgTable(
	'ledger_accounts',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		currency: ledgerCurrency('currency').notNull().default('seconds'),

		/** A projection of `sum(entries.amount)`, maintained transactionally. Never
		 *  read to authorise a spend - see lib/ledger.ts. */
		cachedBalance: bigint('cached_balance', { mode: 'number' }).notNull().default(0),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		/* One account per user per currency. With one currency that is one account
       per user; the composite key is what lets a second currency arrive without
       this constraint having to be dropped on a live table. */
		uniqueIndex('ledger_accounts_user_currency_idx').on(table.userId, table.currency)
	]
);

/**
 * Every economic fact, as an immutable row.
 *
 * Nothing in this table is ever updated and nothing is ever deleted. A mistake
 * is corrected by appending its opposite, linked back to the original - which is
 * the difference between a ledger and a balance with a history feature. The
 * wiki's entry contract is the checklist: account, signed amount, currency,
 * type, source record, actor, timestamp, idempotency key. All eight are columns
 * here, and the idempotency key is the one that does the work.
 *
 * There is deliberately no pending/confirmed distinction. Stasis has one and the
 * wiki's own conclusion is that it should only exist if early spending is a real
 * product requirement, because otherwise it multiplies edge cases: a returned
 * project after purchase, partial confirmation, cross-product pool rules,
 * unapproval after shipment. Phantom credits on approval and there is nothing to
 * spend before that, so a second bucket would be five states of complexity
 * bought for no behaviour.
 */
export const ledgerEntries = pgTable(
	'ledger_entries',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		accountId: uuid('account_id')
			.notNull()
			/* Restrict, not cascade. Deleting an account that has entries would
         destroy the economic record of a real person's real purchases, and the
         right answer to "this user left" is a decision somebody makes about
         retention rather than a foreign key doing it silently. */
			.references(() => ledgerAccounts.id, { onDelete: 'restrict' }),

		currency: ledgerCurrency('currency').notNull().default('seconds'),

		/**
		 * Signed, in whole seconds. Positive credits, negative debits.
		 *
		 * Signed rather than an amount plus a direction flag, because a sum is then
		 * the balance and every integrity query is arithmetic rather than a case
		 * expression that somebody will eventually write the wrong way round.
		 */
		amount: bigint('amount', { mode: 'number' }).notNull(),

		entryType: ledgerEntryType('entry_type').notNull(),

		/** One line, for a human reading a statement. Structured facts belong in
		 *  `metadata`; this is prose and nothing parses it.
		 *
		 *  Summer of Making derived how much a reviewer had been paid by parsing
		 *  `"N decisions"` out of a reason string, which the wiki records as a
		 *  historical failure risk. Nothing here may do that. */
		reason: text('reason').notNull(),

		/**
		 * The key that makes a retry safe, and the extension point for every
		 * earning transition that has not been built yet.
		 *
		 * It is a string with a shape rather than a composite of typed columns
		 * because the sources are heterogeneous and some of them do not exist yet.
		 * The forms in use:
		 *
		 *   intent:<purchase intent>:debit   (the buyer's form token, not the
		 *                                      order id - the debit is keyed on the
		 *                                      thing that is stable across a retry,
		 *                                      and the order id is minted by the
		 *                                      insert the retry is racing)
		 *   order:<order id>:refund
		 *   adjust:<uuid>                     (admin adjustments; unique per click)
		 *   reverse:<original entry id>
		 *   submission:<submission id>:award  (reserved; reviews do not exist)
		 *
		 * A job retry, a repeated callback or a double-submitted form finds the
		 * existing row through this unique index and adds nothing. That is the whole
		 * mechanism - there is no second guard, and there does not need to be.
		 */
		idempotencyKey: text('idempotency_key').notNull(),

		/** The order this entry is about, for the two order-linked types. Null for
		 *  awards and adjustments. */
		orderId: uuid('order_id').references(() => orders.id, {
			onDelete: 'restrict'
		}),

		/**
		 * The entry this one reverses.
		 *
		 * Unique, so one original can have at most one effective reversal - the
		 * wiki calls that a database invariant and it is, here, rather than a
		 * convention. Repeated admin clicks and job retries hit the constraint and
		 * return the existing compensation instead of stacking a second one.
		 *
		 * Postgres treats nulls as distinct in a unique index, so the millions of
		 * entries that reverse nothing are unaffected.
		 */
		reversesEntryId: uuid('reverses_entry_id').references((): AnyPgColumn => ledgerEntries.id, {
			onDelete: 'restrict'
		}),

		/** Who caused it. Null for anything the system did on its own - an order
		 *  debit posted by the purchase path is the user's own action and names
		 *  them; a future automated award would not. */
		actorId: uuid('actor_id').references(() => users.id, {
			onDelete: 'set null'
		}),

		/** The calculation's inputs, when there were any worth keeping. The wiki:
		 *  store the inputs or the version so a later policy change does not rewrite
		 *  historical awards. */
		metadata: jsonb('metadata').$type<JsonObject>(),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('ledger_entries_idempotency_idx').on(table.idempotencyKey),
		uniqueIndex('ledger_entries_reverses_idx').on(table.reversesEntryId),
		index('ledger_entries_account_idx').on(table.accountId, table.createdAt),
		index('ledger_entries_order_idx').on(table.orderId),
		index('ledger_entries_type_idx').on(table.entryType, table.createdAt),
		/* Zero-value entries are always a bug: something computed a delta, got
       nothing, and wrote it down anyway. Fallout's transaction models reject
       them for the same reason. */
		check('ledger_entries_nonzero', sql`${table.amount} <> 0`)
	]
);

/* ── the catalog ─────────────────────────────────────────────────────────── */

/**
 * A shelf in the shop. Operator-defined, and deliberately thin.
 *
 * This is taxonomy, not policy. A category says where something is filed and
 * nothing else - it does not gate who may buy, what buying costs, or what
 * buying requires, all of which are `kind`, `price` and `requires_eligibility`.
 * Keeping it thin is what makes it safe to let operators create and delete
 * these at will: there is no rule hanging off a category that deleting one
 * could quietly switch off.
 *
 * That is also why this is a table rather than an enum. The kinds are a closed
 * set the purchase path branches on, so adding one is a code change by design;
 * shelves are merchandising and change between events, so adding one must not
 * be. Deleting a category files its products back under "everything else"
 * rather than deleting them - see the `set null` on `products.category_id`.
 */
export const productCategories = pgTable(
	'product_categories',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/** What the shop's filter puts in the URL. Unique, lowercase-hyphen, and
		 *  the same grammar as a product slug so a link to a filtered shop is as
		 *  readable as a link to a product. */
		slug: text('slug').notNull(),

		name: text('name').notNull(),

		/** Where it sits in the filter row, low first. Ties break on name, so a
		 *  table of all-zero positions is alphabetical rather than arbitrary -
		 *  which is what an operator who never touches this field expects. */
		position: integer('position').notNull().default(0),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' })
	},
	(table) => [uniqueIndex('product_categories_slug_idx').on(table.slug)]
);

/**
 * A thing that can be bought. Mutable, and that is why it is versioned.
 *
 * An order that kept only a foreign key to this row would let an edit to a
 * product's name or price rewrite what every past order appears to have been.
 * So there are two halves: an order freezes what it bought (see `orders`), and
 * every economically relevant edit here bumps `version` and writes the whole
 * product into `product_revisions`. The frozen version number then names a row
 * that still exists and still says what it said.
 */
export const products = pgTable(
	'products',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/** The URL segment. Stable, unique, and never reused - a slug that moves
		 *  from one product to another turns every old link into a wrong page. */
		slug: text('slug').notNull(),

		name: text('name').notNull(),
		/** Plain text, rendered as text. No markup, so there is no sanitiser to get
		 *  wrong on a field operators can edit. */
		description: text('description'),
		/** A picture of it. Presentation only: not frozen onto an order or a
		 *  revision, since nothing economic depends on which photo was up. */
		imageUrl: text('image_url'),
		/**
		 * Breathing room around that picture on a card, in CSS pixels.
		 *
		 * A photograph wants to bleed to the card's edges and a cut-out - a
		 * sticker, a pin, a logo on nothing - wants air around it, and which of
		 * the two a product's image is cannot be read off the file. So it is a
		 * number an operator sets per product rather than a rule the card guesses
		 * at.
		 *
		 * Presentation only, exactly like the URL above: not frozen onto a
		 * revision, and not in the `material` list that bumps a version, because
		 * nothing an order means depends on how much space was around the photo.
		 *
		 * Zero by default, which is the bleed the card has always drawn.
		 */
		imagePadding: integer('image_padding').notNull().default(0),

		/**
		 * Where it sits among products at the same price, low first.
		 *
		 * A tiebreak and never more: the price sorts still sort by price, and
		 * this only decides the order of things the price cannot tell apart -
		 * the four $50 grants, say, which would otherwise fall back to the
		 * alphabet. The name sorts ignore it, since a reader who asked for a-z
		 * asked for exactly that. Ties here break on name, so a catalog where
		 * nobody has touched it is alphabetical within a price, as before.
		 *
		 * Presentation only, like the padding above: not frozen onto a revision,
		 * and no version bump, because no order means anything different for
		 * where the product sat on the shelf.
		 */
		position: integer('position').notNull().default(0),

		/**
		 * The rest of the pictures, as a gallery: a list of URLs, or null.
		 *
		 * `imageUrl` above stays the COVER and is unchanged in meaning - it is
		 * what every card, row and order thumbnail shows, and there is exactly one
		 * of it. This is what the product page has beyond that, shown after the
		 * cover in the order an operator wrote them. So a product with no gallery
		 * behaves exactly as it always did, and nothing outside the product page
		 * has to learn about a second picture.
		 *
		 * A jsonb array rather than a `product_images` table, for the reason the
		 * option schema is jsonb: this is an ordered list of strings that is only
		 * ever read as a whole, by one page, and has no identity of its own - no
		 * row here is something an order, a revision or an audit event would ever
		 * point at. A table would buy referential integrity over nothing that
		 * refers to it, and cost a join on the shop's hottest page.
		 *
		 * Presentation only, exactly like the cover and the padding: not frozen
		 * onto a revision and not in the `material` list that bumps a version,
		 * because nothing an order MEANS depends on how many photographs were up.
		 *
		 * An option's choice may name one of these to switch to when it is picked
		 * - see lib/shop/options.ts. That reference is by URL rather than by index
		 * so that reordering the gallery cannot silently repoint it at a different
		 * photograph.
		 */
		images: jsonb('images').$type<string[]>(),

		kind: productKind('kind').notNull(),

		/**
		 * Which shelf it is filed under, or null for none.
		 *
		 * Nullable on purpose, and not merely because existing rows need a value:
		 * "uncategorised" is a real and permanent state of the catalog, not a
		 * migration artefact. A product exists before anyone has decided where it
		 * belongs, and forcing a choice at creation time produces a junk category
		 * that means "I had to pick something".
		 *
		 * `set null` rather than `restrict`, which is the opposite of the rule
		 * `orders.product_id` follows, and the difference is what the reference
		 * means. An order points at a product to say what was bought - losing that
		 * would falsify history, so the delete is refused. A product points at a
		 * category to say where it is filed - losing that costs a shelf label and
		 * nothing else. Making operators empty a category by hand before they may
		 * delete it would buy no integrity and would mostly produce abandoned
		 * categories nobody dares touch.
		 *
		 * Not versioned, and not written to `product_revisions`, for the reason
		 * given at the top of lib/shop/catalog.ts: an order's meaning does not
		 * depend on where the shop filed the thing.
		 */
		categoryId: uuid('category_id').references(() => productCategories.id, {
			onDelete: 'set null'
		}),

		currency: ledgerCurrency('currency').notNull().default('seconds'),
		/** In whole seconds. Positive; a free product is `active` with a price of
		 *  zero, which the check below forbids - see the note there. */
		price: bigint('price', { mode: 'number' }).notNull(),

		/**
		 * Units left, or null for unlimited.
		 *
		 * Null rather than a large number, because "unlimited" and "we have 999" are
		 * different facts and the second one eventually runs out. The decrement is a
		 * guarded update (`where stock >= quantity`) in lib/shop/purchase.ts, so
		 * concurrent purchases cannot oversell.
		 */
		stock: integer('stock'),

		/** How many one person may buy, ever, or null for no limit. The counting
		 *  rule is a policy decision and is stated in lib/shop/purchase.ts: rejected
		 *  and cancelled orders release the quota. */
		perUserLimit: integer('per_user_limit'),

		/** Whether buying this requires being eligible. Almost always true; a
		 *  column rather than a constant because "who may buy this" is program
		 *  policy and the program changes it without a deploy. */
		requiresEligibility: boolean('requires_eligibility').notNull().default(true),

		/**
		 * What the buyer must choose, as a schema the server validates against.
		 *
		 * Checked against the catalog so an order cannot carry a size that was
		 * never offered. The shape is in lib/shop/options.ts and validation happens inside the
		 * purchase transaction, against the FROZEN revision - so editing the schema
		 * cannot retroactively invalidate an order that was valid when it was
		 * placed.
		 */
		optionSchema: jsonb('option_schema').$type<JsonValue>(),

		/* An availability window, independent of the shop's own. A product can be
       listed before it can be bought and can stop being buyable without the
       shop closing. Both null means "whenever the shop is open". */
		availableFrom: timestamp('available_from', { withTimezone: true }),
		availableUntil: timestamp('available_until', { withTimezone: true }),

		/** Countries it cannot reach, as ISO 3166-1 alpha-2 codes. Hidden from
		 *  people whose stored country is one of them, and refused at checkout
		 *  for an address in one (see $lib/shop/regions.ts). Like the window
		 *  above, it says who can buy it, not what buying it means, so changing
		 *  it does not bump the version. */
		blockedCountries: text('blocked_countries')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),

		/** Unlisted and unbuyable when false. Products are retired rather than
		 *  deleted, because a deleted product is one an old order points at. */
		active: boolean('active').notNull().default(false),

		/** Bumped by every economically relevant edit, and frozen onto each order.
		 *  Starts at 1; there is a revision row for every value it has held. */
		version: integer('version').notNull().default(1),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		updatedBy: uuid('updated_by').references(() => users.id, {
			onDelete: 'set null'
		})
	},
	(table) => [
		uniqueIndex('products_slug_idx').on(table.slug),
		index('products_active_idx').on(table.active),
		/* Both halves of the shop's category filter: the lookup, and the count of
       products on a shelf the console shows before offering to delete it. */
		index('products_category_idx').on(table.categoryId),
		/* A negative price is a product that pays you to take it. A zero price is a
       purchase with no ledger entry, which the entries table forbids anyway -
       so it would fail deep inside a transaction instead of here. Give things
       away by adjusting a balance, not by pricing at zero. */
		check('products_price_positive', sql`${table.price} > 0`),
		check('products_stock_non_negative', sql`${table.stock} is null or ${table.stock} >= 0`),
		/* Bounded at both ends. Negative padding is a picture pulled outside its
		   own frame, and a number far past the thumbnail's height is a card with
		   no picture on it at all - both are typos rather than intentions, and a
		   check here catches the one that gets past the form. */
		check(
			'products_image_padding_sane',
			sql`${table.imagePadding} >= 0 and ${table.imagePadding} <= 64`
		),
		/* Bounded so a typo in the form is a sentence rather than a number that
		   happens to fit in an int. Thousands of slots either side of zero is far
		   more room than a shelf of tens of products will ever use. */
		check('products_position_sane', sql`${table.position} >= -9999 and ${table.position} <= 9999`),
		/* An array, and a short one. The column is written from a textarea, and
		   the two ways it can go wrong are a shape that is not a list at all - a
		   bare string, an object - and a list long enough to be a mistake. Both
		   are refused with a sentence in validateDraft; this is the floor under
		   that, for anything that reaches the column another way. */
		check(
			'products_images_sane',
			sql`${table.images} is null or (
				jsonb_typeof(${table.images}) = 'array' and jsonb_array_length(${table.images}) <= 8
			)`
		),
		check(
			'products_limit_positive',
			sql`${table.perUserLimit} is null or ${table.perUserLimit} > 0`
		)
	]
);

/**
 * What a product was, at one version. Append-only.
 *
 * This is what makes `orders.productVersion` mean something. Without it the
 * order records that it bought version 3 of a product and nothing on earth can
 * say what version 3 was - which is the same amount of information as recording
 * nothing, only more convincing.
 *
 * It doubles as the catalog's audit trail: who changed a price, when, and from
 * what. That is why `changedBy` is here rather than only in `audit_events` -
 * the price history is the thing being audited and it should be readable
 * without a join to a table of loosely typed metadata.
 */
export const productRevisions = pgTable(
	'product_revisions',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		productId: uuid('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'restrict' }),

		version: integer('version').notNull(),

		/* The economically relevant fields, copied. Not a blob of the whole row:
       `updatedAt` and `stock` change constantly and would make every revision
       look different from the last for reasons no order cares about. */
		name: text('name').notNull(),
		description: text('description'),
		kind: productKind('kind').notNull(),
		currency: ledgerCurrency('currency').notNull(),
		price: bigint('price', { mode: 'number' }).notNull(),
		perUserLimit: integer('per_user_limit'),
		requiresEligibility: boolean('requires_eligibility').notNull(),
		optionSchema: jsonb('option_schema').$type<JsonValue>(),

		changedBy: uuid('changed_by').references(() => users.id, {
			onDelete: 'set null'
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [uniqueIndex('product_revisions_version_idx').on(table.productId, table.version)]
);

/* ── orders ──────────────────────────────────────────────────────────────── */

/**
 * An entitlement and the operational record that delivers it.
 *
 * The wiki separates the two concepts and then observes that every inspected
 * platform combines them in one row anyway. So does this - but only because the
 * economic half is frozen and the operational half is the only thing that moves.
 * The frozen columns below are written once, at placement, and no transition may
 * touch them. That is what makes "rejecting an order" a compensating ledger
 * entry rather than an edit to what the order says it cost.
 *
 * Reading this table tells you what someone bought and for what, without a join
 * to anything that has changed since.
 */
export const orders = pgTable(
	'orders',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),

		/* Which catalog row, and which version of it. The foreign key is for
       navigation - "show me every order for this product" - and is explicitly
       NOT where the price and name come from. */
		productId: uuid('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'restrict' }),
		productVersion: integer('product_version').notNull(),

		/* ── frozen at placement ───────────────────────────────────────────────
       Immutable. Nothing in lib/shop/orders.ts writes to any of these. */

		productName: text('product_name').notNull(),
		productKind: productKind('product_kind').notNull(),
		currency: ledgerCurrency('currency').notNull(),
		unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
		quantity: integer('quantity').notNull(),
		/** unitPrice × quantity, stored rather than derived. The multiplication
		 *  happened once, at a moment with a particular price in it, and recomputing
		 *  it later from a column that might drift is how a total stops matching the
		 *  ledger entry that paid it. */
		totalPrice: bigint('total_price', { mode: 'number' }).notNull(),

		/** The buyer's selections, validated against the frozen revision's schema
		 *  before this row existed. */
		options: jsonb('options').$type<Record<string, string>>(),

		/**
		 * Recipient and address, encrypted, for physical products only.
		 *
		 * The ciphertext envelope is the one in lib/crypto.ts. Non-physical orders
		 * store null here, which is Fallout's behaviour and the right one: an order
		 * that cannot ship has no business holding a postal address.
		 *
		 * It is a snapshot, not a join: reading the account's CURRENT address
		 * would let editing a profile after purchase silently change where a
		 * past order ships to, with no record of where it was supposed to go. Reading this column requires `view_pii` and writes an
		 * audit row; see lib/shop/orders.ts.
		 */
		shippingEncrypted: text('shipping_encrypted'),

		state: orderState('state').notNull().default('placed'),
		/** When the current state was entered. `order_transitions` has the full
		 *  history; this is here so "what is stuck" is one indexed query. */
		stateAt: timestamp('state_at', { withTimezone: true }).notNull().defaultNow(),

		/**
		 * The purchase intent this order came from.
		 *
		 * Generated by the server when the form is rendered and submitted with it,
		 * so a double-click, a back-button repost or a retried request carries the
		 * same value and finds this row instead of buying a second one. Reloading
		 * the page mints a new intent, which is correct: that is a person who has
		 * decided to buy another.
		 */
		idempotencyKey: text('idempotency_key').notNull(),

		/** Set when a rejected order is replaced. The replacement is a NEW order
		 *  that re-checked affordability, stock and quota; this column is the link,
		 *  not a reopening. */
		replacesOrderId: uuid('replaces_order_id').references((): AnyPgColumn => orders.id, {
			onDelete: 'set null'
		}),

		/**
		 * Whether this order actually took a unit off the shelf.
		 *
		 * Restocking cannot infer this. A product with null stock is unlimited and
		 * the purchase decrements nothing; if an operator later gives that product
		 * a finite stock number and the buyer then cancels, returning the units
		 * would credit inventory that was never removed - the shop would offer
		 * fifteen of a run of ten, and five buyers would pay for goods that cannot
		 * ship. The order is the only thing that knows what it did, so it records
		 * it at the moment it does it.
		 */
		stockTaken: boolean('stock_taken').notNull().default(false),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('orders_idempotency_idx').on(table.idempotencyKey),
		index('orders_user_idx').on(table.userId, table.createdAt),
		index('orders_state_idx').on(table.state, table.stateAt),
		index('orders_product_idx').on(table.productId),
		check('orders_quantity_positive', sql`${table.quantity} > 0`),
		check(
			'orders_total_matches',
			sql`${table.totalPrice} = ${table.unitPrice} * ${table.quantity}`
		),
		/* The invariant that keeps shipping PII off orders that cannot ship. A
       constraint rather than a code convention, because the code that would
       break it is code nobody has written yet. */
		check(
			'orders_shipping_only_physical',
			sql`${table.productKind} = 'physical' or ${table.shippingEncrypted} is null`
		)
	]
);

/**
 * Every move an order has made. Append-only.
 *
 * So that "who refunded this and why" is answerable and backward movement is
 * visible. Each row here names the state
 * left, the state entered, the person, and the reason - and the transition
 * service refuses to write one unless the order really was in `fromState`, which
 * is what makes a stale admin tab harmless instead of destructive.
 *
 * The first row for every order has a null `fromState`: placement is a
 * transition from nothing, and recording it means the history is complete from
 * birth rather than starting at the first correction.
 */
export const orderTransitions = pgTable(
	'order_transitions',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		orderId: uuid('order_id')
			.notNull()
			.references(() => orders.id, { onDelete: 'cascade' }),

		/** Null only for the placement row. */
		fromState: orderState('from_state'),
		toState: orderState('to_state').notNull(),

		/** Null when the participant did it to their own order through an ordinary
		 *  route, which is still recorded - see `actorRole`. */
		actorId: uuid('actor_id').references(() => users.id, {
			onDelete: 'set null'
		}),

		/** Required. A state change with no stated reason is the one you cannot
		 *  explain to the person it happened to. */
		reason: text('reason').notNull(),

		metadata: jsonb('metadata').$type<JsonObject>(),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('order_transitions_order_idx').on(table.orderId, table.createdAt)]
);

/* ── the outbox ──────────────────────────────────────────────────────────── */

/**
 * A local decision that has committed, and an external effect that has not.
 *
 * The pattern exists because a database transaction cannot roll back a network
 * call. Doing the database work and then calling Airtable, then Slack, inline
 * means a failure at the third step leaves the first two done and nothing
 * durable saying the third is owed.
 *
 * A row here is inserted in the same transaction as the decision it belongs to.
 * A worker claims it, calls out, and records what happened. Nothing else in this
 * codebase is allowed to make a fallible external call inline.
 */
export const outboxEvents = pgTable(
	'outbox_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/** Which effect this is, matching a handler in lib/effects. Text rather
		 *  than an enum: the set grows every time an integration is added, and an
		 *  enum would make each one a migration for no gained safety - an unknown
		 *  effect is already handled, as `failed` with a legible reason. */
		effect: text('effect').notNull(),

		/**
		 * What makes this effect unique.
		 *
		 * Two rows with the same effect and key are the same intent, so the unique
		 * index below means an enqueue inside a retried transaction cannot produce a
		 * second notification. Shaped like the ledger's: `order:<id>:placed`.
		 */
		dedupeKey: text('dedupe_key').notNull(),

		/**
		 * Enough to reconstruct the call, and no more.
		 *
		 * The wiki is explicit: no long-lived tokens and no unnecessary PII in here.
		 * A row references what it is about - an order id - and the handler reads
		 * the current record at execution time. A shipping address never enters this
		 * table.
		 */
		payload: jsonb('payload').$type<JsonObject>(),

		status: outboxStatus('status').notNull().default('pending'),

		attempts: integer('attempts').notNull().default(0),
		/** When it may next be tried. Exponential backoff, set on each failure. */
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),

		/** Held by the worker that has claimed this row, so two replicas cannot
		 *  both deliver it. Cleared on completion; a lease that has expired is
		 *  reclaimable, which is what stops a crashed worker stranding a row. */
		leasedUntil: timestamp('leased_until', { withTimezone: true }),

		/** Whatever the far end calls this - a Slack message timestamp, a remote
		 *  record id. What reconciliation compares against. */
		remoteId: text('remote_id'),

		/** Sanitised. Status codes and error names, never bodies, never headers. */
		lastError: text('last_error'),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('outbox_effect_dedupe_idx').on(table.effect, table.dedupeKey),
		/* The claim query's index: pending or retryable, due now, oldest first. */
		index('outbox_due_idx').on(table.status, table.nextAttemptAt)
	]
);

/* ── jobs ────────────────────────────────────────────────────────────────── */

/**
 * One row per run of a scheduled job.
 *
 * Its purpose is the alert the wiki asks for and nothing else: "scheduler
 * silence" is only detectable if a successful run leaves a trace, and a job that
 * quietly stopped being invoked looks exactly like a job with nothing to do.
 *
 * Stasis starts a five-minute interval from Node instrumentation in every web
 * replica, so notifications duplicate across replicas and restart forgets what
 * was already sent. Nothing here runs on a timer inside the web process: jobs
 * are invoked through one authenticated endpoint, hold a Postgres advisory lock
 * for the duration, and write one of these.
 */
export const jobRuns = pgTable(
	'job_runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/** Matches a key in the registry in lib/jobs. */
		name: text('name').notNull(),

		status: jobStatus('status').notNull().default('running'),

		/** Whatever the job counted: rows swept, effects delivered, mismatches
		 *  found. Loose on purpose - a job that needs a new counter should not need
		 *  a migration to report it. */
		result: jsonb('result').$type<JsonObject>(),

		/** Sanitised message. Same rule as the outbox. */
		error: text('error'),

		/** Who asked. Null for the scheduler, set when an operator pressed the
		 *  button, which is the distinction that makes an unexpected run
		 *  explicable. */
		triggeredBy: uuid('triggered_by').references(() => users.id, {
			onDelete: 'set null'
		}),

		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true })
	},
	(table) => [index('job_runs_name_idx').on(table.name, table.startedAt)]
);

/* ── audit ───────────────────────────────────────────────────────────────── */

/**
 * Append-only record of things worth being able to reconstruct later.
 *
 * Sessions, links and role changes all leave a trace here. It is written on the
 * same connection as the change it describes, so an audit row cannot exist for
 * a change that was rolled back, and the change cannot commit without it.
 */
export const auditEvents = pgTable(
	'audit_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/** Who did it. Null for anything the system did on its own. */
		actorId: uuid('actor_id').references(() => users.id, {
			onDelete: 'set null'
		}),

		/** Who or what it was done to. */
		subjectId: uuid('subject_id').references(() => users.id, {
			onDelete: 'set null'
		}),

		/** A dotted verb - `session.created`, `provider.linked`, `role.changed`. */
		action: text('action').notNull(),

		/** Whatever else the event needs. Deliberately loose: an audit trail that
		 *  requires a migration to record a new kind of event does not get written. */
		metadata: jsonb('metadata').$type<JsonObject>(),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('audit_events_subject_idx').on(table.subjectId, table.createdAt),
		index('audit_events_action_idx').on(table.action, table.createdAt)
	]
);

/* ── projects & reviews ──────────────────────────────────────────────────── */

/**
 * What a project is built out of, as its owner says when starting it. Asked
 * first in the new-project flow because it changes what the rest of the flow
 * suggests, and kept because a reviewer judging a PCB and one judging a website
 * are looking for different evidence. Nullable on the column: every project
 * made before the question existed has no answer, and guessing one would be
 * worse than saying nothing.
 */
export const projectKind = pgEnum('project_kind', ['software', 'hardware']);

/**
 * A project: the owner's editable working copy.
 *
 * Mutable, like a catalog product. Editing it never touches a submission already
 * frozen (see below), so an owner can keep working while a ship is in review
 * without changing what the reviewer is judging. Only a project with no
 * submissions may be deleted - once shipped it is part of the record.
 */
export const projects = pgTable(
	'projects',
	{
		id: uuid('id').primaryKey().defaultRandom(),

		/**
		 * The public identifier: 1, 2, 3, ... - what appears in the URL and
		 * anywhere a project is referenced outside this codebase. The UUID above
		 * stays the real primary key, the one every foreign key points at; this is
		 * a second, front-facing axis, assigned once by the database's own
		 * sequence and never reused or renumbered.
		 */
		number: serial('number').notNull(),

		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		name: text('name').notNull(),
		description: text('description'),
		repoUrl: text('repo_url'),
		demoUrl: text('demo_url'),
		screenshotUrl: text('screenshot_url'),
		kind: projectKind('kind'),

		/** Comma-separated Hackatime project names whose seconds count for this
		 *  project. Read at ship time to compute the claim. */
		hackatimeProjects: text('hackatime_projects'),
		aiDeclaration: text('ai_declaration'),

		/**
		 * The owner's own declaration that this project is an update to something
		 * that already existed - where it was submitted before, what they had, and
		 * what they changed.
		 *
		 * Non-null IS the mark. Phantom infers an update from its own history (a
		 * submission with an approved baseline behind it), and that inference can
		 * only ever see Phantom: a project built for another program and brought
		 * here reads as brand new, which is the one case where the reviewer most
		 * needs to be told otherwise. So the owner can say so, and says it in one
		 * field for the same reason the AI declaration is one field - what is
		 * wanted is an account, not three inputs to assemble into one.
		 *
		 * Saved with the rest of the working copy, like `aiDeclaration`, so it
		 * can be written before shipping; shipping with the box unticked clears
		 * it.
		 */
		updateDeclaration: text('update_declaration'),

		/**
		 * Anything else the owner wants the reviewer to know - the free field at
		 * the bottom of the ship panel, for what none of the questions above
		 * asked about.
		 *
		 * Unlike the two declarations it answers no yes/no question, so there is
		 * no box to untick and no refusal attached: empty is a perfectly good
		 * answer, and null is what empty means.
		 */
		notesForReviewer: text('notes_for_reviewer'),

		/**
		 * "What's new since your last ship?", written ahead of the ship that
		 * needs it. Saved with the working copy so it can be drafted as the work
		 * happens; the ship freezes it onto the submission as `changelog` and
		 * clears it here, so the next update starts from an empty box.
		 */
		changelogDraft: text('changelog_draft'),

		/** Legacy, kept for history: nothing sets or reads this since review
		 *  moved to Ari. */
		fraudHold: boolean('fraud_hold').notNull().default(false),

		/**
		 * Put away by its owner: a project that was shipped and never approved
		 * - so it cannot be deleted - and that they are done with. Off their
		 * projects page and out of "logged" on home, still reachable by its
		 * link and from their archived page, and still on the console. Its
		 * Hackatime projects stay claimed, so the time it was turned down for
		 * cannot be shipped again under a new project. Null is not archived.
		 */
		archivedAt: timestamp('archived_at', { withTimezone: true }),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('projects_user_idx').on(table.userId, table.createdAt),
		uniqueIndex('projects_number_idx').on(table.number)
	]
);

/**
 * A submission: a frozen snapshot of a project at the moment it was shipped, and
 * the review decision made about it.
 *
 * The review unit - the thing Ari's reviewers judge and the award keys off. It
 * freezes the project's fields and the Hackatime claim so neither can change
 * under review, exactly the way an order freezes what it bought. Ari's approval
 * posts ONE `submission_award` ledger entry for at most the delta beyond the
 * last approved baseline; nothing else mints value. See projects/decisions.ts.
 */
export const submissions = pgTable(
	'submissions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		/* Restrict, not cascade: an approved submission is tied to an append-only
		   ledger entry, and deleting the person is a retention decision, not a
		   foreign key's to make silently. */
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),

		/* ── frozen at ship ─────────────────────────────────────────────────── */
		name: text('name').notNull(),
		description: text('description'),
		repoUrl: text('repo_url'),
		demoUrl: text('demo_url'),
		screenshotUrl: text('screenshot_url'),
		hackatimeProjects: text('hackatime_projects'),
		/** Software or hardware, frozen at ship: Ari's `track`, which picks its
		 *  review queue. Null on submissions shipped before it was frozen. */
		kind: projectKind('kind'),
		aiDeclaration: text('ai_declaration'),
		/** The owner's "this is an update to something that already existed"
		 *  declaration, frozen at ship. Non-null is the mark; see the project
		 *  column of the same name. Fills the [UPDATE] justification on a project
		 *  Phantom's own history would not have called an update. */
		updateDeclaration: text('update_declaration'),
		/** The owner's free note to the reviewer, frozen at ship. Shown on the
		 *  review panel as context; it is the submitter's own words and nothing
		 *  downstream reads it as a claim. */
		notesForReviewer: text('notes_for_reviewer'),
		/** The shipping address selected at ship time, frozen and encrypted (the
		 *  envelope in lib/crypto.ts). A submission needs one because the
		 *  YSWS/Airtable record does; reading it is PII and is not shown to
		 *  reviewers. */
		shippingEncrypted: text('shipping_encrypted'),
		/** Cumulative Hackatime seconds for the linked projects at ship time. The
		 *  new-work delta is this minus the last approved submission's claim. */
		claimedSeconds: bigint('claimed_seconds', { mode: 'number' }).notNull(),
		/** The submitter's "what did you add since the last ship?" answer, on an
		 *  update ship. Null on a first ship. Fills the [UPDATE] justification. */
		changelog: text('changelog'),

		state: submissionState('state').notNull().default('pending'),
		stateAt: timestamp('state_at', { withTimezone: true }).notNull().defaultNow(),
		/** Legacy: when an on-platform change request lapsed into a rejection.
		 *  Change requests are Ari's now and have no deadline, so nothing sets
		 *  this. */
		changesDueAt: timestamp('changes_due_at', { withTimezone: true }),

		/** Legacy: the review desk's claim - who had a submission open, and
		 *  until when. Ari keeps its own claims; nothing sets these now. */
		claimedBy: uuid('claimed_by').references(() => users.id, { onDelete: 'set null' }),
		claimedUntil: timestamp('claimed_until', { withTimezone: true }),

		/* ── the review decision ────────────────────────────────────────────── */
		/** Who decided it on Ari, when they have a Phantom account (matched by
		 *  Slack id). Null when they have none - the transition's metadata keeps
		 *  Ari's own record of them either way. On older submissions, the
		 *  on-platform first-pass reviewer. */
		reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
		/** On older submissions, the admin who confirmed the approval. Ari's
		 *  decisions set it to the same person as `reviewerId`. */
		approverId: uuid('approver_id').references(() => users.id, { onDelete: 'set null' }),
		/** Hours granted, in seconds: what the award posted, which is Ari's
		 *  approved minutes, as decided. */
		awardedSeconds: bigint('awarded_seconds', { mode: 'number' }),
		/** The message the author sees: Ari's note to the maker. */
		publicMessage: text('public_message'),
		/** The internal Review Justification that goes to Airtable, assembled
		 *  from Ari's justification. Reviewer-only; the author's view never
		 *  reads it. */
		justification: text('justification'),

		/* ── hyper-chroma ───────────────────────────────────────────────────── */
		/** Marked exceptionally good: Ari's `hyper_chroma` review checkbox,
		 *  ticked on the approval, or set by hand on Phantom since. Only counts
		 *  while the ship is approved - a project is hyper-chroma while any of
		 *  its approved ships is, so taking the approval back takes the mark
		 *  with it. Ari can add it but never take it off: an approval with the
		 *  box unticked leaves it as it was. See projects/hyper-chroma.ts. */
		hyperChroma: boolean('hyper_chroma').notNull().default(false),
		/** When the current mark was set, which orders explore's "featured
		 *  projects" panel. Null while unmarked. */
		hyperChromaAt: timestamp('hyper_chroma_at', { withTimezone: true }),
		/** Who set the current mark: the Ari reviewer's account, when they have
		 *  one, or the person who marked it by hand. The audit log keeps every
		 *  change; this is only the latest. */
		hyperChromaById: uuid('hyper_chroma_by').references(() => users.id, {
			onDelete: 'set null'
		}),

		/* ── legacy: the review desk's lookups ──────────────────────────────── */
		/* Legacy, kept for history on the submissions that have them; nothing
		   writes these since review moved to Ari. */
		unifiedCheck: jsonb('unified_check').$type<JsonObject>(),
		unifiedCheckedAt: timestamp('unified_checked_at', { withTimezone: true }),
		lapseCheck: jsonb('lapse_check').$type<JsonObject>(),
		lapseCheckedAt: timestamp('lapse_checked_at', { withTimezone: true }),
		aiCodingCheck: jsonb('ai_coding_check').$type<JsonObject>(),
		aiCodingCheckedAt: timestamp('ai_coding_checked_at', { withTimezone: true }),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('submissions_project_idx').on(table.projectId, table.createdAt),
		index('submissions_user_idx').on(table.userId, table.createdAt),
		index('submissions_state_idx').on(table.state, table.stateAt),
		check('submissions_claimed_non_negative', sql`${table.claimedSeconds} >= 0`)
	]
);

/**
 * Every move a submission has made. Append-only, same shape and rules as
 * `order_transitions`: each row names the state left, the state entered, the
 * actor and their role, and a reason. The public reason is what the author reads;
 * the internal note is reviewer-only.
 */
export const submissionTransitions = pgTable(
	'submission_transitions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		submissionId: uuid('submission_id')
			.notNull()
			.references(() => submissions.id, { onDelete: 'cascade' }),
		/** Null only for the ship row. */
		fromState: submissionState('from_state'),
		toState: submissionState('to_state').notNull(),
		actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
		actorRole: userRole('actor_role'),
		reason: text('reason').notNull(),
		internalNote: text('internal_note'),
		metadata: jsonb('metadata').$type<JsonObject>(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('submission_transitions_idx').on(table.submissionId, table.createdAt)]
);

/**
 * Legacy, kept for history on the submissions that have one; nothing writes
 * this since review moved to Ari.
 */
export const commitSnapshots = pgTable('commit_snapshots', {
	submissionId: uuid('submission_id')
		.primaryKey()
		.references(() => submissions.id, { onDelete: 'cascade' }),
	result: jsonb('result').$type<JsonObject>().notNull(),
	takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * Legacy: reviewers' internal comments on a project, from the on-platform
 * review desk. Never shown to the author; still drawn in the project's history
 * for staff. Reviewers comment on Ari now, so nothing writes this.
 */
export const submissionComments = pgTable(
	'submission_comments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		submissionId: uuid('submission_id').references(() => submissions.id, {
			onDelete: 'cascade'
		}),
		authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
		body: text('body').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('submission_comments_idx').on(table.projectId, table.createdAt),
		check('submission_comments_body_present', sql`length(btrim(${table.body})) > 0`)
	]
);

/**
 * The explore projection: one row per project with at least one approved
 * submission, refreshed at approval from the approved submission's snapshot.
 *
 * A projection rather than a live query so the page is cheap and shows each
 * project AS IT WAS APPROVED - editing the working copy afterward changes nothing
 * public until the next approval. PII-free by construction: display fields only,
 * never an address or email.
 *
 * Not the author, either. That used to be copied in as the display name - a
 * real name, on the one page every participant can read - and a copy is also
 * frozen at approval, so fixing it would have meant waiting for every project
 * to be approved again. The author's Slack handle is joined in at read time
 * instead; see listShowcase.
 */
export const projectShowcase = pgTable('project_showcase', {
	projectId: uuid('project_id')
		.primaryKey()
		.references(() => projects.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description'),
	screenshotUrl: text('screenshot_url'),
	demoUrl: text('demo_url'),
	repoUrl: text('repo_url'),
	totalApprovedSeconds: bigint('total_approved_seconds', { mode: 'number' }).notNull().default(0),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * Upvotes on explore: one row per person per project, so a vote cannot be
 * counted twice and taking it back is deleting the row. Only projects on
 * explore - with an approved ship - can be upvoted, and not by their owner;
 * see projects/upvotes.ts.
 */
export const projectUpvotes = pgTable(
	'project_upvotes',
	{
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.projectId, table.userId] })]
);

/* ── activity ────────────────────────────────────────────────────────────── */

/**
 * One row per user per UTC day that the `hackatime.activity` job has asked
 * Hackatime about - what daily active users is counted from.
 *
 * A row is written for an inactive day too, with `active` false, because the
 * row is also the job's memory of what it has already asked: without it, the
 * backfill could not tell "checked, and nothing was logged" from "never
 * checked", and would ask again about every quiet day on every run.
 *
 * "Active" means a heartbeat that day in any Hackatime project linked to any of
 * the user's Phantom projects, drafts included. It is read against the links as
 * they stand when the day is checked, so a project linked later is not counted
 * backwards into days already settled.
 */
export const hackatimeActivity = pgTable(
	'hackatime_activity',
	{
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		/** The UTC calendar day, the same boundary the console's other per-day
		 *  series use. */
		day: date('day', { mode: 'string' }).notNull(),

		active: boolean('active').notNull(),

		/** Hackatime's total for the linked projects on that day. Zero with
		 *  `active` true is a real answer: heartbeats too sparse to add up to
		 *  counted time. */
		seconds: integer('seconds').notNull().default(0),

		/** When Hackatime was last asked. A day is only settled once it was asked
		 *  some while after the day ended, since heartbeats from an editor that
		 *  was offline arrive late; until then the job asks again. */
		checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('hackatime_activity_user_day_idx').on(table.userId, table.day),
		index('hackatime_activity_day_idx').on(table.day)
	]
);

/* ── ari ─────────────────────────────────────────────────────────────────── */

/**
 * Every ship Phantom has sent to Ari, by Ari's id for it.
 *
 * A submission is usually one Ari ship, but not always: when a reviewer asks
 * for changes and the author sends the project back, Ari takes it as a new
 * version of the same project with a new id, and the submission - the same
 * row, by design - now has two. Ari's decisions name the ship they are about,
 * so this is how a decision finds its submission. See lib/server/ari.ts.
 */
export const ariShips = pgTable(
	'ari_ships',
	{
		/** Ari's ship id, as its ingest answered it. Opaque text: the documented
		 *  shape (`AR-4821`) is not the shape Ari actually hands out. */
		ariId: text('ari_id').primaryKey(),
		/* Restrict: a decision that arrives later has to find its submission. */
		submissionId: uuid('submission_id')
			.notNull()
			.references(() => submissions.id, { onDelete: 'restrict' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('ari_ships_submission_idx').on(table.submissionId, table.createdAt)]
);

/**
 * Every delivery Ari's outbound webhook has made, verified, by its delivery id.
 *
 * Two jobs. It is the dedupe Ari asks for - a retry carries the same delivery
 * id, and the row is written in the same transaction as what the delivery did,
 * so a retry of one that was applied finds it and stops. And it is the record
 * of what each delivery did (`outcome`), which is where an operator looks when
 * Phantom and Ari disagree: an `ignored` row is a decision that did not fit
 * the submission as Phantom had it, and a `waiting` one is an approval held
 * until Ari says the decision is final (see `ari.reconcile`).
 */
export const ariDeliveries = pgTable(
	'ari_deliveries',
	{
		deliveryId: text('delivery_id').primaryKey(),
		event: text('event').notNull(),
		ariId: text('ari_id'),
		externalId: text('external_id'),
		submissionId: uuid('submission_id').references(() => submissions.id, {
			onDelete: 'set null'
		}),
		/** `applied`, `ignored`, `waiting`, or `acknowledged` - an ignored one a
		 *  person has read and dealt with (the console's Ari page). */
		outcome: text('outcome').notNull(),
		/** Why, in a sentence, when it was not simply applied. */
		detail: text('detail'),
		/** The delivery as Ari sent it, parsed. Kept so a `waiting` approval can
		 *  be applied later and so a disagreement can be read without asking
		 *  Ari for its delivery log. */
		body: jsonb('body').$type<JsonObject>().notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('ari_deliveries_outcome_idx').on(table.outcome, table.receivedAt),
		index('ari_deliveries_submission_idx').on(table.submissionId, table.receivedAt)
	]
);

/* ── relations ───────────────────────────────────────────────────────────── */

export const usersRelations = relations(users, ({ many }) => ({
	sessions: many(sessions),
	providerAccounts: many(providerAccounts),
	ledgerAccounts: many(ledgerAccounts),
	orders: many(orders)
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, { fields: [sessions.userId], references: [users.id] })
}));

export const providerAccountsRelations = relations(providerAccounts, ({ one }) => ({
	user: one(users, {
		fields: [providerAccounts.userId],
		references: [users.id]
	})
}));

export const ledgerAccountsRelations = relations(ledgerAccounts, ({ one, many }) => ({
	user: one(users, {
		fields: [ledgerAccounts.userId],
		references: [users.id]
	}),
	entries: many(ledgerEntries)
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
	account: one(ledgerAccounts, {
		fields: [ledgerEntries.accountId],
		references: [ledgerAccounts.id]
	}),
	order: one(orders, {
		fields: [ledgerEntries.orderId],
		references: [orders.id]
	})
}));

export const productsRelations = relations(products, ({ one, many }) => ({
	revisions: many(productRevisions),
	orders: many(orders),
	category: one(productCategories, {
		fields: [products.categoryId],
		references: [productCategories.id]
	})
}));

export const productCategoriesRelations = relations(productCategories, ({ many }) => ({
	products: many(products)
}));

export const productRevisionsRelations = relations(productRevisions, ({ one }) => ({
	product: one(products, {
		fields: [productRevisions.productId],
		references: [products.id]
	})
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
	user: one(users, { fields: [orders.userId], references: [users.id] }),
	product: one(products, {
		fields: [orders.productId],
		references: [products.id]
	}),
	transitions: many(orderTransitions),
	entries: many(ledgerEntries)
}));

export const orderTransitionsRelations = relations(orderTransitions, ({ one }) => ({
	order: one(orders, {
		fields: [orderTransitions.orderId],
		references: [orders.id]
	})
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
	owner: one(users, { fields: [projects.userId], references: [users.id] }),
	submissions: many(submissions)
}));

export const submissionsRelations = relations(submissions, ({ one, many }) => ({
	project: one(projects, {
		fields: [submissions.projectId],
		references: [projects.id]
	}),
	submitter: one(users, { fields: [submissions.userId], references: [users.id] }),
	transitions: many(submissionTransitions)
}));

export const submissionTransitionsRelations = relations(submissionTransitions, ({ one }) => ({
	submission: one(submissions, {
		fields: [submissionTransitions.submissionId],
		references: [submissions.id]
	})
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type ProviderAccount = typeof providerAccounts.$inferSelect;
export type SiteSettings = typeof siteSettings.$inferSelect;
export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductCategory = typeof productCategories.$inferSelect;
export type ProductRevision = typeof productRevisions.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderTransition = typeof orderTransitions.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type UserRole = (typeof userRole.enumValues)[number];
export type Capability = (typeof capability.enumValues)[number];
export type VerificationStatus = (typeof verificationStatus.enumValues)[number];
export type IdentityCheckResult = (typeof identityCheckResult.enumValues)[number];
export type EligibilityDecision = (typeof eligibilityDecision.enumValues)[number];
export type ProviderKind = (typeof providerKind.enumValues)[number];
export type LedgerCurrency = (typeof ledgerCurrency.enumValues)[number];
export type LedgerEntryType = (typeof ledgerEntryType.enumValues)[number];
export type ProductKind = (typeof productKind.enumValues)[number];
export type OrderState = (typeof orderState.enumValues)[number];
export type OutboxStatus = (typeof outboxStatus.enumValues)[number];
export type JobStatus = (typeof jobStatus.enumValues)[number];
export type Project = typeof projects.$inferSelect;
export type ProjectKind = (typeof projectKind.enumValues)[number];
export type NewProject = typeof projects.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type SubmissionTransition = typeof submissionTransitions.$inferSelect;
export type ProjectShowcase = typeof projectShowcase.$inferSelect;
export type ProjectUpvote = typeof projectUpvotes.$inferSelect;
export type SubmissionState = (typeof submissionState.enumValues)[number];
export type AriShip = typeof ariShips.$inferSelect;
export type AriDelivery = typeof ariDeliveries.$inferSelect;
