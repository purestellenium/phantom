-- `if not exists` on both, for the reason 0011_update_declaration.sql spells
-- out: auto-deploy rolls out the new image the moment the branch moves and the
-- new code reads these columns, so they are added by hand first and
-- `db:migrate` runs afterwards to record the migration. Without it that second
-- run fails on a column it just found already there.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "notes_for_reviewer" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "notes_for_reviewer" text;
