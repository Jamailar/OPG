ALTER TABLE ai_global_sources
ADD COLUMN IF NOT EXISTS credentials_json jsonb NOT NULL DEFAULT '{}'::jsonb;
