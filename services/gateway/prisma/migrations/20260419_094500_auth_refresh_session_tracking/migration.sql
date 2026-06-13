ALTER TABLE users
ADD COLUMN IF NOT EXISTS current_refresh_token_hash text NULL,
ADD COLUMN IF NOT EXISTS refresh_token_issued_at timestamptz NULL,
ADD COLUMN IF NOT EXISTS refresh_token_last_used_at timestamptz NULL;
