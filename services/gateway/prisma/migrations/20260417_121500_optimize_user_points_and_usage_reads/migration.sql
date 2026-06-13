CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_app_user_feed
ON ai_usage_logs(app_id, user_id, created_at DESC, id DESC)
INCLUDE (global_model_id, model_key, total_tokens, points_cost, points_pricing_source, estimated_cost_rmb);
