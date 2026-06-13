ALTER TABLE app_content_feed_user_item_states
  ADD COLUMN IF NOT EXISTS total_listened_seconds integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_app_content_feed_user_item_states_user_listened
ON app_content_feed_user_item_states(app_id, user_id, total_listened_seconds DESC, updated_at DESC);
