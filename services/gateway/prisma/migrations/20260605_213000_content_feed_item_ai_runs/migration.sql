CREATE TABLE IF NOT EXISTS app_content_feed_item_ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_id uuid REFERENCES app_content_feed_sources(id) ON DELETE CASCADE,
  action varchar(24) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'queued',
  total_count integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  item_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  error_message text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_item_ai_runs_action_check
    CHECK (action IN ('review', 'summarize', 'translate')),
  CONSTRAINT app_content_feed_item_ai_runs_status_check
    CHECK (status IN ('queued', 'running', 'success', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_item_ai_runs_status_time
ON app_content_feed_item_ai_runs(status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_item_ai_runs_source_time
ON app_content_feed_item_ai_runs(source_id, created_at DESC);
