CREATE TABLE IF NOT EXISTS ai_model_source_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  upstream_model varchar(256) NULL,
  endpoint_path varchar(255) NULL,
  api_type varchar(64) NULL,
  request_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_source_routes_global_unique
ON ai_model_source_routes(global_model_id, source_id)
WHERE app_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_source_routes_app_unique
ON ai_model_source_routes(app_id, global_model_id, source_id)
WHERE app_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_model_source_routes_global_lookup
ON ai_model_source_routes(global_model_id, is_active, sort_order)
WHERE app_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_model_source_routes_app_lookup
ON ai_model_source_routes(app_id, global_model_id, is_active, sort_order)
WHERE app_id IS NOT NULL;

INSERT INTO ai_model_source_routes (
  app_id,
  global_model_id,
  source_id,
  sort_order,
  is_active,
  upstream_model,
  endpoint_path,
  api_type,
  request_overrides,
  created_by_user_id,
  updated_by_user_id
)
SELECT
  NULL,
  m.id,
  m.default_source_id,
  0,
  true,
  m.upstream_model,
  m.endpoint_path,
  m.api_type,
  '{}'::jsonb,
  m.created_by_user_id,
  m.updated_by_user_id
FROM ai_global_models m
WHERE NOT EXISTS (
  SELECT 1
  FROM ai_model_source_routes r
  WHERE r.app_id IS NULL
    AND r.global_model_id = m.id
    AND r.source_id = m.default_source_id
);

INSERT INTO ai_model_source_routes (
  app_id,
  global_model_id,
  source_id,
  sort_order,
  is_active,
  request_overrides,
  created_by_user_id,
  updated_by_user_id
)
SELECT
  r.app_id,
  r.global_model_id,
  r.source_id,
  0,
  r.is_active,
  COALESCE(r.request_overrides, '{}'::jsonb),
  r.created_by_user_id,
  r.updated_by_user_id
FROM ai_app_model_routes r
WHERE NOT EXISTS (
  SELECT 1
  FROM ai_model_source_routes sr
  WHERE sr.app_id = r.app_id
    AND sr.global_model_id = r.global_model_id
    AND sr.source_id = r.source_id
);
