ALTER TABLE app_ai_points_settings
DROP COLUMN IF EXISTS text_chat_cost,
DROP COLUMN IF EXISTS voice_chat_cost,
DROP COLUMN IF EXISTS points_rules_json,
DROP COLUMN IF EXISTS model_costs_json;
