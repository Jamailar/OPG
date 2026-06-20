DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppKind') THEN
    CREATE TYPE "AppKind" AS ENUM ('DESKTOP', 'WEBSITE', 'MOBILE');
  END IF;
END $$;

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS kind "AppKind" NOT NULL DEFAULT 'WEBSITE';

CREATE INDEX IF NOT EXISTS idx_apps_kind_status_created
  ON apps(kind, status, created_at DESC);
