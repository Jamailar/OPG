CREATE TABLE IF NOT EXISTS platform_sms_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_type varchar(32) NOT NULL,
  name varchar(128) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text NULL,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_providers_name_unique
  ON platform_sms_providers(LOWER(name));

CREATE INDEX IF NOT EXISTS idx_platform_sms_providers_type
  ON platform_sms_providers(provider_type, is_default DESC, is_active DESC, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_providers_default_unique
  ON platform_sms_providers((is_default))
  WHERE is_default = true;

CREATE TABLE IF NOT EXISTS platform_sms_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES platform_sms_providers(id) ON DELETE RESTRICT,
  sign_name varchar(128) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  notes text NULL,
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_signatures_name_unique
  ON platform_sms_signatures(provider_id, LOWER(sign_name));

CREATE INDEX IF NOT EXISTS idx_platform_sms_signatures_provider
  ON platform_sms_signatures(provider_id, is_default DESC, is_active DESC, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_signatures_default_unique
  ON platform_sms_signatures(provider_id)
  WHERE is_default = true;

CREATE TABLE IF NOT EXISTS platform_sms_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES platform_sms_providers(id) ON DELETE RESTRICT,
  template_code varchar(128) NOT NULL,
  template_name varchar(128) NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  notes text NULL,
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_templates_code_unique
  ON platform_sms_templates(provider_id, LOWER(template_code));

CREATE INDEX IF NOT EXISTS idx_platform_sms_templates_provider
  ON platform_sms_templates(provider_id, is_default DESC, is_active DESC, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_templates_default_unique
  ON platform_sms_templates(provider_id)
  WHERE is_default = true;

CREATE TABLE IF NOT EXISTS auth_sms_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  phone varchar(32) NOT NULL,
  code_hash varchar(128) NOT NULL,
  provider_id uuid NULL,
  signature_id uuid NULL,
  expire_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_lookup
  ON auth_sms_verification_codes(app_id, phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_expire
  ON auth_sms_verification_codes(expire_at DESC);

CREATE TABLE IF NOT EXISTS platform_sms_message_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id varchar(64) NOT NULL,
  app_id uuid NULL,
  purpose varchar(32) NOT NULL,
  provider_id uuid NULL,
  provider_type varchar(32) NOT NULL,
  provider_name varchar(128) NULL,
  signature_id uuid NULL,
  signature_name varchar(128) NULL,
  template_id uuid NULL,
  template_code varchar(128) NULL,
  dispatch_mode varchar(16) NOT NULL,
  phone_hash varchar(128) NULL,
  phone_masked varchar(32) NULL,
  status varchar(32) NOT NULL,
  status_code integer NULL,
  response_code varchar(128) NULL,
  response_message text NULL,
  provider_message_id varchar(255) NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  error_json jsonb NULL,
  response_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_sms_events_created
  ON platform_sms_message_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sms_events_app
  ON platform_sms_message_events(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sms_events_provider
  ON platform_sms_message_events(provider_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sms_events_trace
  ON platform_sms_message_events(trace_id);
