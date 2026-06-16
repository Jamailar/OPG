ALTER TABLE ai_global_source_api_keys
ADD COLUMN IF NOT EXISTS status varchar(32) NOT NULL DEFAULT 'active';

ALTER TABLE ai_global_source_api_keys
ADD COLUMN IF NOT EXISTS disabled_reason text NULL;

ALTER TABLE ai_global_source_api_keys
ADD COLUMN IF NOT EXISTS disabled_until timestamptz NULL;

ALTER TABLE ai_global_source_api_keys
ADD COLUMN IF NOT EXISTS last_error_category varchar(64) NULL;

ALTER TABLE ai_global_source_api_keys
ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;

ALTER TABLE ai_global_source_api_keys
ADD COLUMN IF NOT EXISTS success_count bigint NOT NULL DEFAULT 0;

ALTER TABLE ai_global_source_api_keys
ADD COLUMN IF NOT EXISTS error_count bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_gateway_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
  app_slug varchar(64) NULL,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  request_id varchar(128) NULL,
  usage_reference_id varchar(128) NULL,
  request_path varchar(255) NULL,
  route_key varchar(96) NULL,
  global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
  model_key varchar(128) NULL,
  capability varchar(32) NULL,
  source_id uuid NULL REFERENCES ai_global_sources(id) ON DELETE SET NULL,
  source_name varchar(128) NULL,
  provider_type varchar(64) NULL,
  api_key_id uuid NULL REFERENCES ai_global_source_api_keys(id) ON DELETE SET NULL,
  stage varchar(64) NOT NULL,
  attempt_index integer NULL,
  success boolean NULL,
  status_code integer NULL,
  error_category varchar(64) NULL,
  error_message text NULL,
  latency_ms integer NULL,
  upstream_request_id varchar(128) NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_gateway_request_events_request
ON ai_gateway_request_events(app_id, request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_gateway_request_events_usage_reference
ON ai_gateway_request_events(usage_reference_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_gateway_request_events_source_created
ON ai_gateway_request_events(source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_provider_health (
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
  route_key varchar(96) NOT NULL,
  capability varchar(32) NOT NULL,
  api_key_id uuid NULL REFERENCES ai_global_source_api_keys(id) ON DELETE SET NULL,
  source_name varchar(128) NOT NULL,
  provider_type varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'unknown',
  consecutive_failures integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz NULL,
  last_status_code integer NULL,
  last_error_category varchar(64) NULL,
  last_error_message text NULL,
  success_count bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  latency_sum_ms bigint NOT NULL DEFAULT 0,
  latency_sample_count bigint NOT NULL DEFAULT 0,
  last_success_at timestamptz NULL,
  last_failure_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_health_unique
ON ai_provider_health(
  source_id,
  global_model_id,
  route_key,
  capability,
  COALESCE(api_key_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_health_status
ON ai_provider_health(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
  action varchar(96) NOT NULL,
  resource_type varchar(64) NOT NULL,
  resource_id varchar(128) NULL,
  before_hash varchar(64) NULL,
  after_hash varchar(64) NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_events_resource
ON ai_audit_events(resource_type, resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_audit_events_actor
ON ai_audit_events(actor_user_id, created_at DESC);
