CREATE TABLE IF NOT EXISTS app_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug varchar(80) NOT NULL,
  name varchar(160) NOT NULL,
  base_url text NOT NULL,
  outbound_proxy_id uuid NULL REFERENCES outbound_proxies(id) ON DELETE SET NULL,
  timeout_ms integer NOT NULL DEFAULT 60000,
  retry_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  rate_limit_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  security_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  notes text NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_connectors_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED')),
  CONSTRAINT app_connectors_timeout_check CHECK (timeout_ms >= 1000 AND timeout_ms <= 600000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_connectors_app_slug_unique
  ON app_connectors(app_id, slug)
  WHERE status <> 'DELETED';

CREATE INDEX IF NOT EXISTS idx_app_connectors_app_status_updated
  ON app_connectors(app_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_connector_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES app_connectors(id) ON DELETE CASCADE,
  slug varchar(80) NOT NULL,
  auth_mode varchar(40) NOT NULL DEFAULT 'none',
  public_config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_json_encrypted text NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  notes text NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_connector_credentials_auth_mode_check CHECK (
    auth_mode IN ('none', 'bearer', 'basic', 'api_key_header', 'api_key_query', 'hmac_sha256', 'custom_template')
  ),
  CONSTRAINT app_connector_credentials_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_connector_credentials_slug_unique
  ON app_connector_credentials(connector_id, slug)
  WHERE status <> 'DELETED';

CREATE INDEX IF NOT EXISTS idx_app_connector_credentials_app_connector
  ON app_connector_credentials(app_id, connector_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_connector_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES app_connectors(id) ON DELETE CASCADE,
  credential_id uuid NULL REFERENCES app_connector_credentials(id) ON DELETE SET NULL,
  slug varchar(80) NOT NULL,
  name varchar(160) NULL,
  method varchar(12) NOT NULL DEFAULT 'POST',
  path_template text NOT NULL,
  input_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_mapping_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_mapping_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_mapping_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_mode varchar(24) NOT NULL DEFAULT 'sync',
  poller_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  cache_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_connector_actions_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD')),
  CONSTRAINT app_connector_actions_execution_mode_check CHECK (execution_mode IN ('sync', 'async_poll')),
  CONSTRAINT app_connector_actions_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_connector_actions_slug_unique
  ON app_connector_actions(connector_id, slug)
  WHERE status <> 'DELETED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_connector_actions_route_unique
  ON app_connector_actions(connector_id, method, path_template)
  WHERE status <> 'DELETED';

CREATE INDEX IF NOT EXISTS idx_app_connector_actions_app_connector
  ON app_connector_actions(app_id, connector_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_connector_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES app_connectors(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES app_connector_actions(id) ON DELETE CASCADE,
  credential_id uuid NULL REFERENCES app_connector_credentials(id) ON DELETE SET NULL,
  actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  trigger_type varchar(40) NOT NULL DEFAULT 'manual',
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NULL,
  status varchar(24) NOT NULL DEFAULT 'RUNNING',
  status_code integer NULL,
  latency_ms integer NULL,
  error_json jsonb NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_connector_runs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELED'))
);

CREATE INDEX IF NOT EXISTS idx_app_connector_runs_action_created
  ON app_connector_runs(action_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_connector_runs_app_status_created
  ON app_connector_runs(app_id, status, created_at DESC);
