CREATE TABLE IF NOT EXISTS ai_video_result_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  provider varchar(32) NOT NULL,
  provider_task_id varchar(160) NOT NULL,
  source_url_hash varchar(80) NOT NULL,
  oss_file_key text NULL,
  file_url text NULL,
  mime_type varchar(120) NULL,
  byte_size bigint NULL,
  sha256 varchar(80) NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_video_result_assets_status_check
    CHECK (status IN ('PENDING', 'UPLOADING', 'READY', 'FAILED', 'DELETED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_video_result_assets_unique_source
ON ai_video_result_assets(app_id, provider, provider_task_id, source_url_hash);

CREATE INDEX IF NOT EXISTS idx_ai_video_result_assets_expiry
ON ai_video_result_assets(status, expires_at)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_video_result_assets_task
ON ai_video_result_assets(app_id, provider, provider_task_id);
