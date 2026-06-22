CREATE TABLE IF NOT EXISTS app_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_key varchar(80) NOT NULL,
  name varchar(160) NOT NULL,
  description text NULL,
  form_type varchar(32) NOT NULL DEFAULT 'CUSTOM',
  status varchar(24) NOT NULL DEFAULT 'DRAFT',
  title varchar(180) NOT NULL,
  subtitle text NULL,
  submit_label varchar(80) NOT NULL DEFAULT '提交',
  success_title varchar(160) NOT NULL DEFAULT '提交成功',
  success_message text NULL,
  theme_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  variables_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  endings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  notification_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_version_id uuid NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL,
  CONSTRAINT app_forms_unique_key UNIQUE (app_id, form_key)
);

CREATE INDEX IF NOT EXISTS idx_app_forms_app_status
ON app_forms(app_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_forms_app_type
ON app_forms(app_id, form_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_form_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES app_forms(id) ON DELETE CASCADE,
  question_key varchar(80) NOT NULL,
  type varchar(40) NOT NULL,
  title varchar(240) NOT NULL,
  description text NULL,
  required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  options_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  properties_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_form_questions_unique_key UNIQUE (form_id, question_key)
);

CREATE INDEX IF NOT EXISTS idx_app_form_questions_form_sort
ON app_form_questions(form_id, sort_order ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_app_form_questions_app_type
ON app_form_questions(app_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS app_form_logic_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES app_forms(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  rule_type varchar(32) NOT NULL DEFAULT 'visibility',
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  conditions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_form_logic_rules_form_sort
ON app_form_logic_rules(form_id, enabled, sort_order ASC, created_at ASC);

CREATE TABLE IF NOT EXISTS app_form_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES app_forms(id) ON DELETE CASCADE,
  version integer NOT NULL,
  schema_hash varchar(96) NOT NULL,
  manifest_json jsonb NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'published',
  published_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_form_versions_unique_version UNIQUE (form_id, version),
  CONSTRAINT app_form_versions_unique_hash UNIQUE (form_id, schema_hash)
);

CREATE INDEX IF NOT EXISTS idx_app_form_versions_form_published
ON app_form_versions(form_id, published_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_forms_published_version_fk'
  ) THEN
    ALTER TABLE app_forms
      ADD CONSTRAINT app_forms_published_version_fk
      FOREIGN KEY (published_version_id) REFERENCES app_form_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_form_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES app_forms(id) ON DELETE CASCADE,
  form_version_id uuid NULL REFERENCES app_form_versions(id) ON DELETE SET NULL,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  respondent_key varchar(160) NULL,
  session_id varchar(160) NULL,
  idempotency_key varchar(160) NULL,
  status varchar(24) NOT NULL DEFAULT 'submitted',
  score numeric NULL,
  score_label varchar(80) NULL,
  hidden_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_form_responses_form_submitted
ON app_form_responses(form_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_form_responses_app_submitted
ON app_form_responses(app_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_form_responses_user
ON app_form_responses(app_id, user_id, submitted_at DESC)
WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_form_responses_idempotency
ON app_form_responses(app_id, form_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_form_answer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES app_forms(id) ON DELETE CASCADE,
  response_id uuid NOT NULL REFERENCES app_form_responses(id) ON DELETE CASCADE,
  question_id uuid NULL REFERENCES app_form_questions(id) ON DELETE SET NULL,
  question_key varchar(80) NOT NULL,
  question_type varchar(40) NOT NULL,
  value_text text NULL,
  value_number numeric NULL,
  value_boolean boolean NULL,
  value_json jsonb NOT NULL DEFAULT 'null'::jsonb,
  option_key varchar(120) NULL,
  option_label varchar(240) NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_form_answer_items_response
ON app_form_answer_items(response_id, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_app_form_answer_items_question
ON app_form_answer_items(app_id, form_id, question_key, created_at DESC);

CREATE TABLE IF NOT EXISTS app_form_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES app_forms(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  action_type varchar(48) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  trigger_event varchar(80) NOT NULL DEFAULT 'response.submitted',
  run_async boolean NOT NULL DEFAULT true,
  filters_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_form_actions_form_enabled
ON app_form_actions(form_id, enabled, trigger_event);

INSERT INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'app.forms.read'
FROM admin_roles
WHERE key IN ('readonly', 'operations', 'marketing')
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'app.forms.write'
FROM admin_roles
WHERE key IN ('operations', 'marketing')
ON CONFLICT (role_id, permission_key) DO NOTHING;
