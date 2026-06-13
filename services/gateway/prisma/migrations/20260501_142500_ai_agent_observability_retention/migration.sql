ALTER TABLE ai_agent_runs
  ADD COLUMN IF NOT EXISTS route_slug varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS model_key varchar(255) NULL,
  ADD COLUMN IF NOT EXISTS output_mode varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS auth_policy varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS duration_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_name varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS error_message text NULL,
  ADD COLUMN IF NOT EXISTS observability_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days');

ALTER TABLE ai_agent_run_steps
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days');

UPDATE ai_agent_runs
   SET expires_at = created_at + interval '7 days'
 WHERE expires_at IS NULL;

UPDATE ai_agent_run_steps
   SET expires_at = created_at + interval '7 days'
 WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_expires_at
ON ai_agent_runs(expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_app_status_created
ON ai_agent_runs(app_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_route_created
ON ai_agent_runs(app_id, route_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_agent_run_steps_expires_at
ON ai_agent_run_steps(expires_at);
