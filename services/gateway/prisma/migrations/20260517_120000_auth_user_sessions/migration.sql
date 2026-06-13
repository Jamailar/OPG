CREATE TABLE IF NOT EXISTS auth_user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL,
  refresh_token_hash text NOT NULL,
  provider text NULL,
  user_agent text NULL,
  ip_address text NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  replaced_by_session_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_user_sessions_user_active_last_used
  ON auth_user_sessions(user_id, revoked_at, last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_user_sessions_app_user_active
  ON auth_user_sessions(app_id, user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_auth_user_sessions_session_token_hash
  ON auth_user_sessions(session_token_hash);

CREATE INDEX IF NOT EXISTS idx_auth_user_sessions_refresh_token_hash
  ON auth_user_sessions(refresh_token_hash);
