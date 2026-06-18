CREATE TABLE IF NOT EXISTS developer_authorization_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  key_prefix varchar(32) NOT NULL,
  key_last4 varchar(8) NOT NULL,
  key_hash varchar(128) NOT NULL,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_app_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  last_used_at timestamptz NULL,
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_authorization_grants_hash_unique
  ON developer_authorization_grants(key_hash);

CREATE INDEX IF NOT EXISTS idx_developer_authorization_grants_prefix_status
  ON developer_authorization_grants(key_prefix, status, expires_at);

CREATE TABLE IF NOT EXISTS developer_sdk_login_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_mode varchar(24) NOT NULL DEFAULT 'APP',
  state_hash varchar(128) NOT NULL UNIQUE,
  callback_url text NOT NULL,
  client_name varchar(64) NOT NULL,
  profile_name varchar(64) NOT NULL DEFAULT 'default',
  requested_scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  granted_scopes_json jsonb NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  authorized_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  exchange_code_hash varchar(128) NULL,
  exchange_code_expires_at timestamptz NULL,
  developer_grant_id uuid NULL REFERENCES developer_authorization_grants(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  authorized_at timestamptz NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_developer_sdk_login_sessions_app_status
  ON developer_sdk_login_sessions(app_id, status, expires_at DESC);

ALTER TABLE developer_sdk_login_sessions
  ALTER COLUMN app_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS session_mode varchar(24) NOT NULL DEFAULT 'APP';
