import type { ActiveSession } from '$lib/server/auth/session';

declare global {
	namespace App {
		interface Error {
			/** An opaque handle to the line in the server log that explains this
			 *  error. Shown to the reader so a support conversation can start from
			 *  something better than "it broke"; it names nothing about what failed. */
			id?: string;
		}
		interface Locals {
			/** Resolved once per request by the `handle` hook, from the session
			 *  cookie against the sessions table. Null for an anonymous request. */
			session: ActiveSession | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
