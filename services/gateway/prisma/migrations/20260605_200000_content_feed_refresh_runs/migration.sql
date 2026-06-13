CREATE TABLE IF NOT EXISTS app_content_feed_refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES app_content_feed_sources(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL DEFAULT 'queued',
  trigger_type varchar(24) NOT NULL DEFAULT 'manual',
  max_items_per_fetch integer NOT NULL DEFAULT 100,
  force boolean NOT NULL DEFAULT true,
  fetch_mode varchar(24),
  outbound_proxy_id uuid REFERENCES outbound_proxies(id) ON DELETE SET NULL,
  http_status integer,
  duration_ms integer,
  items_seen integer NOT NULL DEFAULT 0,
  items_upserted integer NOT NULL DEFAULT 0,
  items_skipped_missing_transcript integer NOT NULL DEFAULT 0,
  error_message text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_refresh_runs_status_check
    CHECK (status IN ('queued', 'running', 'success', 'not_modified', 'failed', 'skipped')),
  CONSTRAINT app_content_feed_refresh_runs_trigger_check
    CHECK (trigger_type IN ('manual', 'scheduler', 'system')),
  CONSTRAINT app_content_feed_refresh_runs_max_items_check
    CHECK (max_items_per_fetch BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_refresh_runs_status_time
ON app_content_feed_refresh_runs(status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_refresh_runs_source_time
ON app_content_feed_refresh_runs(source_id, created_at DESC);
