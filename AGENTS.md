# Phantom

SvelteKit 2 + Svelte 5 (runes), Drizzle on Postgres 16, served by `adapter-node`. Bun is the package manager and test runner; `bun.lock` is the lockfile the Dockerfile installs from, so add packages with `bun add`. README.md is the architecture: read the section for the area you touch before changing it.

## Checking work

- `bun run check` (svelte-check) and `bun test tests/` run without a database.
- `bun run build` needs `DATABASE_URL` and `ENCRYPTION_KEY` set, even to throwaway values, because `src/lib/server/env.ts` validates them at import. The Dockerfile does the same.
- Without HCA credentials, `bun run dev` runs in staging mode and signs you in as a local owner (README, "Running it").

## Conventions

- Comments explain _why_, in full sentences, and are part of the code: keep them true when you change the code they sit on, and write new ones in the same voice.
- Every page load calls `requireOnboarded`/`requireUser`/`requireCapability` for itself, and every form action calls it again.
- A form action refuses with `fail()` and succeeds with a redirect.
- `ledger_entries` and `audit_events` are append-only. Correct them by appending, never by editing.
- Commit subjects are one plain sentence in the imperative ("Let people archive projects that were shipped but never approved").

## Analytics

Product analytics go to Plausible. Every new user-facing feature gets its events in the same change.

- **Outcomes** (something committed: created, shipped, bought, upvoted) are recorded on the server, after the write succeeds: `recordEvent` in `src/lib/server/analytics.ts`.
- **Interactions** that never reach the server (copy, open, scroll, client-side fetch) are recorded in the browser: `trackEvent` in `src/lib/analytics/client.ts`.
- Pageviews, searches and filters, outbound links, downloads and form submissions are already counted automatically from the root layout. They need no code.
- Add each new event name to the union type in that file, as `area.past_tense_verb`, with a one-line doc comment.
- Properties describe the _shape_ of the event: a kind, a boolean, a count, a slug. Every event already carries the visitor's segment (role, onboarded, eligibility, arrival route, signup week) and the route id, so don't add those again.
- Identifiers stay out of properties: no email, name, user/order/HCA id, invite code or free text a person typed in the console. Who-did-what lives in the audit log and `/admin/referrals` and `/admin/funnel`.
- Analytics run only on phantom.hackclub.com unless `PLAUSIBLE_DOMAIN` is set, so nothing is sent from local or preview.
