<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://assets.hackclub.com/flag-standalone-wtransparent.svg" />
    <img src="https://assets.hackclub.com/flag-standalone-bw.svg" width="100" alt="Hack Club flag" />
  </picture>
  <h1>phantom</h1>
  <p>the platform for PHANTOM, a Hack Club YSWS, written in SvelteKit and Svelte 5.</p>
</div>

## features

- login and authentication with HCA
- connection to hackatime
- submit projects for review, and earn fragments for approved hours
- explore and upvote others' projects
- spend fragments in a shop, including on the invite to the event
- invite friends and earn rewards

for admins:

- view user data and adjust balances
- view and manage orders for fulfillment
- create shop categories and items
- mark standout projects as hyper-chroma
- see the audit log, ledger, funnel and background jobs

also supports integration with ari, one of hack club's external review platforms.

## stack

- [sveltekit](https://svelte.dev/docs/kit) + svelte 5 for frontend + routing
- [drizzle ORM](https://orm.drizzle.team/) + postgreSQL for the database
- [bun](https://bun.sh/) as the package manager and test runner

## running locally

you need bun, docker, and a `.env` file (copy `.env.example`). only `DATABASE_URL` and `ENCRYPTION_KEY` are required: without HCA credentials, the dev server signs you in as a local owner and fakes hackatime.

local-only env vars:

- `STAGING` - set to `1` for a staging mode, otherwise don't touch

```sh
bun install
bun run db:start     # spins up postgres via docker compose
bun run db:migrate   # applies the migrations
bun run db:seed      # seeds the catalog (db:seed:demo for sample data)
bun run dev          # starts the dev server
```

to inspect the database:

```sh
bun run db:studio
```

## deployment

this app builds to a plain node server (there's also a `Dockerfile`).

```sh
bun run build
node build
```

set all env vars from `.env.example` in your `.env` file before running. key ones for prod:

- `DATABASE_URL` - your postgres connection string
- `ENCRYPTION_KEY` - generate with `openssl rand -hex 32`
- `HCA_CLIENT_ID` / `HCA_CLIENT_SECRET` - Hack Club Auth oauth app (callback: `/api/auth/hca/callback`)
- `HACKATIME_CLIENT_ID` / `HACKATIME_CLIENT_SECRET` - hackatime oauth app (callback: `/api/auth/hackatime/callback`)
- `ADMIN_HCA_SUBJECTS` / `OWNER_HCA_SUBJECTS` - comma-separated HCA user IDs
- `CRON_SECRET` - for the scheduled jobs at `/api/jobs/run`

run migrations against the prod database before starting:

```sh
bun run db:migrate
```

the server listens on port `3000` by default. set `PORT` to override.

## ai disclosure

ai was heavily used in the creation of this project! it was a group effort, with most code being done by @stelle and @nty, with the help of gpt-6 astra, claude sonnet 5, claude opus 5, and claude opus 5.5.

## contributing

this repository is a clone of the real working repo (in order to keep the real one secret / avoid leaks for the story & lore), so it may not always be up to date.
however, pull requests are still welcome! ask in #phantom-help, or dm @stelle or @nty on slack if you have questions!
