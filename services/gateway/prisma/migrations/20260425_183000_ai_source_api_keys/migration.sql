-- Source-level API key pools for AI forwarding.
CREATE TABLE IF NOT EXISTS ai_global_source_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
  label varchar(128) NOT NULL DEFAULT 'Default',
  api_key text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz NULL,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_global_source_api_keys_source_active_order
ON ai_global_source_api_keys(source_id, is_active, sort_order, created_at);

INSERT INTO ai_global_source_api_keys (
  source_id,
  label,
  api_key,
  sort_order,
  is_active,
  created_by_user_id,
  updated_by_user_id,
  created_at,
  updated_at
)
SELECT
  s.id,
  'Default',
  s.api_key,
  0,
  true,
  s.created_by_user_id,
  s.updated_by_user_id,
  s.created_at,
  s.updated_at
FROM ai_global_sources s
WHERE s.api_key <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM ai_global_source_api_keys k
    WHERE k.source_id = s.id
  );
