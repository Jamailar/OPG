BEGIN;

ALTER TABLE vocabulary_chapter_words
  ADD COLUMN IF NOT EXISTS sentences_json jsonb NULL,
  ADD COLUMN IF NOT EXISTS sentence_audio_url varchar(1024) NULL;

UPDATE vocabulary_chapter_words cw
SET
  sentences_json = lx.sentences_json,
  sentence_audio_url = lx.sentence_audio_url,
  updated_at = now()
FROM vocabulary_lexemes lx
WHERE lx.id = cw.lexeme_id
  AND cw.sentences_json IS NULL
  AND lx.sentences_json IS NOT NULL;

COMMIT;
