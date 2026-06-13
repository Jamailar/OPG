ALTER TABLE app_content_feed_item_ai_runs
  DROP CONSTRAINT IF EXISTS app_content_feed_item_ai_runs_action_check;

ALTER TABLE app_content_feed_item_ai_runs
  ADD CONSTRAINT app_content_feed_item_ai_runs_action_check
  CHECK (action IN ('asr', 'review', 'summarize', 'refine', 'translate', 'pipeline'));
