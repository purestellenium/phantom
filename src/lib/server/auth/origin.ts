import { getRequestEvent } from '$app/server';

import type { ProviderName } from '$lib/server/env';

/**
 * Where this instance is running, taken from the request it is answering.
 *
 * There is deliberately no APP_URL. A variable holding our own address is a
 * second copy of a fact the request already carries, and the two drift: a
 * preview deployment sends people to production's callback, a renamed domain
 * breaks every login until someone remembers the dashboard, and local
 * development needs its own value that must never reach production. The request
 * is right by construction, in every environment, with nothing to set.
 *
 * The usual objection is Host header spoofing, and it is worth stating exactly
 * what it can and cannot do here.
 *
 *   - Internal redirects never use this. They are relative (see redirectWith in
 *     lib/auth/oauth.ts), so a forged Host cannot point one off-origin.
 *   - The one place the origin becomes an absolute URL is `redirect_uri`, and
 *     both providers check that value against their registered list before
 *     anything happens. A forged host produces a refused authorization, not a
 *     leaked code - the attacker breaks their own flow and learns nothing.
 *
 * So the header decides the address and the provider decides whether to believe
 * it, which is the same arrangement every host-derived OAuth client uses -
 * OneKey does exactly this for its own Hackatime callback.
 */

/** Headers arrive comma-joined when more than one proxy has appended to them.
 *  The first entry is the one nearest the client, which is the one describing
 *  the connection the browser actually made. */
function first(value: string | null): string | null {
	if (!value) return null;
	const head = value.split(',')[0]?.trim();
	return head && head.length > 0 ? head : null;
}

/**
 * A host we are willing to put in a URL.
 *
 * Validated with a pattern rather than by parsing, because this string is
 * concatenated into a URL and a header value is attacker-supplied by
 * definition. Anything carrying a slash, a credential, a space or a control
 * character is refused outright rather than normalised into something
 * surprising.
 */
const HOST_PATTERN = /^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export class OriginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OriginError';
	}
}

/**
 * This instance's origin, with no trailing slash.
 *
 * `x-forwarded-*` wins over `host` because behind a proxy - which is every
 * deployment - `host` is the internal address the proxy dialled and not the one
 * the browser typed.
 */
export async function currentOrigin(): Promise<string> {
	const store = getRequestEvent().request.headers;

	const host = first(store.get('x-forwarded-host')) ?? first(store.get('host'));
	if (!host) {
		throw new OriginError(
			'The request carried no Host header, so this instance cannot say where it is.'
		);
	}
	if (!HOST_PATTERN.test(host)) {
		throw new OriginError(`Refusing to build a URL from the host ${host}.`);
	}

	/* Only the two schemes that mean anything here. A proxy that reports
     something else is reporting a mistake, and defaulting is safer than
     believing it. */
	const forwarded = first(store.get('x-forwarded-proto'));
	const proto =
		forwarded === 'http' || forwarded === 'https'
			? forwarded
			: LOCAL_HOSTNAMES.has(host.replace(/:\d+$/, ''))
				? 'http'
				: 'https';

	return `${proto}://${host}`;
}

/** Whether cookies set on this request get the `Secure` attribute.
 *
 *  Keyed on the scheme the browser actually used, not on NODE_ENV. `Secure` on
 *  an http origin means the browser drops the cookie entirely, so a production
 *  build run locally over http would silently lose every session - a failure
 *  that looks like "login does nothing". */
export async function originIsSecure(): Promise<boolean> {
	return (await currentOrigin()).startsWith('https://');
}

/**
 * The callback address to hand a provider, and the value to register on their
 * side.
 *
 * Derived rather than configured, so it is right in production, in a preview
 * and on localhost with nothing set. Both places that need it - the authorize
 * redirect and the token exchange, which Doorkeeper compares - call this, so
 * the two cannot drift apart.
 *
 * The admin settings page prints both, because these are the only strings an
 * operator has to copy anywhere.
 */
export async function redirectUri(provider: ProviderName): Promise<string> {
	return `${await currentOrigin()}/api/auth/${provider}/callback`;
}
