CREATE TABLE IF NOT EXISTS ai_voice_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  public_voice_id varchar(64) NOT NULL,
  display_name varchar(128) NOT NULL DEFAULT '',
  language varchar(32) NULL,
  status varchar(32) NOT NULL DEFAULT 'creating',
  active_mapping_id uuid NULL,
  sample_file_key varchar(1024) NOT NULL,
  sample_file_url varchar(2048) NOT NULL,
  sample_mime_type varchar(128) NULL,
  sample_size_bytes bigint NULL,
  sample_sha256 varchar(64) NULL,
  sample_duration_ms integer NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_voice_provider_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voice_asset_id uuid NOT NULL REFERENCES ai_voice_assets(id) ON DELETE CASCADE,
  provider_type varchar(64) NOT NULL,
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
  global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
  provider_voice_id varchar(256) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'ready',
  provider_request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_voice_assets_active_mapping'
  ) THEN
    ALTER TABLE ai_voice_assets
      ADD CONSTRAINT fk_ai_voice_assets_active_mapping
      FOREIGN KEY (active_mapping_id) REFERENCES ai_voice_provider_mappings(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_voice_migration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar(32) NOT NULL DEFAULT 'pending',
  from_provider_type varchar(64) NULL,
  to_source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
  to_global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
  filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  created_by_user_id uuid NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_voice_migration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ai_voice_migration_jobs(id) ON DELETE CASCADE,
  voice_asset_id uuid NOT NULL REFERENCES ai_voice_assets(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL DEFAULT 'pending',
  old_mapping_id uuid NULL REFERENCES ai_voice_provider_mappings(id) ON DELETE SET NULL,
  new_mapping_id uuid NULL REFERENCES ai_voice_provider_mappings(id) ON DELETE SET NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_voice_assets_public_voice_id
ON ai_voice_assets(public_voice_id);

CREATE INDEX IF NOT EXISTS idx_ai_voice_assets_app_user_status
ON ai_voice_assets(app_id, user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_voice_assets_deleted_status
ON ai_voice_assets(deleted_at, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_voice_provider_mappings_voice_status
ON ai_voice_provider_mappings(voice_asset_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_voice_provider_mappings_provider_lookup
ON ai_voice_provider_mappings(provider_type, source_id, provider_voice_id);

CREATE INDEX IF NOT EXISTS idx_ai_voice_migration_jobs_status_created
ON ai_voice_migration_jobs(status, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_voice_migration_items_job_voice
ON ai_voice_migration_items(job_id, voice_asset_id);

CREATE INDEX IF NOT EXISTS idx_ai_voice_migration_items_job_status
ON ai_voice_migration_items(job_id, status, created_at ASC);
