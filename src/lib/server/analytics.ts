import { getRequestEvent } from '$app/server';

import {
	ANONYMOUS,
	type AnalyticsConfig,
	type Segment,
	isoWeek,
	scrubUrl,
	stringProps
} from '$lib/analytics/shared';
import type { SessionUser } from '$lib/server/auth/session';
import { plausibleConfig } from '$lib/server/env';

/**
 * Product events, sent to Plausible through its Events API.
 *
 * The server half. The browser half (lib/analytics/client.ts) counts pageviews,
 * outbound links, downloads and the interactions that never reach the server -
 * a copied invite link, a guide read to the end, a search on explore. This half
 * counts outcomes: the moment a sign-in, a ship, a purchase or an upvote
 * actually committed. Sent from here they cannot be blocked by an ad blocker,
 * and they are counted only when the thing happened rather than when a button
 * was pressed.
 *
 * On for phantom.hackclub.com with nothing to set, and off for every other
 * host unless PLAUSIBLE_DOMAIN says otherwise - see plausibleConfig.
 *
 * This is NOT the audit log, and the difference is worth stating because the
 * two record overlapping moments. lib/audit.ts writes rows that answer "what
 * happened to this account, and who did it" - they name a subject, they are
 * evidence, and they are kept. These answer "how many people got through the
 * front door this week", they name nobody, and losing one costs a rounding
 * error on a chart. Where a moment deserves both, it gets both, and neither
 * call is derived from the other.
 *
 * Nothing identifying goes in a property bag. No email, no user id, no HCA
 * subject, no order id, no invite code - a funnel is counted in aggregate, and
 * an identifier here would put PII in a third-party product that has no
 * business holding it and no retention policy we control (Plausible's terms
 * forbid it too). What goes in is the shape of the event: a reason code, a
 * boolean, a count, a product kind - plus the visitor's Segment, which says
 * what kind of person did it and never which one.
 */

/**
 * The whole vocabulary, in one place.
 *
 * A union rather than a loose string, because an event name typed slightly
 * differently at one call site does not fail - it quietly becomes a second
 * series on the dashboard that looks like a drop in the first.
 */
export type ProductEvent =
	/** Somebody arrived on a participant's invite link or a partner's link,
	 *  signed out, for the first time in the cookie's thirty days. */
	| 'referral.arrived'
	/** An email went onto the pre-launch waiting list. */
	| 'waitlist.joined'
	/** A sign-in began: the state row is written and the browser is on its way
	 *  to HCA. The denominator for everything below. */
	| 'signin.started'
	/** …and came back with an identity. */
	| 'signin.completed'
	/** …and did not. Carries the same short reason the page shows. */
	| 'signin.failed'
	/** Setup finished, which is the point someone becomes a participant rather
	 *  than an account. */
	| 'onboarding.finished'
	/** An invited person became eligible and onboarded, so their inviter's
	 *  count went up. */
	| 'referral.qualified'
	/** Hackatime attached to an existing user. */
	| 'hackatime.linked'
	| 'hackatime.link_failed'
	/** "check again" on the verification notice. */
	| 'eligibility.rechecked'
	/** A default shipping address chosen, in setup or on the account page. */
	| 'address.chosen'
	| 'sessions.revoked_others'
	| 'project.created'
	| 'project.shipped'
	/** Requested changes made, and the submission put back in the queue. */
	| 'project.resubmitted'
	| 'project.archived'
	| 'project.unarchived'
	| 'project.deleted'
	/** Staff with manage_fraud let a project ship again. */
	| 'project.fraud_lifted'
	/** An upvote cast or taken back. */
	| 'project.upvoted'
	/** Staff with approve_submissions marked an approved ship hyper-chroma by
	 *  hand, or took the mark off (`on`). Ari's own marks arrive by webhook,
	 *  outside a request, and are counted from the table instead. */
	| 'project.hyper_chroma_changed'
	/** Something was bought. */
	| 'order.placed'
	/** An order moved: cancelled by its owner, or held, fulfilled, rejected… by staff. */
	| 'order.transitioned'
	| 'signout';

type Properties = Record<string, string | number | boolean | null | undefined>;

/** The segment for a signed-in account. See Segment in lib/analytics/shared.ts. */
export function segmentOf(user: SessionUser | null | undefined): Segment {
	if (!user) return ANONYMOUS;
	return {
		signed_in: 'yes',
		role: user.role,
		onboarded: user.onboardedAt ? 'yes' : 'no',
		eligibility: user.eligibility,
		arrived_via: user.referredByUserId ? 'invite' : (user.referralSource ?? 'direct'),
		cohort: isoWeek(user.createdAt)
	};
}

/** What the root layout gives the browser tracker, or null when analytics are off. */
export function analyticsConfig(
	host: string,
	user: SessionUser | null | undefined
): AnalyticsConfig | null {
	const config = plausibleConfig(host);
	return config ? { ...config, segment: segmentOf(user) } : null;
}

/**
 * Record an event. Fire-and-forget: callers do not await it, and a failure is
 * swallowed - an analytics outage must never fail the request it rides on.
 *
 * Plausible counts unique visitors by the client's address and user agent, so
 * both are forwarded from the request being served. Outside a request (a job,
 * a webhook) there is no visitor to attribute it to, and nothing is sent; those
 * moments are counted from the tables instead (lib/server/funnel.ts).
 *
 * The address comes from X-Forwarded-For when a proxy set one, which is how
 * Orchard serves this, and from the socket otherwise. Set ADDRESS_HEADER for
 * adapter-node and the socket answer is right as well.
 */
export function recordEvent(name: ProductEvent, properties: Properties = {}): void {
	let event;
	try {
		event = getRequestEvent();
	} catch {
		return;
	}

	const config = plausibleConfig(event.url.hostname);
	if (!config) return;

	const userAgent = event.request.headers.get('user-agent');
	if (!userAgent) return;
	let address = event.request.headers.get('x-forwarded-for');
	if (!address) {
		try {
			address = event.getClientAddress();
		} catch {
			address = null;
		}
	}

	const body = {
		name,
		domain: config.domain,
		url: scrubUrl(event.url.href),
		props: stringProps({
			...segmentOf(event.locals.session?.user),
			route: event.route.id,
			...properties
		})
	};

	void fetch(config.endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': userAgent,
			...(address ? { 'X-Forwarded-For': address } : {})
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5000)
	}).catch(() => {
		/* A lost event is a rounding error on a chart; see above. */
	});
}
