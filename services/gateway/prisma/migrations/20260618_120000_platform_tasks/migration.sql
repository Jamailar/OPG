CREATE TABLE IF NOT EXISTS platform_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL,
  environment_key varchar(64) NOT NULL DEFAULT 'production',
  module varchar(64) NOT NULL,
  action varchar(96) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  idempotency_key varchar(160) NULL,
  queue_name varchar(64) NOT NULL DEFAULT 'default',
  worker_id varchar(128) NULL,
  source_type varchar(64) NULL,
  source_id varchar(128) NULL,
  actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  request_id varchar(128) NULL,
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  timeout_ms integer NOT NULL DEFAULT 600000,
  progress integer NOT NULL DEFAULT 0,
  input_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_estimate_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NULL,
  error_code varchar(128) NULL,
  error_message text NULL,
  locked_at timestamptz NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  next_retry_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES platform_tasks(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  event_type varchar(96) NOT NULL,
  stage varchar(64) NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);

CREATE TABLE IF NOT EXISTS platform_task_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES platform_tasks(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  stream varchar(16) NOT NULL DEFAULT 'stdout',
  message_redacted text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);

CREATE TABLE IF NOT EXISTS platform_worker_heartbeats (
  worker_id varchar(128) PRIMARY KEY,
  kind varchar(64) NOT NULL DEFAULT 'gateway',
  queue_names_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(32) NOT NULL DEFAULT 'online',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_tasks_idempotency_unique
  ON platform_tasks(app_id, module, action, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_platform_tasks_app_status_created
  ON platform_tasks(app_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_tasks_module_status_created
  ON platform_tasks(module, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_tasks_queue_status_created
  ON platform_tasks(queue_name, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_tasks_status_retry
  ON platform_tasks(status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_tasks_actor_created
  ON platform_tasks(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_tasks_created
  ON platform_tasks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_task_events_task_seq
  ON platform_task_events(task_id, seq DESC);

CREATE INDEX IF NOT EXISTS idx_platform_task_events_type_created
  ON platform_task_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_task_logs_task_seq
  ON platform_task_logs(task_id, seq DESC);

CREATE INDEX IF NOT EXISTS idx_platform_worker_heartbeats_seen
  ON platform_worker_heartbeats(status, last_seen_at DESC);

ALTER TABLE platform_tasks SET (
  fillfactor = 85,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.03
);

ALTER TABLE platform_worker_heartbeats SET (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.03,
  autovacuum_analyze_scale_factor = 0.02
);
