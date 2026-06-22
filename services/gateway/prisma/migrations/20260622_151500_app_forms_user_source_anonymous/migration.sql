UPDATE app_forms
SET settings_json = jsonb_set(COALESCE(settings_json, '{}'::jsonb), '{allow_anonymous}', 'true'::jsonb, true),
    updated_at = now()
WHERE form_type = 'SYSTEM_USER_SOURCE'
  AND form_key = 'user_source'
  AND COALESCE(settings_json->>'allow_anonymous', 'true') <> 'true';
