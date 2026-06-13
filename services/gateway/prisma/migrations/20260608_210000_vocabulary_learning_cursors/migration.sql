BEGIN;

CREATE TABLE IF NOT EXISTS vocabulary_learning_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES vocabulary_books(id) ON DELETE CASCADE,
  next_new_chapter_id uuid NULL REFERENCES vocabulary_chapters(id) ON DELETE SET NULL,
  next_new_position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_learning_cursors_user_book
ON vocabulary_learning_cursors(app_id, user_id, book_id);

COMMIT;
