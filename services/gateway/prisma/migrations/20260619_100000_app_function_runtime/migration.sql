CREATE TABLE IF NOT EXISTS app_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug varchar(80) NOT NULL,
  runtime varchar(40) NOT NULL DEFAULT 'opg-js-v1',
  entrypoint varchar(120) NOT NULL DEFAULT 'handler',
  source_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets_scope varchar(120) NULL,
  trigger_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'DRAFT',
  current_version_id uuid NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_functions_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'DELETED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_functions_app_slug_unique
  ON app_functions(app_id, slug)
  WHERE status <> 'DELETED';

CREATE INDEX IF NOT EXISTS idx_app_functions_app_status_updated
  ON app_functions(app_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_function_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id uuid NOT NULL REFERENCES app_functions(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version integer NOT NULL,
  source_hash varchar(64) NOT NULL,
  source_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  build_status varchar(24) NOT NULL DEFAULT 'READY',
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_function_versions_build_status_check CHECK (build_status IN ('READY', 'FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_function_versions_function_version
  ON app_function_versions(function_id, version);

CREATE INDEX IF NOT EXISTS idx_app_function_versions_app_created
  ON app_function_versions(app_id, created_at DESC);

ALTER TABLE app_functions
  ADD CONSTRAINT app_functions_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES app_function_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS app_function_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  function_id uuid NOT NULL REFERENCES app_functions(id) ON DELETE CASCADE,
  version_id uuid NULL REFERENCES app_function_versions(id) ON DELETE SET NULL,
  trigger_type varchar(40) NOT NULL DEFAULT 'manual',
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'QUEUED',
  output_json jsonb NULL,
  error_json jsonb NULL,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_function_runs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELED'))
);

CREATE INDEX IF NOT EXISTS idx_app_function_runs_function_created
  ON app_function_runs(function_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_function_runs_app_status_created
  ON app_function_runs(app_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS app_function_run_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES app_function_runs(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  level varchar(16) NOT NULL DEFAULT 'info',
  message text NOT NULL,
  data_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_function_run_logs_run_created
  ON app_function_run_logs(run_id, created_at ASC);
