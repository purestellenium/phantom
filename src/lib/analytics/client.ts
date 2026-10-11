import { init, track } from '@plausible-analytics/tracker';

import { dev } from '$app/environment';

import { type AnalyticsConfig, type Segment, scrubUrl, stringProps } from './shared';

/**
 * The browser half of product analytics. The server half, and the rules about
 * what may go in a property, are in lib/server/analytics.ts - read it first.
 *
 * Started from the root layout with the config its load returns, so a
 * deployment without PLAUSIBLE_DOMAIN never initialises the tracker at all.
 *
 * Pageviews are sent from the layout's afterNavigate rather than by the
 * tracker's own history hook, for two reasons: each one can carry the SvelteKit
 * route id (`/guides/[slug]`), and a navigation that only changes the query
 * string - explore's search box, the shop's filters - is counted as a `filter`
 * event with what was asked for, rather than as another view of the page.
 * Engagement (time on page, scroll depth) still rides on each pageview.
 */

/**
 * Everything the browser counts by name. Pageviews, outbound links, file
 * downloads and form submissions are the tracker's own and are not listed.
 */
export type ClientEvent =
	/** A same-page query change: a search, a filter, a sort. */
	| 'filter'
	/** The home page's invite link, copied. */
	| 'invite.link_copied'
	/** The event invite opened out of its envelope on home. */
	| 'invite.ticket_opened'
	/** A guide scrolled to its end (or short enough to end on screen). */
	| 'guide.finished'
	/** A code block in a guide, copied. */
	| 'guide.code_copied'
	/** A heading in a guide's contents, clicked. */
	| 'guide.toc_clicked'
	/** Explore's infinite scroll fetched another page. */
	| 'explore.loaded_more'
	/** A project opened from explore's "featured projects" panel, the latest
	 *  hyper-chroma ones. */
	| 'explore.hyper_chroma_opened'
	/** The "your project is hyper-chroma" popup, shown to an owner the first
	 *  time they see their project after it was marked; `where` is the
	 *  project page or explore. */
	| 'project.hyper_chroma_introduced'
	/** A question on the landing page's FAQ, opened. */
	| 'faq.opened'
	/** A screen of the new-project flow, reached. */
	| 'project_flow.step'
	/** A page that does not exist, or one that threw. Named as Plausible's
	 *  own 404 goal expects. */
	| '404'
	| 'error';

let started = false;
let segment: Segment | null = null;
let route: string | null = null;

/** Start the tracker. Idempotent - the package throws on a second init. */
export function startAnalytics(config: AnalyticsConfig): void {
	segment = config.segment;
	if (started) return;
	started = true;
	init({
		domain: config.domain,
		endpoint: config.endpoint,
		autoCapturePageviews: false,
		outboundLinks: true,
		fileDownloads: true,
		formSubmissions: true,
		/* On localhost the tracker logs "Ignoring Event" for each one, which is
		   exactly what is wanted while wiring a new event in. */
		logging: dev,
		customProperties: () => ({ ...stringProps(segment ?? {}), ...(route ? { route } : {}) }),
		transformRequest: (payload) => ({
			...payload,
			u: scrubUrl(payload.u),
			r: payload.r ? scrubUrl(payload.r) : payload.r
		})
	});
}

/** A sign-in, an onboarding, a role change: later events carry the new segment. */
export function setSegment(next: Segment): void {
	segment = next;
}

export function trackPageview(routeId: string | null): void {
	if (!started) return;
	route = routeId;
	track('pageview', {});
}

/**
 * Record an event from the browser. A no-op until the tracker is started, so
 * call sites need no guard of their own.
 */
export function trackEvent(
	name: ClientEvent,
	properties: Record<string, string | number | boolean | null | undefined> = {},
	options: { interactive?: boolean } = {}
): void {
	if (!started) return;
	track(name, { props: stringProps(properties), ...options });
}
