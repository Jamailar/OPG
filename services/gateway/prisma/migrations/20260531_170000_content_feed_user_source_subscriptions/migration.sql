CREATE TABLE IF NOT EXISTS app_content_feed_user_source_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES app_content_feed_sources(id) ON DELETE CASCADE,
  is_subscribed boolean NOT NULL DEFAULT true,
  subscribed_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_user_source_subscriptions_unique UNIQUE (app_id, user_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_user_source_subscriptions_user
ON app_content_feed_user_source_subscriptions(app_id, user_id, is_subscribed, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_user_source_subscriptions_source
ON app_content_feed_user_source_subscriptions(app_id, source_id, is_subscribed, updated_at DESC);
