CREATE TABLE IF NOT EXISTS app_slug_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug varchar(64) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_slug_aliases_slug_unique
ON app_slug_aliases(LOWER(slug));

CREATE INDEX IF NOT EXISTS idx_app_slug_aliases_app
ON app_slug_aliases(app_id, is_active, updated_at DESC);
