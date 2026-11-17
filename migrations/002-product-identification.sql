BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.software
  ADD COLUMN IF NOT EXISTS nvd_family text,
  ADD COLUMN IF NOT EXISTS nvd_needs_identification boolean;

COMMIT;
