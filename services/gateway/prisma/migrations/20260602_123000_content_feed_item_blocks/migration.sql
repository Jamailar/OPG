CREATE TABLE IF NOT EXISTS app_content_feed_item_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES app_content_feed_sources(id) ON DELETE CASCADE,
  guid_hash varchar(64) NOT NULL,
  guid text,
  title text,
  reason varchar(80) NOT NULL DEFAULT 'admin_deleted',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_item_blocks_unique UNIQUE (source_id, guid_hash)
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_item_blocks_app_source
ON app_content_feed_item_blocks(app_id, source_id, created_at DESC);
