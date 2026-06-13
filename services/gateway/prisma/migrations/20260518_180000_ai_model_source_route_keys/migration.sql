ALTER TABLE ai_model_source_routes
ADD COLUMN IF NOT EXISTS route_key varchar(96) NULL;

UPDATE ai_model_source_routes
SET route_key = id::text
WHERE route_key IS NULL OR route_key = '';

ALTER TABLE ai_model_source_routes
ALTER COLUMN route_key SET NOT NULL;

DROP INDEX IF EXISTS idx_ai_model_source_routes_global_unique;
DROP INDEX IF EXISTS idx_ai_model_source_routes_app_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_source_routes_global_unique
ON ai_model_source_routes(global_model_id, route_key)
WHERE app_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_source_routes_app_unique
ON ai_model_source_routes(app_id, global_model_id, route_key)
WHERE app_id IS NOT NULL;
