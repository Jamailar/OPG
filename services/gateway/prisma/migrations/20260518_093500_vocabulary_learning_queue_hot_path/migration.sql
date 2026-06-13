BEGIN;

CREATE INDEX IF NOT EXISTS idx_vocabulary_learning_reviews_user_book_time
ON vocabulary_learning_reviews(app_id, user_id, book_id, reviewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_vocabulary_chapter_words_learning_queue
ON vocabulary_chapter_words(app_id, book_id, lexeme_id, chapter_id, position, created_at);

COMMIT;
