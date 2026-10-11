-- Make the database refuse to rewrite history.
--
-- lib/ledger.ts says a ledger entry is never updated or deleted and a mistake is
-- corrected by appending its opposite. lib/db/schema.ts says the same about the
-- audit log. Both were promises the code made and the database did not keep.
--
-- Triggers rather than grants, because grants need two roles - an owner and a
-- separate runtime role - and the role this deploys against cannot create one
-- (`permission denied to create role`). A trigger needs no second role: the
-- owner installs it, and it then fires on every statement including the owner's
-- own. It also covers TRUNCATE, which is the operation that leaves nothing
-- behind and which no amount of row-level care prevents.
--
-- What this stops: every accidental path, every bug, and every casual misuse of
-- a leaked connection string. `update ledger_entries set amount = 0` and
-- `truncate audit_events` both fail.
--
-- What it does not stop: the owner dropping the trigger first. That is one
-- deliberate extra step for an attacker who already holds the credential, and it
-- is the ceiling of what a single role can enforce against itself. The stronger
-- version is lib/db/grants.sql, which needs infrastructure to provision a second
-- role - worth asking for before this handles anything that matters.
--
-- Applied by `bun run db:migrate`, after the migrations. Idempotent.

-- `DROP TRIGGER IF EXISTS` on a fresh database emits a NOTICE per statement,
-- which the driver surfaces as a wall of output around a command that
-- succeeded. Warnings and above still print.
SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION refuse_rewrite() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Correct a mistake by appending its opposite.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- Row-level, for UPDATE and DELETE.
DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_rewrite();

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION refuse_rewrite();

-- Statement-level, because TRUNCATE has no rows to fire per-row against - which
-- is exactly why it is the dangerous one.
DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries;
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_rewrite();

DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_rewrite();
