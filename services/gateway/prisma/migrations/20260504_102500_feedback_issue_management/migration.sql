ALTER TABLE user_feedbacks
  ADD COLUMN IF NOT EXISTS title varchar(180),
  ADD COLUMN IF NOT EXISTS category varchar(64),
  ADD COLUMN IF NOT EXISTS priority varchar(16) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS assignee_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz NULL;

UPDATE user_feedbacks
SET title = LEFT(regexp_replace(content, '\s+', ' ', 'g'), 180)
WHERE title IS NULL;

ALTER TABLE user_feedbacks
  ALTER COLUMN title SET NOT NULL;

CREATE TABLE IF NOT EXISTS user_feedback_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_feedbacks_app_priority_created
ON user_feedbacks(app_id, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedbacks_assignee_status
ON user_feedbacks(app_id, assignee_user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedback_comments_feedback_created
ON user_feedback_comments(feedback_id, created_at ASC);
