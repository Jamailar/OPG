BEGIN;

CREATE INDEX IF NOT EXISTS idx_vocabulary_chapter_words_user_page
ON vocabulary_chapter_words(app_id, book_id, chapter_id, position, created_at);

CREATE INDEX IF NOT EXISTS idx_vocabulary_book_assignments_user_book
ON vocabulary_book_assignments(app_id, user_id, book_id);

CREATE INDEX IF NOT EXISTS idx_vocabulary_chapters_book_position
ON vocabulary_chapters(app_id, book_id, position, created_at);

CREATE INDEX IF NOT EXISTS idx_vocabulary_learning_states_user_status
ON vocabulary_learning_states(app_id, user_id, status, lexeme_id);

COMMIT;
