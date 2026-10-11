-- `if not exists` on both, which drizzle-kit does not generate and this
-- migration needs.
--
-- Auto-deploy builds and rolls out the new image the moment the branch moves,
-- and the new code reads these two columns - so they have to exist BEFORE the
-- rollout, not after it. But this file only travels INSIDE that image, so the
-- running pod cannot apply it ahead of time: the columns get added by hand
-- first, and `db:migrate` runs afterwards to record the migration. Without
-- `if not exists` that second run fails on a column it just found already
-- there, and the journal never catches up.
--
-- It also makes the file honest about what lib/db/migrate.ts already claims of
-- the whole command: "both halves are idempotent, so this is safe to re-run".
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "update_declaration" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "update_declaration" text;
