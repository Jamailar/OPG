CREATE TABLE IF NOT EXISTS user_learning_dashboard_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  language_code text,
  day date NOT NULL,
  vocabulary_reviews integer NOT NULL DEFAULT 0,
  note_count integer NOT NULL DEFAULT 0,
  exercise_attempt_count integer NOT NULL DEFAULT 0,
  correct_review_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, language_code, day)
);

CREATE INDEX IF NOT EXISTS idx_user_learning_dashboard_daily_user_day
ON user_learning_dashboard_daily(app_id, user_id, day DESC);

CREATE INDEX IF NOT EXISTS idx_user_learning_dashboard_daily_user_language_day
ON user_learning_dashboard_daily(app_id, user_id, language_code, day DESC);
