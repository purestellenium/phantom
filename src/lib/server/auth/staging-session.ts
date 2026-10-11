import type { RequestEvent } from '@sveltejs/kit';
import { env as runtime } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';

import {
	createSession,
	readSession,
	setSessionCookie,
	type ActiveSession
} from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import { userRole, users, type UserRole } from '$lib/server/db/schema';

/**
 * Staging mode's sign-in: see lib/server/staging.ts for what the mode is and
 * how it is kept out of production.
 */

/** The developer account's subject. Outside HCA's namespace on purpose, the
 *  way the demo seed's `seed:` subjects are, so it can never match a real one. */
const STAGING_SUBJECT = 'staging:developer';

function stagingRole(): UserRole {
	const wanted = runtime.STAGING_ROLE?.trim() || 'owner';
	const role = userRole.enumValues.find((value) => value === wanted);
	if (!role) {
		throw new Error(
			`STAGING_ROLE must be one of ${userRole.enumValues.join(', ')} (got "${wanted}").`
		);
	}
	return role;
}

/**
 * The developer account, created or brought in line with `STAGING_ROLE`.
 *
 * Onboarded and eligible from the start: onboarding is still reachable by
 * clearing `onboarded_at`, but a developer opening the app for the first time
 * wants the app, not the funnel in front of it.
 */
async function ensureStagingUser(): Promise<string> {
	const role = stagingRole();
	const now = new Date();
	const [row] = await db
		.insert(users)
		.values({
			hcaSubject: STAGING_SUBJECT,
			email: 'developer@staging.invalid',
			displayName: 'Staging Developer',
			slackUsername: 'developer',
			verificationStatus: 'verified',
			verificationStatusAt: now,
			yswsEligibleClaim: true,
			yswsEligibleClaimAt: now,
			identityCheckResult: 'verified_eligible',
			identityCheckAt: now,
			eligibility: 'eligible',
			eligibilityAt: now,
			eligibilityRule: 'staging',
			role,
			onboardedAt: now
		})
		.onConflictDoUpdate({ target: users.hcaSubject, set: { role, updatedAt: now } })
		.returning({ id: users.id });
	return row.id;
}

/**
 * The session a staging request runs under: the one its cookie names, or a
 * new one for the developer account.
 *
 * Only called where a session is wanted - the signed-in shell and the log-in
 * route - so the landing page stays reachable signed out, and signing out
 * lands there rather than straight back in.
 */
export async function stagingSession(
	event: RequestEvent,
	existing: ActiveSession | null
): Promise<ActiveSession | null> {
	if (existing) {
		/* Follow STAGING_ROLE without a sign-out, so switching role is an edit to
		   .env and a restart. Only the developer account; anyone else signed in
		   here (a real session from before staging was on) is left as they are. */
		if (existing.user.hcaSubject === STAGING_SUBJECT) {
			const role = stagingRole();
			if (existing.user.role !== role) {
				await db.update(users).set({ role }).where(eq(users.id, existing.user.id));
				existing.user.role = role;
			}
		}
		return existing;
	}

	const userId = await ensureStagingUser();
	const { token, expiresAt } = await createSession({
		userId,
		userAgent: event.request.headers.get('user-agent')
	});
	await setSessionCookie(token, expiresAt);
	return readSession({ get: () => token });
}
