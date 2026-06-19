CREATE TABLE IF NOT EXISTS app_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug varchar(80) NOT NULL,
  name varchar(160) NULL,
  trigger_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'DRAFT',
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_workflows_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'DELETED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_workflows_app_slug_unique
  ON app_workflows(app_id, slug)
  WHERE status <> 'DELETED';

CREATE INDEX IF NOT EXISTS idx_app_workflows_app_status_updated
  ON app_workflows(app_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES app_workflows(id) ON DELETE CASCADE,
  trigger_type varchar(40) NOT NULL DEFAULT 'manual',
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NULL,
  status varchar(24) NOT NULL DEFAULT 'QUEUED',
  error_json jsonb NULL,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_workflow_runs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELED'))
);

CREATE INDEX IF NOT EXISTS idx_app_workflow_runs_workflow_created
  ON app_workflow_runs(workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_workflow_runs_app_status_created
  ON app_workflow_runs(app_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS app_workflow_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES app_workflow_runs(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES app_workflows(id) ON DELETE CASCADE,
  step_key varchar(120) NOT NULL,
  step_type varchar(60) NOT NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NULL,
  status varchar(24) NOT NULL DEFAULT 'QUEUED',
  error_json jsonb NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_workflow_run_steps_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELED'))
);

CREATE INDEX IF NOT EXISTS idx_app_workflow_run_steps_run_created
  ON app_workflow_run_steps(run_id, created_at ASC);
