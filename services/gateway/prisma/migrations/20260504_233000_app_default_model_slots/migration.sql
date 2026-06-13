CREATE TABLE IF NOT EXISTS ai_app_default_model_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slot_key varchar(64) NOT NULL,
  primary_global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
  fallback_global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_app_default_model_slots_app_slot
ON ai_app_default_model_slots(app_id, slot_key);
