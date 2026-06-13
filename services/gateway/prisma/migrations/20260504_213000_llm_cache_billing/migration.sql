ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS input_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS cached_input_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS cache_write_5m_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS cache_write_1h_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS output_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;

ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_cached_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_cache_write_5m_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_cache_write_1h_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_output_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;

ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS uncached_input_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS cached_input_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS cache_read_input_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS cache_creation_input_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS cache_creation_5m_input_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS cache_creation_1h_input_tokens bigint NULL;

ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_rmb_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_rmb_cached_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_rmb_cache_write_5m_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_rmb_cache_write_1h_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_rmb_output_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;

ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS billed_input_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS billed_cached_input_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS billed_cache_write_tokens bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS billed_output_tokens bigint NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_cache_created
ON ai_usage_logs(app_id, created_at DESC)
INCLUDE (cached_input_tokens, cache_read_input_tokens, cache_creation_input_tokens, billed_output_tokens);
