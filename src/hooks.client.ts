import type { HandleClientError } from '@sveltejs/kit';

/**
 * The browser half of error handling, and the reason the log id kept coming up
 * blank.
 *
 * hooks.server.ts mints an id for every unexpected server error, and
 * +error.svelte renders it. But that hook only ever runs on the server, and
 * once the app has hydrated MOST navigation is client-side - the router fetches
 * the data and renders the page in the browser, so a failure there never
 * touches the server hook. `page.error` then arrives with a message and no
 * `id`, the `{#if page.error?.id}` block renders nothing, and the page tells
 * the reader to quote a log id that is not on screen.
 *
 * So: the same id, minted on this side. The shape of the console line
 * deliberately matches the server's `[id] METHOD /path`, because the two are
 * read by the same person doing the same thing.
 *
 * What an id from here does NOT do is name a line in the server log - there is
 * no server line, the failure was in the browser. It names the console entry
 * below. That is worth having anyway: it turns "it broke" into a string the
 * reader and whoever is helping them can both point at, and if a client error
 * sink is ever added this is the one place that has to start posting to it.
 */
export const handleClientError: HandleClientError = ({ error, event, status, message }) => {
	/* 404s are routing, not failure, and the page says so without an id. Same
	   early return the server hook takes, for the same reason. */
	if (status === 404) return { message };

	const id = crypto.randomUUID();
	console.error(`[${id}] ${event.url.pathname}`, error);

	/* The generic message, matching the server's. The thrown error's own text
	   can name internals - a column, a constraint, a path - and the reader is
	   given the id instead, which names nothing. */
	return { message: 'you found a ghost', id };
};
