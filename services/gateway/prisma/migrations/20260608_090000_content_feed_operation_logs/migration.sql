ALTER TABLE app_content_feed_item_ai_runs
  DROP CONSTRAINT IF EXISTS app_content_feed_item_ai_runs_action_check;

ALTER TABLE app_content_feed_item_ai_runs
  ADD CONSTRAINT app_content_feed_item_ai_runs_action_check
  CHECK (action IN ('review', 'summarize', 'refine', 'translate', 'pipeline'));

CREATE TABLE IF NOT EXISTS app_content_feed_operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_id uuid REFERENCES app_content_feed_sources(id) ON DELETE CASCADE,
  item_id uuid REFERENCES app_content_feed_items(id) ON DELETE SET NULL,
  refresh_run_id uuid REFERENCES app_content_feed_refresh_runs(id) ON DELETE SET NULL,
  item_ai_run_id uuid REFERENCES app_content_feed_item_ai_runs(id) ON DELETE SET NULL,
  event_type varchar(48) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'info',
  stage varchar(64),
  message text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_operation_logs_status_check
    CHECK (status IN ('info', 'queued', 'running', 'success', 'failed', 'skipped', 'warning'))
);

CREATE INDEX IF NOT EXISTS idx_content_feed_operation_logs_app_time
  ON app_content_feed_operation_logs(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_feed_operation_logs_source_time
  ON app_content_feed_operation_logs(source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_feed_operation_logs_refresh_run
  ON app_content_feed_operation_logs(refresh_run_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_content_feed_operation_logs_item_ai_run
  ON app_content_feed_operation_logs(item_ai_run_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_content_feed_operation_logs_event_time
  ON app_content_feed_operation_logs(event_type, created_at DESC);
