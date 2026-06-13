CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY,
  slug varchar(128) NOT NULL,
  name varchar(255) NOT NULL,
  description text NULL,
  scope varchar(32) NOT NULL DEFAULT 'global',
  owner_app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL,
  status varchar(32) NOT NULL DEFAULT 'draft',
  visibility varchar(32) NOT NULL DEFAULT 'private',
  latest_version_id uuid NULL,
  published_version_id uuid NULL,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS scope varchar(32) NOT NULL DEFAULT 'global';

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS owner_app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ai_agent_versions (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  system_prompt_template text NOT NULL DEFAULT '',
  developer_prompt_template text NULL,
  default_model varchar(255) NULL,
  max_steps integer NOT NULL DEFAULT 6,
  max_tool_calls integer NOT NULL DEFAULT 8,
  timeout_ms integer NOT NULL DEFAULT 60000,
  output_mode varchar(32) NOT NULL DEFAULT 'text',
  input_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_tool_bindings (
  id uuid PRIMARY KEY,
  agent_version_id uuid NOT NULL REFERENCES ai_agent_versions(id) ON DELETE CASCADE,
  tool_key varchar(128) NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_app_bindings (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  route_slug varchar(128) NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  auth_policy varchar(32) NOT NULL DEFAULT 'user',
  points_cost numeric(12,2) NOT NULL DEFAULT 0,
  model_override varchar(255) NULL,
  system_prompt_override text NULL,
  tool_override_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  agent_version_id uuid NOT NULL REFERENCES ai_agent_versions(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES ai_agent_app_bindings(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL DEFAULT 'running',
  request_id varchar(128) NULL,
  request_path varchar(512) NULL,
  input_text text NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_text text NULL,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_prompt_tokens integer NOT NULL DEFAULT 0,
  total_completion_tokens integer NOT NULL DEFAULT 0,
  total_tool_calls integer NOT NULL DEFAULT 0,
  points_charged numeric(12,2) NOT NULL DEFAULT 0,
  rmb_cost numeric(12,4) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_run_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  kind varchar(64) NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agents_slug_unique
ON ai_agents(LOWER(slug));

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_versions_agent_version_unique
ON ai_agent_versions(agent_id, version_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_tool_bindings_version_tool_unique
ON ai_agent_tool_bindings(agent_version_id, tool_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_app_bindings_app_agent_unique
ON ai_agent_app_bindings(app_id, agent_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_app_bindings_app_route_unique
ON ai_agent_app_bindings(app_id, LOWER(route_slug));

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_agent_created
ON ai_agent_runs(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_app_created
ON ai_agent_runs(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_agent_run_steps_run_step
ON ai_agent_run_steps(run_id, step_index ASC);
