BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE software_versions
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT ''
  CHECK (char_length(notes) <= 2000);

ALTER TABLE softtrack_audit_events
  ADD COLUMN IF NOT EXISTS old_notes text,
  ADD COLUMN IF NOT EXISTS new_notes text;

COMMIT;
