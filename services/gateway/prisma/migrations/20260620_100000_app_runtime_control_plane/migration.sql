CREATE TABLE IF NOT EXISTS app_module_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  module_key varchar(80) NOT NULL,
  display_name varchar(160) NOT NULL,
  category varchar(40) NOT NULL DEFAULT 'runtime',
  status varchar(24) NOT NULL DEFAULT 'active',
  source varchar(32) NOT NULL DEFAULT 'inferred',
  resource_count integer NOT NULL DEFAULT 0,
  run_count_24h integer NOT NULL DEFAULT 0,
  failure_count_24h integer NOT NULL DEFAULT 0,
  quality_score integer NOT NULL DEFAULT 0,
  runtime_config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz NULL,
  last_failure_at timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_module_registry_status_check CHECK (status IN ('active', 'warning', 'unhealthy', 'disabled')),
  CONSTRAINT app_module_registry_source_check CHECK (source IN ('inferred', 'template', 'manual', 'system')),
  CONSTRAINT app_module_registry_quality_check CHECK (quality_score >= 0 AND quality_score <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_module_registry_app_module
  ON app_module_registry(app_id, module_key);

CREATE INDEX IF NOT EXISTS idx_app_module_registry_status_updated
  ON app_module_registry(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_module_registry_app_status
  ON app_module_registry(app_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_runtime_template_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  template_key varchar(96) NOT NULL,
  template_version varchar(40) NOT NULL,
  applied_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  task_id uuid NULL REFERENCES platform_tasks(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL DEFAULT 'applied',
  module_keys_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_runtime_template_applications_status_check CHECK (status IN ('applied', 'failed', 'superseded'))
);

CREATE INDEX IF NOT EXISTS idx_app_runtime_template_app_app_created
  ON app_runtime_template_applications(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_runtime_template_app_template_created
  ON app_runtime_template_applications(template_key, created_at DESC);
