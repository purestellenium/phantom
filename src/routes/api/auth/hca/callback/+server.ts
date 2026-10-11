import { eq, sql as raw } from 'drizzle-orm';
import { INVITE_COOKIE, REFERRAL_COOKIE, isInviteCode, isReferralSource } from '$lib/referral';
import type { RequestHandler } from './$types';

import { recordEvent, segmentOf } from '$lib/server/analytics';
import { recordAudits } from '$lib/server/audit';
import { BOOTSTRAP_CAPABILITIES, capabilityArrayLiteral } from '$lib/server/auth/capabilities';
import { deriveEligibility } from '$lib/server/auth/eligibility';
import {
	checkHcaIdentity,
	exchangeHcaCode,
	fetchHcaAddresses,
	fetchHcaIdentity,
	HcaError,
	HcaMissingEmail
} from '$lib/server/auth/hca';
import { fetchSlackProfile } from '$lib/server/effects/slack';
import {
	browserStartedFlow,
	consumeOauthState,
	describeStateMismatch,
	forgetStateInBrowser,
	redirectWith,
	safeRedirectPath
} from '$lib/server/auth/oauth';
import {
	clientIpFrom,
	createSession,
	getSession,
	rotateExistingSession,
	setSessionCookie
} from '$lib/server/auth/session';
import { bindings, encryptToken } from '$lib/server/crypto';
import { db } from '$lib/server/db/client';
import { providerAccounts, users } from '$lib/server/db/schema';
import { env } from '$lib/server/env';
import { nudgeOutbox } from '$lib/server/jobs';
import { enqueue } from '$lib/server/outbox';
import { qualifyReferral } from '$lib/server/referrals';

/**
 * The sign-in callback.
 *
 * Read in order, this route is a sequence of refusals followed by exactly one
 * commit. Nothing is written until the state has been spent, the code has been
 * exchanged, and HCA has told us who this is - so a failure at any point leaves
 * no partial account behind, and the single transaction at the end means the
 * user row, the stored credentials and the session either all exist or none of
 * them do.
 *
 * What this route deliberately does NOT contain is a launch check. That
 * happened at the start route. Checking here would mean completing the entire
 * round trip, creating a session and then deleting it - which is both a wasted
 * user journey and a race with anything that had already read the new session.
 */

/** Short codes for the page to turn into a sentence. The detail goes to the
 *  server log; a query string is not a place for provider error prose. */
type Failure = 'denied' | 'bad_state' | 'expired' | 'provider_error' | 'rate_limited' | 'no_email';

/* Always back to the front door, never to the flow's stored `redirectTo`. The
   user is not signed in, so the page they were heading for would bounce them
   here anyway - and it would arrive without the error code, losing the only
   explanation we have. */
function fail(code: Failure) {
	recordEvent('signin.failed', { reason: code });
	return redirectWith('/', { auth_error: code });
}

/* A callback that cannot be verified, arriving in a browser that is already
   signed in, is almost always the second half of a double submit - the first
   one worked. Sending that person to an error about a sign-in they just
   completed is the wrong answer; nothing is written, so it is safe to wave
   them on. */
function alreadySignedIn() {
	return getSession() ? redirectWith('/home') : null;
}

export const GET: RequestHandler = async ({ request, url, cookies }) => {
	const params = url.searchParams;

	/* The user pressed "no" on the consent screen, or HCA refused the request.
     Not an error on our side and not worth a scary page - but the state row is
     left to expire on its own rather than being consumed, because we did not
     get a callback we can trust the identity of. */
	const providerError = params.get('error');
	if (providerError === 'access_denied') {
		/* A person's choice, not a fault: info, and worded so a log parser that
		   files anything saying "error" as one leaves it alone. */
		console.info('hca sign-in declined at the consent screen');
		return fail('denied');
	}
	if (providerError) {
		console.warn(
			`hca callback returned an error: ${providerError} ` +
				`(${params.get('error_description') ?? 'no description'})`
		);
		return fail('provider_error');
	}

	const state = params.get('state');
	const code = params.get('code');

	if (!state || !code) return fail('bad_state');

	/**
	 * Both halves of state validation, and both are required.
	 *
	 * The cookie proves this browser is the one that started the flow, which is
	 * what stops an attacker from getting a victim to complete THEIR login and
	 * ending up signed in as the attacker. The database row proves the flow is
	 * one we started and has not been completed already. Neither alone is
	 * enough: a cookie can be replayed from a captured request, and a row says
	 * nothing about which browser is presenting it.
	 */
	if (!(await browserStartedFlow('hca', state))) {
		console.warn(
			`hca callback: state did not match any flow this browser started ` +
				`(${await describeStateMismatch('hca')}${getSession() ? ', already signed in' : ''})`
		);
		return alreadySignedIn() ?? fail('bad_state');
	}

	const consumed = await consumeOauthState(state, 'hca');

	/* Cleared whether or not the row was spendable. Leaving a dead marker in the
     browser only means the next replay of the same URL gets one step further
     before being refused. */
	await forgetStateInBrowser('hca', state);

	if (!consumed.ok) {
		console.warn(`hca callback: state rejected (${consumed.reason})`);
		if (consumed.reason === 'expired') return fail('expired');
		return alreadySignedIn() ?? fail('bad_state');
	}

	const flow = consumed.row;
	/* Same fallback as the start route, for the same reason: `/` forwards a
     signed-in visitor only when the launch gate admits them, so finishing a
     sign-in there costs a hop at best and strands a refused user on the page
     they started from at worst. The row normally carries a resolved path
     already; this is what covers a row that does not. */
	const redirectTo = safeRedirectPath(flow.redirectTo, '/home');

	try {
		/* The verifier is sent only if a challenge went out. `hcaUsesPkce` decides
       that at the start route from discovery, and the row's verifier is stored
       either way - so this reads the flow's actual shape rather than
       re-deriving it and risking a mismatch if discovery changed mid-flow. */
		const tokens = await exchangeHcaCode({
			code,
			codeVerifier: flow.codeVerifier
		});

		const identity = await fetchHcaIdentity(tokens.accessToken);

		/* Together, because neither needs the other: both want `identity` and
		   nothing else, and awaited one after the other they were two round trips
		   to two different companies with a person watching a blank tab through
		   both of them. */
		const [checkResult, slack] = await Promise.all([
			/**
			 * The second call, and the reason this app asks HCA the same question
			 * twice.
			 *
			 * `verification_status` says whether an approved verification exists. It
			 * does not say whether the person is young enough to qualify, and
			 * verified adults are routinely `verified` and ineligible at the same
			 * time. This endpoint answers eligibility directly. Both answers are
			 * stored, with their own timestamps, and only `deriveEligibility` is
			 * allowed to combine them.
			 */
			checkHcaIdentity(identity.subject),
			/**
			 * The picture HCA itself does not carry, and the handle with it: as of this writing its userinfo
			 * response has no `picture` claim at all, for any scope, so
			 * `identity.avatarUrl` is reliably null. Slack is where the actual photo
			 * lives, and `slack_id` - which HCA does release - is the lookup key.
			 *
			 * Best-effort and refreshed every sign-in, same as every other identity
			 * signal below. `fetchSlackProfile` never throws; a null here means
			 * "unconfigured, unreachable, or no photo on file", not "remove the one
			 * already stored" - see the coalesce below, and the function's own doc
			 * for why that distinction is the point.
			 */
			identity.slackId ? fetchSlackProfile(identity.slackId) : null
		]);
		const slackAvatarUrl = slack?.avatarUrl ?? null;
		const slackUsername = slack?.username ?? null;

		const eligibility = deriveEligibility({
			verificationStatus: identity.verificationStatus,
			yswsEligibleClaim: identity.yswsEligibleClaim,
			identityCheckResult: checkResult,
			birthdate: null
		});

		const now = new Date();

		/**
		 * The bootstrap, and the only time an environment variable touches a role.
		 *
		 * It can promote and it cannot demote: removing someone from
		 * ADMIN_HCA_SUBJECTS does not take their admin away, because the column is
		 * the authority and a variable that could silently revoke access on a
		 * deploy would be a second source of truth wearing a disguise. Demotion is
		 * an edit to the row.
		 *
		 * It also seeds the capabilities an admin role does NOT imply - `view_pii`
		 * and `adjust_ledger` - and this is the answer to "who grants the first
		 * grant". Without it the explicit-only list is unreachable: nobody holds
		 * them, `canGrant` therefore refuses everyone, and the first ledger
		 * correction needs a psql session. The people named in the environment at
		 * deploy time hold everything this application implements; everyone else is
		 * granted upward, by name, by one of them.
		 *
		 * See BOOTSTRAP_CAPABILITIES in lib/auth/capabilities.ts for what is in the
		 * set and why `manage_fraud` is not.
		 */
		/* OWNER_HCA_SUBJECTS is the same bootstrap one rank up, and the answer to who
		   appoints the first owner: `canActOn` refuses acting on an equal rank, so an
		   owner can only be made by another owner - with none, the first would need a
		   psql session. Owner outranks admin (a subject in both lists is seeded owner)
		   and needs no capability seeding, because its role already implies every one. */
		const seedsOwner = env.OWNER_HCA_SUBJECTS.includes(identity.subject);
		const seedsAdmin = env.ADMIN_HCA_SUBJECTS.includes(identity.subject);

		const outcome = await db.transaction(async (tx) => {
			const [existing] = await tx
				.select({ id: users.id, role: users.role })
				.from(users)
				.where(eq(users.hcaSubject, identity.subject))
				.limit(1);

			/* Every identity signal is refreshed with its own timestamp on every
         login. Note that a failed check writes `unavailable` and therefore an
         `undetermined` decision, even for someone who was eligible an hour ago.
         That is the intended direction: an outage suspends access rather than
         extending a stale grant, and the next successful login restores it. */
			const invited = cookies.get(INVITE_COOKIE);
			const inviteCode = isInviteCode(invited) ? invited : null;

			const identityColumns = {
				email: identity.email,
				displayName: identity.displayName,
				/* Slack over HCA's own claim, which is empty in practice - see the
				   comment above `slackAvatarUrl`. Correct for the insert arm below, a
				   brand new row has nothing to preserve. The update arms override this
				   with a coalesce against the stored value instead, so a fetch that
				   came back null does not erase a photo that is still real. */
				avatarUrl: slackAvatarUrl ?? identity.avatarUrl,
				/* Same shape as the avatar and for the same reason: correct on the
				   insert arm, overridden with a coalesce on the update arms. A
				   deployment whose Program has not been granted `birthdate` yet reads
				   the claim as absent, and plain assignment would wipe a date that had
				   already been captured. */
				birthdate: identity.birthdate,
				slackId: identity.slackId,
				/* Same as the avatar: correct for the insert arm, coalesced on the
				   update arms so a Slack hiccup does not blank the name on explore. */
				slackUsername,
				verificationStatus: identity.verificationStatus,
				verificationStatusAt: now,
				yswsEligibleClaim: identity.yswsEligibleClaim,
				yswsEligibleClaimAt: now,
				identityCheckResult: checkResult,
				identityCheckAt: now,
				eligibility: eligibility.decision,
				eligibilityAt: now,
				eligibilityRule: eligibility.rule,
				updatedAt: now,
				lastSeenAt: now
			};

			/* The update arms' override for `avatarUrl`: refresh it when this
			   sign-in found a photo, keep whatever is already stored when it did
			   not. Plain replacement - what `identityColumns.avatarUrl` does for
			   the insert arm - would mean a single Slack hiccup during a login
			   clears a perfectly good cached avatar, which is worse than serving a
			   sign-in-old one. */
			const refreshedAvatarUrl = raw`coalesce(${slackAvatarUrl}::text, ${users.avatarUrl})`;

			/* The columns every update arm has to preserve rather than replace, in
			   one object so another cannot be added to two arms and forgotten in the
			   third. */
			const preserved = {
				avatarUrl: refreshedAvatarUrl,
				slackUsername: raw`coalesce(${slackUsername}::text, ${users.slackUsername})`,
				birthdate: raw`coalesce(${identity.birthdate}::date, ${users.birthdate})`
			};

			const [user] = await tx
				.insert(users)
				.values({
					hcaSubject: identity.subject,
					/* Only ever on the insert: a returning person's account keeps the
					   source it was created with. Re-checked against the allowlist, so a
					   hand-edited cookie cannot write anything else. */
					referralSource: isReferralSource(cookies.get(REFERRAL_COOKIE))
						? cookies.get(REFERRAL_COOKIE)
						: null,
					/* Likewise insert-only: who invited them, resolved from the code
					   here so an unknown code is simply nobody. Can never be this
					   account - it does not exist yet. */
					referredByUserId: inviteCode
						? raw`(select ${users.id} from ${users} where ${users.inviteCode} = ${inviteCode})`
						: null,
					role: seedsOwner ? 'owner' : seedsAdmin ? 'admin' : 'participant',
					/* Owner implies every capability through its role, so its additive
					   column stays empty; only admin needs the bootstrap set granted. */
					capabilities: seedsOwner ? [] : seedsAdmin ? [...BOOTSTRAP_CAPABILITIES] : [],
					...identityColumns
				})
				/* The unique index on `hca_subject` is what makes a repeat login - or a
           slow callback racing itself - an update instead of a second account
           for the same person. */
				.onConflictDoUpdate({
					target: users.hcaSubject,
					set: seedsOwner
						? {
								...identityColumns,
								...preserved,
								/* Owner is the top rank, so setting it is always a promotion or
								   a no-op - no `case` guard the way the admin branch needs one,
								   because there is nothing above it to demote. Capabilities are
								   left untouched: the role already implies every one, and this
								   variable is a floor that never strips a grant a colleague
								   added. */
								role: raw`'owner'::user_role`
							}
						: seedsAdmin
							? {
									...identityColumns,
									...preserved,
									/* Promote, never demote - the same asymmetry as the capability
                   union below, and it stopped being free the moment a rank
                   above admin existed. Written flat as `admin`, this knocked an
                   OWNER who is also named in ADMIN_HCA_SUBJECTS back down to
                   admin on their own next sign-in, which is the demotion the
                   comment above promises cannot happen here. */
									role: raw`case when ${users.role} = 'owner' then ${users.role} else 'admin'::user_role end`,
									/* Union rather than replace. A bootstrap admin who was granted
                   something extra by a colleague keeps it across their next
                   sign-in, and one whose capabilities were deliberately
                   narrowed gets the bootstrap set back - which is the intended
                   asymmetry: this variable is a floor, never a ceiling, for the
                   same reason it can promote and cannot demote. */
									capabilities: raw`(
                  select coalesce(array_agg(distinct value), '{}')
                  from unnest(
                    ${users.capabilities} || ${capabilityArrayLiteral(BOOTSTRAP_CAPABILITIES)}::capability[]
                  ) as value
                )`
								}
							: { ...identityColumns, ...preserved }
				})
				.returning();

			await tx
				.insert(providerAccounts)
				.values({
					userId: user.id,
					provider: 'hca',
					providerAccountId: identity.subject,
					/* Bound to (user, provider, column), which is the unique index on
             this table - so the ciphertext cannot be lifted into another
             person's row, or from the refresh column into the access one, and
             still open. */
					accessTokenEncrypted: encryptToken(
						tokens.accessToken,
						bindings.providerToken(user.id, 'hca', 'access_token')
					),
					refreshTokenEncrypted: tokens.refreshToken
						? encryptToken(
								tokens.refreshToken,
								bindings.providerToken(user.id, 'hca', 'refresh_token')
							)
						: null,
					/* Granted, not requested. A Program configured with fewer scopes than
             HCA_SCOPES asks for is a supported situation, and recording what we
             actually hold is what lets a later call explain its own 403. */
					scope: tokens.scope,
					accessTokenExpiresAt: tokens.expiresAt,
					profile: {
						sub: identity.subject,
						email: identity.email,
						name: identity.displayName,
						slack_id: identity.slackId
					}
				})
				.onConflictDoUpdate({
					target: [providerAccounts.userId, providerAccounts.provider],
					set: {
						providerAccountId: identity.subject,
						accessTokenEncrypted: encryptToken(
							tokens.accessToken,
							bindings.providerToken(user.id, 'hca', 'access_token')
						),
						refreshTokenEncrypted: tokens.refreshToken
							? encryptToken(
									tokens.refreshToken,
									bindings.providerToken(user.id, 'hca', 'refresh_token')
								)
							: null,
						scope: tokens.scope,
						accessTokenExpiresAt: tokens.expiresAt,
						updatedAt: now
					}
				});

			/**
			 * Into the Phantom channel, once per account.
			 *
			 * Enqueued rather than called: this is inside the transaction that
			 * creates the account, and an invitation that fires before the row
			 * commits is an invitation to somebody who does not exist yet. The
			 * worker picks it up a moment later, which also means a Slack outage
			 * costs the sign-in nothing - see lib/outbox.ts on why nothing fallible
			 * happens inline.
			 *
			 * The dedupe key is the account, with no timestamp in it, so this is
			 * once ever and not once per sign-in: somebody who leaves the channel
			 * has left it on purpose, and an app that puts them back every time they
			 * log in is an app arguing with them. The flip side is that an account
			 * created before this existed is invited at its next sign-in, since no
			 * row has ever been written for it.
			 *
			 * Guarded on the id because an invite needs one, and HCA only releases
			 * `slack_id` for someone who has Slack linked at Hack Club. Nothing is
			 * owed for an account that does not - and the next sign-in after they
			 * link it enqueues this properly.
			 */
			if (identity.slackId) {
				await enqueue(
					{
						effect: 'slack.channel_invite',
						dedupeKey: `user:${user.id}:slack_invite`,
						/* A reference, not a copy: the handler reads the Slack id off the
						   row when it runs. See the rules at the top of lib/effects. */
						payload: { userId: user.id }
					},
					tx
				);
			}

			/**
			 * Session fixation, closed here.
			 *
			 * Whatever session identifier this browser was carrying a moment ago is
			 * revoked before a new one is minted, and the new token is fresh random
			 * bytes rather than the old value re-blessed. An attacker who managed to
			 * plant a session cookie on the victim's browser is left holding a
			 * revoked row.
			 */
			await rotateExistingSession(tx);

			const session = await createSession(
				{
					userId: user.id,
					userAgent: request.headers.get('user-agent'),
					ip: clientIpFrom(request.headers)
				},
				tx
			);

			/* On the same connection as the change it describes, so an audit row
         cannot survive a rollback of the login it records - and in ONE
         statement, because three inserts is three round trips inside a
         transaction somebody is waiting on. The order in the array is the order
         they are written, so the account still precedes the identity it
         observed and the session it opened. */
			await recordAudits(
				[
					...(existing
						? []
						: [
								{
									action: 'user.created',
									subjectId: user.id,
									metadata: { provider: 'hca', seededAdmin: seedsAdmin, seededOwner: seedsOwner }
								}
							]),
					{
						action: 'identity.observed',
						subjectId: user.id,
						metadata: {
							verificationStatus: identity.verificationStatus,
							yswsEligibleClaim: identity.yswsEligibleClaim,
							identityCheckResult: checkResult,
							eligibility: eligibility.decision,
							eligibilityRule: eligibility.rule,
							grantedScope: tokens.scope
						}
					},
					{
						action: 'session.created',
						actorId: user.id,
						subjectId: user.id,
						metadata: { sessionId: session.sessionId, provider: 'hca' }
					}
				],
				tx
			);

			/* `existed` rather than the row: whether this sign-in created the
         account is the only thing outside the transaction needs, and it is
         read before the upsert so it still means what it says. */
			return { user, session, existed: Boolean(existing) };
		});

		await setSessionCookie(outcome.session.token, outcome.session.expiresAt);

		/* This sign-in may be the one that found an invited person eligible. */
		await qualifyReferral(outcome.user.id);

		/* The account committed, so the Slack invite enqueued inside that
		   transaction can go now - a first sign-in is exactly the moment somebody
		   is waiting to be let into the channel, and waiting on the next scheduled
		   dispatch to do it is the difference between arriving and arriving five
		   minutes ago. Not awaited; see nudgeOutbox. */
		nudgeOutbox();

		/* Read the address list once per sign-in, which stores the country the
		   shop hides region-blocked items by (see rememberCountry). Not awaited:
		   nobody should wait on HCA a second time to get in, and a failure only
		   leaves the country as it was. */
		void fetchHcaAddresses(outcome.user.id, { fresh: true }).catch(() => {});

		/* `existing` was read inside the transaction before the upsert, so this is
       whether the account is new rather than whether this login is. Both are
       shapes of the event, not identifiers. */
		recordEvent('signin.completed', {
			/* The session cookie was only just set, so the request's own segment
			   still reads anonymous; this account's goes in its place. */
			...segmentOf(outcome.user),
			new_user: !outcome.existed,
			eligibility: eligibility.decision
		});

		/* Onboarding wins over the stored return path. Someone who has not finished
       it cannot use the page they were heading for anyway, and sending them
       there first only produces a redirect they did not ask for. */
		const destination = outcome.user.onboardedAt ? redirectTo : '/onboarding';

		return redirectWith(destination);
	} catch (error) {
		/* Nothing was committed - the transaction is the only writer above, and it
       either succeeded or rolled back whole. So there is no cleanup here, and
       specifically no session to delete. */
		console.error('hca callback failed', error);

		if (error instanceof HcaMissingEmail) return fail('no_email');
		if (error instanceof HcaError && error.status === 429) return fail('rate_limited');
		return fail('provider_error');
	}
};
