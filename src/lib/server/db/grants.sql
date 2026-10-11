-- Least privilege for the runtime role. The stronger half of the append-only
-- enforcement; lib/db/append-only.sql is the half that works everywhere.
--
-- The triggers there refuse UPDATE, DELETE and TRUNCATE on the two append-only
-- tables and need only one role, so they apply on every database this deploys
-- against. What they cannot stop is that role dropping the trigger first. This
-- file closes that, and needs a second role to do it - which is why it is a
-- manual step and not part of `db:migrate`: the database this currently deploys
-- against answers `permission denied to create role`, so it has the triggers
-- and not these grants. Ask whoever provisions the database for an owner and a
-- separate runtime role before this handles anything that matters.
--
-- Two tables in this schema are append-only, and until now that was a promise
-- the code made and the database did not keep: lib/ledger.ts says a ledger entry
-- is never updated or deleted and a mistake is corrected by appending its
-- opposite, and lib/db/schema.ts says the same about the audit log. Postgres
-- happily permitted UPDATE, DELETE and TRUNCATE on both. A leaked DATABASE_URL
-- was therefore not a read/write compromise but a rewrite-history compromise -
-- `truncate audit_events` erases the record of what happened, and nothing said
-- no.
--
-- Applying this needs two roles. The OWNER runs migrations and owns the tables;
-- the APP connects at runtime and is what DATABASE_URL points at. They must not
-- be the same role, because a table's owner can always grant itself back
-- whatever you revoke - and can DROP the table regardless.
--
--   createuser phantom_app --no-createdb --no-createrole --no-superuser
--   psql -d phantom_platform -v app=phantom_app -f lib/db/grants.sql
--
-- Run it as the owner, after every migration: new tables do not inherit these.
--
-- Verified against what the application actually does. `grep` for writes to
-- these two tables finds exactly one insert each (lib/ledger.ts, lib/audit.ts)
-- and no update, delete or truncate anywhere, including in raw SQL. The one
-- statement that used to break this rule - the purchase path patching
-- ledger_entries.order_id after the fact - is gone; the entry now carries its
-- order id at insert.

\set app :app

-- Nothing by default, then only what is used.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :app;
REVOKE ALL ON SCHEMA public FROM :app;

GRANT USAGE ON SCHEMA public TO :app;

-- Ordinary tables: full DML, no DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users,
  sessions,
  oauth_states,
  provider_accounts,
  orders,
  order_transitions,
  products,
  product_revisions,
  ledger_accounts,
  outbox_events,
  job_runs,
  site_settings,
  hackatime_activity
TO :app;

-- The two that are append-only. No UPDATE, no DELETE, and no TRUNCATE - which
-- is not covered by REVOKE ALL on a table the role never owned, but is worth
-- stating because TRUNCATE is the one that leaves nothing behind.
GRANT SELECT, INSERT ON ledger_entries, audit_events TO :app;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, audit_events FROM :app;

-- Sequences: none are used (every key is a uuid default), so nothing is granted.

-- A new table created by a later migration is not covered above. This makes the
-- default explicit rather than leaving it to whoever remembers.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM :app;
