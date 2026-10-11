# phantom

The site for [Phantom](https://phantom.hackclub.com): the landing page, and
the signed-in half behind it — identity, onboarding, the reward ledger, the
shop, and the operator console. One SvelteKit app, one design system.

## What this is, and what it deliberately is not

Built: the landing page and its waiting list; HCA sign-in, sessions, Hackatime
linking, identity and eligibility recording, onboarding, the launch gate; an
append-only reward ledger; a versioned catalog; orders with a real state
machine, frozen entitlements and compensating refunds; order-time shipping PII
behind an audited reveal; a capability-based operator console; an integration
outbox; a job runner; and the integrity queries that prove the books balance.

**Not built, on purpose:**

| Absent               | Why, and what is already shaped for it                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects and reviews | Modelling them now means guessing at their shape. The ledger's earning transition is decided and documented — a hard approval posts one `submission_award` entry keyed `submission:<id>:award` — so it arrives as a writer, not a migration. |
| Fulfilment execution | Nothing here talks to a warehouse, a carrier or HCB. Orders stop at `fulfilled`; shipping states and their columns are fulfilment's to add rather than something to overload `fulfilled` with.                                               |
| Fraud cases          | `manage_fraud` exists in the capability enum with nothing checking it, for the same reason `reviewer` predates reviews.                                                                                                                      |

**There is therefore no way to earn.** Every second in circulation came from an
admin adjustment, and the pages say so rather than showing a zero that looks
like a number that is merely small.

## The front door

The landing page is public and never behind the launch gate. What its hero
offers depends on the launch switch in the console:

- Closed: the waiting list, an email field that writes to Airtable, plus a quiet
  log-in link so staff can reach the site they are building.
- Open: sign up through Hack Club, or log in.

A signed-in visitor the gate refuses lands back here with the reason and a
sign-out button. Every code the auth routes redirect with — a cancelled
sign-in, an expired link, a completed sign-out — is turned into a sentence on
this one page and nowhere else.

## The economy

Approved coding seconds are the currency — OneKey's model, chosen because it has
no exchange rate to explain, freeze or get wrong. Prices are in seconds; the UI
renders hours.

Two tables. `ledger_accounts` is one row per person: the lock a spend takes, and
a cached balance. `ledger_entries` is append-only — nothing is ever updated or
deleted, and a mistake is corrected by appending its opposite linked to the
original.

Three rules, enforced in `src/lib/server/ledger.ts`:

- **The cached balance never authorises a spend.** Every spend recomputes from
  the entries under the lock, and the cache is rewritten from that same
  recomputation, so it self-heals rather than drifting.
- **Every write holds the account lock** — not just spends. A balance check that
  is correct in isolation still permits overspend when two requests read it at
  once.
- **Retries are idempotent through a unique key**, not through an attempt
  counter. `order:<id>:refund` is why two operators pressing reject at the same
  moment produce one refund.

A purchase, in one transaction: authorise, lock the account, replay the balance,
decrement stock with a guarded `where stock >= quantity`, check the per-person
quota, validate the options against the **frozen product revision**, append the
debit, write the order, enqueue the notification. No external call happens
inside it.

Rejecting an order appends a refund and never edits the debit. Restocking is a
separate explicit checkbox with no default. Reopening does not exist: a
replacement is a new order that re-checks affordability at today's price, linked
back to the one it replaces.

## Authorization

A role is a rank; capabilities are the permission system.
`src/lib/server/auth/capabilities.ts` holds the policy as pure data (importable
from a CLI); `src/lib/server/auth/authorize.ts` applies it to a request.

Four capabilities are **never implied by any role** and must be granted to a
named person: `view_pii`, `adjust_ledger`, `manage_fraud`, `move_money`. A
module-load assertion fails the build if one is ever added to a role's base set.
An operator cannot edit their own authority, act on an equal or higher rank, or
grant a capability they do not hold themselves.

`ADMIN_HCA_SUBJECTS` seeds the break-glass set — it answers "who grants the
first grant" — and is a floor, never a ceiling.

The session and the launch gate are applied in `src/hooks.server.ts`, keyed on
the `(app)` route group, because SvelteKit runs a layout's `load` alongside its
pages' rather than before them. Every page then calls `requireOnboarded` or
`requireCapability` for itself, and every form action calls it again: a form
that was never rendered is not a form that cannot be submitted.

## Operations

Nothing runs on a timer. A scheduler calls `/api/jobs/run?job=<name>` with
`CRON_SECRET`; each job takes a Postgres advisory lock and writes a `job_runs`
row, so two replicas firing at once produce one run and one refusal, and
scheduler silence is visible rather than indistinguishable from having nothing
to do.

The scheduler runs each job on its own cadence, because none of them wants the
others'. The outbox runs every five minutes —
that interval is the delay between an order being placed and the people who
fulfil it hearing about it. The session sweep and the ledger reconciliation run
once a day.

`loops.sync`, also every five minutes, keeps the "Loops - Sign Ups" table in
Airtable up to date for Loops: one row per email for everyone who has ever
signed in, with when they signed up and whether they have ever shipped. It
writes only the rows and fields that differ, and never deletes, because the
waiting list writes to the same table.

External effects go through `outbox_events` — inserted in the same transaction
as the decision they belong to, delivered by a worker. The Slack client checks
the HTTP status **and** the JSON `ok` field, because a 200 from Slack says the
request was understood, not that it was carried out. An effect whose provider is
unconfigured is deferred, and stays pending until the variable arrives; one
whose outcome is genuinely unknown settles as `ambiguous` and is never retried
automatically.

`/admin/reconcile` runs twelve integrity queries and has no buttons. It reports;
it never repairs. A finding is fixed by appending an adjustment that quotes it.

`ledger_entries` and `audit_events` are append-only, and the database enforces
it rather than trusting the code to. `bun run db:migrate` installs triggers
(`src/lib/server/db/append-only.sql`) that refuse UPDATE, DELETE and TRUNCATE
on both, including for the owner. `src/lib/server/db/grants.sql` closes the
remaining gap with a second database role; apply it as the owner, after every
migration.

The one unauthenticated write in the application is starting a login, so that is
the one place with a rate limit: ten live flows per client address, oldest
evicted first, refused with the same 404 everything else refuses with. The
waiting list has its own, in `src/routes/api/signup`.

## Running it

Requires [bun](https://bun.sh) and PostgreSQL 16, either local or the one
`compose.yaml` starts.

```sh
bun install
cp .env.example .env
openssl rand -hex 32          # paste into ENCRYPTION_KEY

bun run db:start              # or point DATABASE_URL at a Postgres you have
bun run db:migrate
bun run db:seed               # settings singleton, and the bootstrap admins
bun run dev
```

The app boots and serves without any provider credentials. Sign-in is the only
thing that needs them, and the front page says so plainly rather than failing
with a stack trace.

To work on the signed-in half without them, just run `bun run dev`: with no HCA
credentials it starts in staging mode (force it with `STAGING=1`, turn it off
with `STAGING=0`). That signs you in as a local developer account (role from
`STAGING_ROLE`, default `owner`), links everybody to a fake Hackatime account
with a fixed project list, and has every HCA re-check report verified and
eligible with one fake address. A production build ignores it.
`bun run db:seed:demo:local` fills in the other people and projects to review.

| Script                |                                                         |
| --------------------- | ------------------------------------------------------- |
| `bun run dev`         | development server                                      |
| `bun run build`       | production build; `bun run preview` serves it           |
| `bun run check`       | svelte-check                                            |
| `bun run lint`        | prettier and eslint                                     |
| `bun run db:generate` | generate a migration from `src/lib/server/db/schema.ts` |
| `bun run db:migrate`  | apply pending migrations and the append-only triggers   |
| `bun run db:seed`     | idempotent; safe to re-run                              |
| `bun run db:studio`   | browse the database                                     |

There is no product seed. The catalog is authored in the console at
`/admin/catalog`, because a product is program policy rather than schema, and a
seeded one is a price nobody decided.

## Configuration

Two tiers, and the split is deliberate. `DATABASE_URL` and `ENCRYPTION_KEY` are
validated when `src/lib/server/env.ts` loads, so a mistake is one legible error
at startup rather than a surprise three screens into a login. The HCA
credentials are resolved on use, so the absence of a client ID that another team
has not issued yet does not stop the application from running.

There is no `APP_URL`. The origin comes from the request being served
(`src/lib/server/auth/origin.ts`), which is right in production, in a preview
and on localhost with nothing set. Host spoofing is bounded rather than trusted:
internal redirects are relative, so a forged host cannot steer one off-origin,
and the one absolute URL — `redirect_uri` — is checked by HCA against its
registered list, so a forged host breaks the attacker's own login and leaks
nothing.

### Values that have to come from Hack Club

| Variable                                          | How to get it                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `HCA_CLIENT_ID` / `HCA_CLIENT_SECRET`             | Register a Program with HCA. Self-service registration produces a `community_untrusted` client, which is enough for the scopes below. |
| `HACKATIME_CLIENT_ID` / `HACKATIME_CLIENT_SECRET` | Register an OAuth application with Hackatime.                                                                                         |

`HCA_HOST` and `HACKATIME_HOST` are optional and default to
`https://auth.hackclub.com` and `https://hackatime.hackclub.com`.

### Redirect URIs

Both callbacks are derived from the request being served:

```text
https://<this deployment's host>/api/auth/hca/callback
https://<this deployment's host>/api/auth/hackatime/callback
```

`/admin/settings` prints the exact pair for whichever host is serving the page.
Register the pair for each host you want to sign in from.

### Scopes requested

`openid profile email slack_id verification_status`.

`birthdate` and `address` are deliberately **not** requested. They are HQ-tier
scopes, and `verification_status` answers the eligibility question more
narrowly than a date of birth would. A shipping address is collected **per
order**, at the moment somebody buys a physical thing, and encrypted onto that
order alone. Reading it requires the `view_pii` capability, which no role
implies, and every reveal writes an audit row naming the operator, the order and
the time.

## How identity is recorded

Four signals are stored separately, each with its own timestamp, and one
function derives a decision from them:

| Column                            | Source                                                |
| --------------------------------- | ----------------------------------------------------- |
| `verificationStatus`              | the `verification_status` claim                       |
| `yswsEligibleClaim`               | the `ysws_eligible` claim                             |
| `identityCheckResult`             | `GET /api/external/check?idv_id=<sub>`                |
| `eligibility` + `eligibilityRule` | our derivation, and the rule version that produced it |

They are kept apart because the first two and the third answer different
questions and are allowed to disagree — `verified` means an approved
verification exists, which is not the same as being young enough to qualify, and
verified adults are routinely both at once. Here there is one derivation, one
stored decision, and every gate reads it.

Eligibility **fails closed**. An upstream error records `unavailable` and
resolves to `undetermined` rather than falling back to a locally computed age.

Users are keyed on the HCA `sub` claim (`ident!…`), never on email or Slack ID —
both are mutable upstream, and either as a key would silently split one person
into two accounts the first time they changed.

## Notes for whoever picks this up

**Signing out does not revoke provider tokens.** HCA documents no
client-callable revocation endpoint, so a local sign-out ends the local session
and nothing more.

**The launch gate is evaluated before the redirect to the provider**, not in the
callback. A user who is going to be refused is refused in one redirect, not
after a consent screen, a callback and a token exchange.

**Roles have one source of truth: the `users.role` column.**
`ADMIN_HCA_SUBJECTS` only seeds it on first sign-in. Removing someone from that
variable does not demote them; change the column.

**An order freezes what it bought.** Name, kind, price, quantity, options and
the product version are copied onto the row, and every version has a
`product_revisions` entry describing it.

**Order state moves forward only.** Every transition names the state it expects
to be leaving, in the `WHERE` clause, so a stale admin tab updates zero rows and
is told the order has moved rather than winning a race it did not know it was
in. `fulfilled`, `rejected` and `cancelled` are terminal.

**Refusals come back through the form.** A form action answers a bad submission
with `fail()` and the page renders it; nothing is carried in a query string. A
successful mutation redirects, so a reload never re-posts it.

## Analytics

Product analytics go to Plausible, from both halves of the app. With nothing
set they run only when served at `phantom.hackclub.com`; `PLAUSIBLE_DOMAIN`
turns them on for another host.

- **The browser** (`src/lib/analytics/client.ts`, started from the root
  layout) counts every pageview with its route id, time on page and scroll
  depth; a same-page query change as a `filter` event carrying what was
  searched or picked; outbound links, downloads and form submissions; and the
  interactions the server never sees - an invite link copied, a guide read to
  the end, a FAQ question opened, a step of the new-project flow reached.
- **The server** (`recordEvent` in `src/lib/server/analytics.ts`) counts
  outcomes once they commit: invite and partner arrivals, the waiting list,
  sign-in, onboarding, referrals qualifying, projects created, shipped,
  resubmitted, archived and deleted, upvotes, orders placed and moved. Sent
  server to server, an ad blocker cannot hide them.

Every event carries the visitor's segment - signed in, role, onboarded,
eligibility, how they arrived (invite, a partner, direct) and their signup
week - so any chart splits by kind of person. None carries an identifier: no
email, no id, no invite code. URLs are scrubbed before they leave - UUIDs
become `:id`, the query string goes except `utm_*`, and `?ref=<code>` is
credited to `utm_source=invite`. Per-person questions are answered in the
console (`/admin/funnel`, `/admin/referrals`), from our own tables.

Moments with no browser behind them - Ari's review decisions, jobs - are not
sent, because Plausible counts visitors by their address and user agent; the
funnel counts them from the tables instead. For the server half to see real
addresses behind Orchard's proxy it reads `X-Forwarded-For`.

Staff can keep their own visits out by setting `localStorage.plausible_ignore`
to `"true"` in their browser.

## The design language

The page is ordinary DOM painted by the browser. Behind it sits the field
(`src/lib/field/field.worker.ts`): a fixed 2D canvas, one cell per two pixels,
whose ground, rim and vignette are computed once per resize in a worker and
quantised to a seven-level ramp. No WebGL, no render loop. The pointer's
trail and click rings go on a transparent canvas over it
(`src/lib/field/pointer.ts`), drawn only while something moves; the vignette
is a fixed gradient above the page. The flag is an image, the title's halo a
small canvas drawn once (`src/lib/field/bloom.ts`).
The bell is a looping video of raw luminance baked from the model
(`static/models/liberty-bell/bell.mp4`), quantised frame by frame into a
small canvas by `src/lib/field/bellDither.ts` — the one place script runs
while the page is idle, over the bell alone.

Surfaces carry their weave as CSS background layers (`--weave-*` and
`--shade-*` in `src/globals.css`), and fills belong on the `--level-*`
ladder defined there rather than on a colour picked by eye.

## The request path

No page waits on the database for anything but its own content. The launch
switch is read into memory and refreshed in the background as it ages
(`src/lib/server/launch.ts`); a confirmed session is reused for thirty seconds
and forgotten by every write that could change it (`src/lib/server/auth/session.ts`);
`lastSeenAt` is stamped off the request path; and `init` in `src/hooks.server.ts`
opens the connection and warms both before the first request, then keeps the
connection open with a ping. Requests over 250ms are logged as `[slow]` with
their route. Page loads issue their queries in parallel with `Promise.all`.

In development `.env.local` may point at a remote database; against one that
answers in 200ms a page with two dependent queries takes 400ms. `bun run
db:start` brings up a local Postgres for a fast loop.

## Deployment

A Node server through `adapter-node`: `bun run build`, then `node build`.
That is what Orchard runs, and what the `Dockerfile` packages:

```sh
docker build -t phantom .                                   # the app, on port 3000
docker run -p 3000:3000 --env-file .env phantom

docker build --target migrate -t phantom-migrate .          # migrations, run first
docker run --rm --env-file .env phantom-migrate
```

The image carries no secrets - `.env` is excluded from the build context, and
the build runs with throwaway values it never uses. Behind a proxy, set
`PROTOCOL_HEADER`/`HOST_HEADER` (as Orchard does) or `ORIGIN`, or SvelteKit
refuses form posts as cross-site.

`src/lib/server/db/client.ts` is the only file that knows how we talk to
Postgres, and it uses postgres-js over ordinary TCP. Moving hosts should be a
connection string and a pool size in that one file rather than a different
client with a different API. There is deliberately no branch on `NODE_ENV` or
on the host: a connection layer that behaves differently in production is one
that cannot be tested before it gets there.

Where the build resolves to `adapter-node`, set `BODY_SIZE_LIMIT` above
`MAX_IMAGE_BYTES` in `src/lib/images.ts` - it defaults to 512K, which refuses
every screenshot before any action sees the request.
