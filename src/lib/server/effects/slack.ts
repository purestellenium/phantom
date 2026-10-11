import type { EffectOutcome } from '$lib/server/outbox';
import {
	isJsonObject,
	parseJson,
	readBoolean,
	readObject,
	readString,
	type JsonObject
} from '$lib/json';
import { env as runtime } from '$env/dynamic/private';

/**
 * Talking to Slack, and - mostly - checking whether it worked.
 *
 * This file is short and almost all of it is error handling, because that is
 * where the failures hide. A helper that awaits `fetch` but inspects neither
 * the HTTP status nor Slack's JSON `ok` makes MANY API FAILURES APPEAR
 * SUCCESSFUL. Slack answers `200 OK` with `{"ok": false,
 * "error": "channel_not_found"}` - a perfectly successful HTTP request that did
 * nothing at all. An integration that only checks the transport reports every
 * one of those as delivered.
 *
 * So there are three checks here, not one: the fetch threw, the status was not
 * 2xx, and the body said `ok: false`. Each maps to a different outcome, because
 * a bad token is not a transient error and retrying it forever is not a
 * strategy.
 */

/** Ten seconds. Nothing here is in front of a user - the worker is running in
 *  the background - but an unbounded fetch is a worker that never finishes its
 *  batch, and the lease would expire under it. */
const SLACK_TIMEOUT_MS = 10_000;

const POST_MESSAGE = 'https://slack.com/api/chat.postMessage';
const CONVERSATIONS_INVITE = 'https://slack.com/api/conversations.invite';

/**
 * The channel every participant is put in when they sign in.
 *
 * Hardcoded rather than configured, because it is not configuration: there is
 * one Phantom channel, it is this one, and a variable holding it would be a
 * second copy of a fact that never changes - the same reasoning env.ts gives
 * for there being no APP_URL. The operator notification channel IS configured
 * (SLACK_CHANNEL_ID) because a deployment genuinely might want its own; nobody
 * wants their own community.
 */
const PHANTOM_CHANNEL = 'C0B3M1T5C3U';

/**
 * Neutralise Slack's own markup in a value we did not write.
 *
 * `text` is not plain text - Slack parses `<...>` out of it, which is how
 * links, user mentions and `<!channel>` are expressed. A participant's display
 * name comes from their HCA profile and is theirs to set, so it arrives here as
 * untrusted input that lands in an operator channel on every order.
 *
 * Left alone, a display name of `<!channel>` broadcasts to everyone in that
 * channel on the attacker's next purchase, and `<https://evil.example|click
 * here>` renders as a link the operators have every reason to trust because it
 * appeared in their own notifications feed.
 *
 * The three characters below are exactly what Slack documents escaping, and
 * ampersand has to go first or it would double-escape the other two.
 */
export function slackEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Slack error codes that will never succeed on a retry.
 *
 * The distinction is the whole reason this list exists. `ratelimited` and
 * `service_unavailable` are worth trying again; `invalid_auth` means the token
 * is wrong and the ten thousandth attempt will also fail, so it becomes a
 * terminal failure that shows up in the console as something an operator has to
 * fix rather than as a row quietly backing off into the distance.
 */
const TERMINAL_SLACK_ERRORS = new Set([
	'invalid_auth',
	'not_authed',
	'account_inactive',
	'token_revoked',
	'token_expired',
	'missing_scope',
	'channel_not_found',
	'not_in_channel',
	'is_archived',
	'invalid_arguments',
	'msg_too_long'
]);

/**
 * The same, for `conversations.invite`, which can refuse in ways a message
 * cannot.
 *
 * Every code here describes the person or the workspace rather than the moment:
 * a Slack account that does not exist, a guest who is not allowed into this
 * channel, a token that is not a bot token. Retrying any of them for the next
 * eight hours produces the same refusal and one red row an operator has to read
 * eight times.
 *
 * `already_in_channel` is deliberately NOT in here, and not in any failure list
 * - see `inviteToPhantomChannel`, where it is a success.
 */
const TERMINAL_INVITE_ERRORS = new Set([
	...TERMINAL_SLACK_ERRORS,
	'cant_invite',
	'cant_invite_self',
	'user_not_found',
	'users_not_found',
	'user_is_ultra_restricted',
	'restricted_action',
	'too_many_users',
	'ura_max_channels',
	'not_allowed_token_type',
	'method_not_supported_for_channel_type'
]);

export type SlackConfig = { token: string; channel: string };

/**
 * Slack's configuration, or null.
 *
 * Null rather than a throw, and the caller turns that into `skipped` rather
 * than a failure. The wiki's rule for a missing integration key is that it
 * produces disabled behaviour, never a bypass and never a page-out - and a
 * deployment that has deliberately not connected Slack should not accumulate a
 * table of red rows about it.
 *
 * Read from the environment on each call rather than at module load, for the
 * same reason lib/env.ts resolves provider config on use: a platform that
 * injects configuration after the first render would otherwise serve a stale
 * "not configured" for the life of the instance.
 */
export function slackConfig(): SlackConfig | null {
	const token = slackToken();
	const channel = runtime.SLACK_CHANNEL_ID?.trim();
	if (!token || !channel) return null;
	return { token, channel };
}

/**
 * The bot token on its own.
 *
 * Separate from `slackConfig` because the channel is not universally required:
 * the avatar lookup and the channel invite both name their own destination, and
 * asking them to wait for SLACK_CHANNEL_ID would mean a deployment that has a
 * bot but has not chosen an operator channel silently stops adding people to
 * the community one.
 */
function slackToken(): string | undefined {
	return runtime.SLACK_BOT_TOKEN?.trim() || undefined;
}

const USERS_INFO = 'https://slack.com/api/users.info';

/** An avatar URL is rendered into an `<img src>`, so anything Slack ever sent
 *  that was not http(s) would be a scripting bug with an upstream-controlled
 *  payload. Same guard hca.ts applies to HCA's own `picture` claim. */
function asHttpUrl(value: string | null): string | null {
	if (value === null) return null;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null;
	} catch {
		return null;
	}
}

export type SlackProfile = { avatarUrl: string | null; username: string | null };

const NO_PROFILE: SlackProfile = { avatarUrl: null, username: null };

/**
 * The profile photo and handle Slack has on file for this person, each or
 * both null.
 *
 * Best-effort and never throws: this runs inline in the sign-in callback, and
 * a Slack outage or a missing bot token must cost the visitor nothing more
 * than an unrefreshed avatar. Null covers every way that can happen -
 * unconfigured, unreachable, rejected, or a shape we do not recognise - and
 * the callback's job is to treat null as "keep whatever is already stored"
 * rather than as "clear it". A cleared avatar on a transient failure is the
 * bug this distinction exists to avoid: the picture used to be there, nothing
 * about the person changed, and the fetch simply did not answer this time.
 *
 * `image_192` over `image_72` because every place this renders puts it
 * through the dither filter, and a filter reading detail out of a 72px source
 * has less to work with than the ones it is applied to elsewhere.
 *
 * The handle is the display name - what Slack puts after the `@` - and falls
 * back to the account's `name`, never to `real_name`. Slack's own UI shows the
 * real name when no display name is set, but the handle is stored precisely so
 * a real name is NOT what other participants see.
 */
export async function fetchSlackProfile(slackId: string): Promise<SlackProfile> {
	const token = slackToken();
	if (!token) return NO_PROFILE;

	let response: Response;
	try {
		response = await fetch(`${USERS_INFO}?user=${encodeURIComponent(slackId)}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch {
		return NO_PROFILE;
	}
	if (!response.ok) return NO_PROFILE;

	const body = parseJson(await response.text());
	if (body === undefined || !isJsonObject(body)) return NO_PROFILE;
	if (readBoolean(body, 'ok') !== true) return NO_PROFILE;

	const user = readObject(body, 'user');
	const profile = user ? readObject(user, 'profile') : null;
	if (!user || !profile) return NO_PROFILE;

	return {
		avatarUrl: asHttpUrl(readString(profile, 'image_192') ?? readString(profile, 'image_72')),
		username:
			readString(profile, 'display_name_normalized') ??
			readString(profile, 'display_name') ??
			readString(user, 'name')
	};
}

/**
 * One call to Slack, up to the point where the answer means something.
 *
 * Everything that is the same for every method lives here - the timeout, the
 * status classes, the body that is not JSON - and what each method's own
 * `error` code means is left to the caller, because that is the part where they
 * genuinely differ.
 *
 * `repeatable` is the one argument that is not plumbing. It says whether
 * sending this exact request again is harmless, and it decides what happens
 * when the call goes out and we never learn its fate. A message posted twice is
 * a defect; an invitation issued twice is the second one answering
 * `already_in_channel`. So an idempotent method retries where a message halts.
 */
type SlackReply = { payload: JsonObject } | { outcome: EffectOutcome };

async function callSlack(
	url: string,
	token: string,
	body: JsonObject,
	repeatable: boolean
): Promise<SlackReply> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json; charset=utf-8'
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		/* A transport failure AFTER the request was written is the ambiguous case:
       Slack may have received and acted on it. With no idempotency key - and
       `chat.postMessage` has none - retrying could post the message twice. The
       wiki's rule is to halt and let a person establish what happened rather
       than compensate from a partial picture.

       An abort is different and is safe to retry whatever the method: the
       request was cancelled by us, and a timeout at ten seconds against Slack
       is very nearly always a connection that never got anywhere. */
		const aborted = cause instanceof Error && cause.name === 'TimeoutError';
		if (aborted) return { outcome: { status: 'retryable', error: 'timed out reaching Slack' } };
		return {
			outcome: repeatable
				? {
						status: 'retryable',
						error: `network failure talking to Slack: ${errorName(cause)}`
					}
				: {
						status: 'ambiguous',
						error: `network failure talking to Slack: ${errorName(cause)}`
					}
		};
	}

	if (response.status === 429 || response.status >= 500) {
		return { outcome: { status: 'retryable', error: `Slack returned ${response.status}` } };
	}
	if (!response.ok) {
		return { outcome: { status: 'failed', error: `Slack returned ${response.status}` } };
	}

	/* The check that matters. A 200 from Slack says the request was
     understood, not that it was carried out. */
	const parsed = parseJson(await response.text());
	if (parsed === undefined) {
		const error = 'Slack returned a body that is not JSON';
		return {
			outcome: repeatable ? { status: 'retryable', error } : { status: 'ambiguous', error }
		};
	}

	/* A body that parsed but is not an object is treated as an object with none
     of the keys we want, which lands it on the caller's refusal path rather
     than on `ambiguous`. Slack does not do this, and the difference matters if
     it ever starts: `ambiguous` is the one outcome that neither retries nor
     resolves, so it is reserved for "we genuinely cannot tell". */
	return { payload: isJsonObject(parsed) ? parsed : {} };
}

/**
 * Post a message, and report honestly what happened.
 *
 * The returned `remoteId` is Slack's message timestamp, which is its identifier
 * for the message. It is stored on the outbox row so a reconciliation can ask
 * "did this actually land" and have something to point at - the wiki's
 * requirement that a delivered verdict have evidence rather than being a
 * conclusion drawn from the absence of an error.
 */
export async function postSlackMessage(text: string): Promise<EffectOutcome> {
	const config = slackConfig();
	if (!config) {
		/* Deferred, not skipped. Slack being unconfigured is a fact about this
       deployment that a single environment variable changes, and a skipped row
       never runs again - so every order placed before the token arrived would
       be silently unannounced forever. */
		return {
			status: 'deferred',
			error: 'SLACK_BOT_TOKEN or SLACK_CHANNEL_ID is not set'
		};
	}

	/* Not repeatable: a message has no idempotency key, so a request whose fate
     we never learn stops rather than going out a second time. */
	const reply = await callSlack(
		POST_MESSAGE,
		config.token,
		/* No previews. Messages link back to the platform now, and Slack would
		   otherwise hang a card of the page under every approval and rejection -
		   the same card, over and over, in a channel whose point is the line of
		   text above it. */
		{ channel: config.channel, text, unfurl_links: false, unfurl_media: false },
		false
	);
	if ('outcome' in reply) return reply.outcome;

	if (readBoolean(reply.payload, 'ok') === true) {
		return { status: 'delivered', remoteId: readString(reply.payload, 'ts') };
	}

	const code = readString(reply.payload, 'error') ?? 'unknown_error';

	return TERMINAL_SLACK_ERRORS.has(code)
		? { status: 'failed', error: `Slack refused: ${code}` }
		: { status: 'retryable', error: `Slack refused: ${code}` };
}

/**
 * The same, for a DM, which can refuse on the person's account: it no longer
 * exists, it was deactivated, or the app's Messages tab is switched off in the
 * app's settings. None of those change on a retry.
 */
const TERMINAL_DM_ERRORS = new Set([
	...TERMINAL_SLACK_ERRORS,
	'user_not_found',
	'user_disabled',
	'cannot_dm_bot',
	'messages_tab_disabled'
]);

/**
 * Send a participant a DM from the bot.
 *
 * `chat.postMessage` with the person's Slack id as the channel, which lands in
 * the app's own DM with them. `chat:write` covers it; no `im:write` is needed,
 * because nothing here opens a conversation - Slack does that for a user id.
 * The app's Messages tab has to be on (App Home, in the app's settings), or
 * every DM comes back `messages_tab_disabled`.
 *
 * Not repeatable, for the reason `postSlackMessage` gives. Deferred with no
 * token, also for its reason: a decision made before the token arrived is
 * still one its author should hear about.
 */
export async function postSlackDm(slackId: string, text: string): Promise<EffectOutcome> {
	const token = slackToken();
	if (!token) return { status: 'deferred', error: 'SLACK_BOT_TOKEN is not set' };

	const reply = await callSlack(
		POST_MESSAGE,
		token,
		{ channel: slackId, text, unfurl_links: false, unfurl_media: false },
		false
	);
	if ('outcome' in reply) return reply.outcome;

	if (readBoolean(reply.payload, 'ok') === true) {
		return { status: 'delivered', remoteId: readString(reply.payload, 'ts') };
	}

	const code = readString(reply.payload, 'error') ?? 'unknown_error';
	return TERMINAL_DM_ERRORS.has(code)
		? { status: 'failed', error: `Slack refused: ${code}` }
		: { status: 'retryable', error: `Slack refused: ${code}` };
}

/**
 * Put someone in the Phantom channel.
 *
 * The one Slack call here that changes something for the participant rather
 * than telling operators about it, and the only one that is safe to make twice:
 * `conversations.invite` describes a state - this person is in this channel -
 * rather than an event, so a second attempt either does nothing or says
 * `already_in_channel`, and both mean the same thing as the first one having
 * worked. That is why it is `delivered` below and not an error: the outcome is
 * about whether they are in the channel, not about who put them there. Someone
 * who joined on their own, or who was already in it from a previous program,
 * is not a failed invitation.
 *
 * Needs `channels:write.invites` on the bot token - `channels:manage` also
 * carries it, and grants a good deal more - and the bot has to be in the
 * channel itself. Neither is something this code can arrange: both arrive as a
 * refusal (`missing_scope`, `not_in_channel`) that is terminal by design, so
 * the row lands in the outbox console naming the thing an operator has to go
 * and fix rather than retrying against a workspace that will keep saying no.
 */
export async function inviteToPhantomChannel(slackId: string): Promise<EffectOutcome> {
	const token = slackToken();
	/* Deferred rather than skipped, for the reason `postSlackMessage` gives:
     everyone who signed in before the token arrived should still be added once
     it does. */
	if (!token) return { status: 'deferred', error: 'SLACK_BOT_TOKEN is not set' };

	const reply = await callSlack(
		CONVERSATIONS_INVITE,
		token,
		{ channel: PHANTOM_CHANNEL, users: slackId },
		true
	);
	if ('outcome' in reply) return reply.outcome;

	/* No remoteId: an invitation is not a message and Slack hands back the
     channel, not a timestamp that identifies this act. The evidence a
     reconciliation would want is membership, which is a question to ask Slack
     rather than a string to keep. */
	if (readBoolean(reply.payload, 'ok') === true) return { status: 'delivered' };

	const code = readString(reply.payload, 'error') ?? 'unknown_error';

	/* Already in the channel is the state this effect exists to produce. */
	if (code === 'already_in_channel') return { status: 'delivered' };

	return TERMINAL_INVITE_ERRORS.has(code)
		? { status: 'failed', error: `Slack refused: ${code}` }
		: { status: 'retryable', error: `Slack refused: ${code}` };
}

/** The name of a thrown thing, without its message.
 *
 *  A fetch failure's message can contain the URL, and the URL is not a secret
 *  here - but this string goes into a column the wiki says must hold codes and
 *  names rather than bodies, and the discipline is easier to keep than to
 *  restore. */
function errorName(cause: unknown): string {
	return cause instanceof Error ? cause.name : 'unknown';
}
