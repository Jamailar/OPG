BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppStatus') THEN
    CREATE TYPE "AppStatus" AS ENUM ('ACTIVE', 'INACTIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppDomainType') THEN
    CREATE TYPE "AppDomainType" AS ENUM ('BUSINESS_ADMIN', 'PLATFORM_ADMIN', 'API', 'USER_WEB');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserRole') THEN
    CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN', 'COACH');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminType') THEN
    CREATE TYPE "AdminType" AS ENUM ('SUPER_ADMIN', 'ADMIN');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MembershipType') THEN
    CREATE TYPE "MembershipType" AS ENUM ('FREE', 'PREMIUM');
  END IF;
END $$;

-- Core tenant and user tables. This migration is the bootstrap migration for
-- self-hosted OPG installs, so it must not assume seed tables already exist.
CREATE TABLE IF NOT EXISTS apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(64) NOT NULL UNIQUE,
  name varchar(128) NOT NULL,
  status "AppStatus" NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  domain varchar(255) NOT NULL UNIQUE,
  domain_type "AppDomainType" NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  app_url text NULL,
  brand_name varchar(128) NULL,
  sender_name varchar(128) NULL,
  sender_nickname varchar(128) NULL,
  wechat_redirect_uri text NULL,
  alipay_notify_url text NULL,
  alipay_agreement_notify_url text NULL,
  extra_json jsonb NULL,
  notes text NULL,
  email_primary_color varchar(32) NULL,
  email_secondary_color varchar(32) NULL,
  email_greeting varchar(255) NULL,
  email_code_label varchar(128) NULL,
  email_expire_text varchar(255) NULL,
  email_footer_text text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email varchar(255) NOT NULL,
  hashed_password text NOT NULL DEFAULT '',
  full_name varchar(255) NULL,
  display_name varchar(255) NULL,
  avatar_url text NULL,
  role "UserRole" NOT NULL DEFAULT 'USER',
  admin_type "AdminType" NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_superuser boolean NOT NULL DEFAULT false,
  session_token text NULL,
  current_refresh_token_hash text NULL,
  refresh_token_issued_at timestamptz NULL,
  refresh_token_last_used_at timestamptz NULL,
  apple_sub varchar(255) NULL,
  apple_email varchar(255) NULL,
  wechat_openid varchar(255) NULL,
  wechat_unionid varchar(255) NULL,
  phone varchar(64) NULL,
  phone_verified boolean NOT NULL DEFAULT false,
  membership_type "MembershipType" NOT NULL DEFAULT 'FREE',
  membership_expires_at timestamptz NULL,
  account_type varchar(32) NOT NULL DEFAULT 'REGISTERED',
  primary_auth_provider varchar(64) NULL,
  is_anonymous boolean NOT NULL DEFAULT false,
  last_login_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL,
  deactivated_at timestamptz NULL,
  deactivated_by_user_id uuid NULL,
  deactivation_reason text NULL,
  deactivated_email varchar(255) NULL,
  deactivated_phone varchar(64) NULL,
  UNIQUE (email, app_id)
);

CREATE INDEX IF NOT EXISTS idx_app_domains_app_id ON app_domains(app_id);
CREATE INDEX IF NOT EXISTS idx_users_app_id ON users(app_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_session_token ON users(session_token);
CREATE INDEX IF NOT EXISTS idx_users_apple_sub ON users(apple_sub);
CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid);
CREATE INDEX IF NOT EXISTS idx_users_wechat_unionid ON users(wechat_unionid);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

CREATE TABLE IF NOT EXISTS content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL DEFAULT '',
  content_type varchar(64) NOT NULL DEFAULT 'document',
  status varchar(32) NOT NULL DEFAULT 'draft',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS content_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL DEFAULT 'assigned',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocabulary_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL DEFAULT '',
  language varchar(50) NOT NULL DEFAULT 'en',
  cover_url varchar(2048) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocabulary_chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES vocabulary_books(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL DEFAULT '',
  cover_url varchar(2048) NULL,
  position integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocabulary_book_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES vocabulary_books(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL DEFAULT 'assigned',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, book_id)
);

-- Platform analytics read models and refresh state.
CREATE TABLE IF NOT EXISTS analytics_fact_refresh_state (
  job_name varchar(64) NOT NULL,
  scope_key varchar(255) PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  timezone varchar(64) NOT NULL,
  from_day date NOT NULL,
  to_day date NOT NULL,
  last_refresh_started_at timestamptz NULL,
  last_refresh_completed_at timestamptz NULL,
  last_error text NULL
);

CREATE TABLE IF NOT EXISTS app_user_daily_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  timezone varchar(64) NOT NULL,
  fact_day date NOT NULL,
  registrations_count bigint NOT NULL DEFAULT 0,
  activated_registrations_count bigint NOT NULL DEFAULT 0,
  first_login_registrations_count bigint NOT NULL DEFAULT 0,
  active_users_count bigint NOT NULL DEFAULT 0,
  paid_users_count bigint NOT NULL DEFAULT 0,
  revenue_amount numeric(20, 2) NOT NULL DEFAULT 0,
  reactivated_users_count bigint NOT NULL DEFAULT 0,
  repeat_buyers_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, timezone, fact_day)
);

CREATE TABLE IF NOT EXISTS app_user_cohort_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  timezone varchar(64) NOT NULL,
  cohort_day date NOT NULL,
  cohort_size bigint NOT NULL DEFAULT 0,
  d1_users_count bigint NOT NULL DEFAULT 0,
  d3_users_count bigint NOT NULL DEFAULT 0,
  d7_users_count bigint NOT NULL DEFAULT 0,
  d14_users_count bigint NOT NULL DEFAULT 0,
  d30_users_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, timezone, cohort_day)
);

CREATE TABLE IF NOT EXISTS app_user_conversion_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  timezone varchar(64) NOT NULL,
  fact_day date NOT NULL,
  registered_users_count bigint NOT NULL DEFAULT 0,
  activated_users_count bigint NOT NULL DEFAULT 0,
  first_login_users_count bigint NOT NULL DEFAULT 0,
  first_paid_users_count bigint NOT NULL DEFAULT 0,
  repeat_paid_users_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, timezone, fact_day)
);

CREATE TABLE IF NOT EXISTS app_user_segment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  timezone varchar(64) NOT NULL,
  snapshot_day date NOT NULL,
  segment_type varchar(64) NOT NULL,
  segment_key varchar(128) NOT NULL,
  users_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, timezone, snapshot_day, segment_type, segment_key)
);

CREATE TABLE IF NOT EXISTS app_user_activity_summary (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_activity_at timestamptz NULL,
  recent_event varchar(128) NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_user_payment_summary (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paid_orders_total bigint NOT NULL DEFAULT 0,
  paid_amount_total numeric(20, 2) NOT NULL DEFAULT 0,
  last_paid_at timestamptz NULL,
  recent_order varchar(128) NULL,
  recent_recharge timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_user_ai_usage_summary (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_requests_total bigint NOT NULL DEFAULT 0,
  ai_total_tokens bigint NOT NULL DEFAULT 0,
  ai_points_spent_total numeric(20, 2) NOT NULL DEFAULT 0,
  last_ai_request_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_user_profile_summary (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_source varchar(64) NULL,
  resolved_login_method varchar(32) NOT NULL DEFAULT 'email',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_fact_refresh_state_job_completed
ON analytics_fact_refresh_state(job_name, last_refresh_completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_fact_refresh_state_app_window
ON analytics_fact_refresh_state(app_id, timezone, from_day, to_day);

CREATE INDEX IF NOT EXISTS idx_app_user_daily_facts_lookup
ON app_user_daily_facts(app_id, timezone, fact_day);

CREATE INDEX IF NOT EXISTS idx_app_user_cohort_facts_lookup
ON app_user_cohort_facts(app_id, timezone, cohort_day);

CREATE INDEX IF NOT EXISTS idx_app_user_conversion_facts_lookup
ON app_user_conversion_facts(app_id, timezone, fact_day);

CREATE INDEX IF NOT EXISTS idx_app_user_segment_snapshots_lookup
ON app_user_segment_snapshots(app_id, timezone, snapshot_day, segment_type);

CREATE INDEX IF NOT EXISTS idx_app_user_activity_summary_last_activity
ON app_user_activity_summary(app_id, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_user_payment_summary_last_paid
ON app_user_payment_summary(app_id, last_paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_user_profile_summary_source
ON app_user_profile_summary(app_id, first_source, resolved_login_method);

-- Core query indexes for analytics/users/payment/AI usage lookups.
CREATE INDEX IF NOT EXISTS idx_users_app_deleted_created_at
ON users(app_id, deleted_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_app_deleted_last_login_at
ON users(app_id, deleted_at, last_login_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_app_membership_deleted_created_at
ON users(app_id, membership_type, deleted_at, created_at DESC);

-- AI routing and facts.
CREATE TABLE IF NOT EXISTS ai_global_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  provider_type varchar(64) NOT NULL DEFAULT 'openai-compatible',
  base_url text NOT NULL,
  api_key text NOT NULL,
  custom_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_global_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key varchar(128) NOT NULL,
  display_name varchar(128) NOT NULL,
  capability varchar(32) NOT NULL DEFAULT 'chat',
  execution_mode varchar(16) NOT NULL DEFAULT 'sync',
  pricing_mode varchar(16) NOT NULL DEFAULT 'per_mtoken',
  rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
  rmb_per_call numeric(16,6) NOT NULL DEFAULT 0,
  rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0,
  points_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
  points_per_call numeric(16,6) NOT NULL DEFAULT 0,
  points_per_minute numeric(16,6) NOT NULL DEFAULT 0,
  default_source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
  upstream_model varchar(256) NOT NULL,
  endpoint_path varchar(255) NOT NULL DEFAULT '/chat/completions',
  api_type varchar(64) NOT NULL DEFAULT 'openai-chat-completions',
  request_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  is_visible boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS capability varchar(32) NOT NULL DEFAULT 'chat';
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS execution_mode varchar(16) NOT NULL DEFAULT 'sync';
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS pricing_mode varchar(16) NOT NULL DEFAULT 'per_mtoken';
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS rmb_per_call numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_per_mtoken numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_per_call numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS points_per_minute numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_global_models
ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS ai_app_model_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  request_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, global_model_id)
);

CREATE TABLE IF NOT EXISTS ai_app_capability_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  capability varchar(32) NOT NULL,
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, capability)
);

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  app_slug varchar(64) NOT NULL,
  user_id uuid NULL,
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE RESTRICT,
  model_key varchar(128) NOT NULL,
  upstream_model varchar(256) NOT NULL,
  capability varchar(32) NOT NULL,
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
  source_name varchar(128) NOT NULL,
  provider_type varchar(64) NOT NULL,
  endpoint_path varchar(255) NOT NULL,
  request_path varchar(255) NULL,
  request_id varchar(128) NULL,
  is_stream boolean NOT NULL DEFAULT false,
  success boolean NOT NULL DEFAULT true,
  error_message text NULL,
  prompt_tokens bigint NULL,
  completion_tokens bigint NULL,
  total_tokens bigint NULL,
  unit_price_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
  unit_price_rmb_per_call numeric(16,6) NOT NULL DEFAULT 0,
  unit_price_rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0,
  unit_price_mode varchar(16) NOT NULL DEFAULT 'per_mtoken',
  billed_units numeric(18,6) NULL,
  billed_unit_label varchar(32) NULL,
  billed_duration_seconds bigint NULL,
  estimated_cost_rmb numeric(18,6) NOT NULL DEFAULT 0,
  points_cost numeric(20,2) NULL,
  points_pricing_source varchar(64) NULL,
  usage_reference_id varchar(128) NULL,
  latency_ms int NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_rmb_per_call numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_mode varchar(16) NOT NULL DEFAULT 'per_mtoken';
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS unit_price_rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS billed_units numeric(18,6) NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS billed_unit_label varchar(32) NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS billed_duration_seconds bigint NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS points_cost numeric(20,2) NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS points_pricing_source varchar(64) NULL;
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS usage_reference_id varchar(128) NULL;

CREATE TABLE IF NOT EXISTS ai_usage_daily_facts (
  fact_day date NOT NULL,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
  model_key varchar(128) NOT NULL,
  capability varchar(32) NOT NULL,
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
  source_name varchar(128) NOT NULL,
  provider_type varchar(64) NOT NULL,
  requests_total bigint NOT NULL DEFAULT 0,
  success_total bigint NOT NULL DEFAULT 0,
  error_total bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  total_billed_units numeric(18,6) NOT NULL DEFAULT 0,
  total_cost_rmb numeric(18,6) NOT NULL DEFAULT 0,
  total_points_cost numeric(20,2) NOT NULL DEFAULT 0,
  latency_sum_ms bigint NOT NULL DEFAULT 0,
  latency_sample_count bigint NOT NULL DEFAULT 0,
  estimated_points_requests bigint NOT NULL DEFAULT 0,
  unit_price_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
  unit_price_rmb_per_call numeric(16,6) NOT NULL DEFAULT 0,
  unit_price_rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0,
  unit_price_mode varchar(16) NOT NULL DEFAULT 'per_mtoken',
  billed_unit_label varchar(32) NULL,
  last_called_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_day, app_id, global_model_id, capability, source_id)
);

CREATE TABLE IF NOT EXISTS ai_usage_user_daily_facts (
  fact_day date NOT NULL,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
  model_key varchar(128) NOT NULL,
  capability varchar(32) NOT NULL,
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
  requests_total bigint NOT NULL DEFAULT 0,
  success_total bigint NOT NULL DEFAULT 0,
  error_total bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  total_billed_units numeric(18,6) NOT NULL DEFAULT 0,
  total_cost_rmb numeric(18,6) NOT NULL DEFAULT 0,
  total_points_cost numeric(20,2) NOT NULL DEFAULT 0,
  last_called_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_day, app_id, user_id, global_model_id, capability, source_id)
);

CREATE TABLE IF NOT EXISTS ai_usage_fact_refresh_state (
  job_name varchar(64) PRIMARY KEY,
  last_processed_at timestamptz NULL,
  last_refresh_started_at timestamptz NULL,
  last_refresh_completed_at timestamptz NULL,
  last_error text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_global_sources_name_unique
ON ai_global_sources(LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_global_models_model_key_unique
ON ai_global_models(model_key);
CREATE INDEX IF NOT EXISTS idx_ai_global_models_default
ON ai_global_models(is_default DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_global_models_capability
ON ai_global_models(capability, is_default DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_app_model_routes_app_model
ON ai_app_model_routes(app_id, global_model_id);
CREATE INDEX IF NOT EXISTS idx_ai_app_capability_defaults_app_capability
ON ai_app_capability_defaults(app_id, capability);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at
ON ai_usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_app_created
ON ai_usage_logs(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_app_user_created
ON ai_usage_logs(app_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_model_created
ON ai_usage_logs(global_model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_usage_reference
ON ai_usage_logs(usage_reference_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_facts_lookup
ON ai_usage_daily_facts(fact_day, app_id, capability, global_model_id, source_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_daily_facts_lookup
ON ai_usage_user_daily_facts(fact_day, app_id, capability, global_model_id, source_id, user_id);

-- AI points storage.
CREATE TABLE IF NOT EXISTS app_ai_points_settings (
  app_id uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  text_chat_cost integer NOT NULL DEFAULT 5,
  voice_chat_cost integer NOT NULL DEFAULT 10,
  points_rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_costs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  initial_points integer NOT NULL DEFAULT 200,
  points_per_yuan integer NOT NULL DEFAULT 100,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_ai_points_settings
ADD COLUMN IF NOT EXISTS points_rules_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app_ai_points_settings
ADD COLUMN IF NOT EXISTS model_costs_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app_ai_points_settings
ADD COLUMN IF NOT EXISTS points_per_yuan integer NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS user_ai_points_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance numeric(20, 2) NOT NULL DEFAULT 0,
  total_earned numeric(20, 2) NOT NULL DEFAULT 0,
  total_spent numeric(20, 2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_ai_points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta numeric(20, 2) NOT NULL,
  balance_after numeric(20, 2) NOT NULL,
  event_type varchar(64) NOT NULL,
  reference_type varchar(64) NULL,
  reference_id varchar(128) NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_ai_points_wallets
ALTER COLUMN balance TYPE numeric(20, 2)
USING balance::numeric(20, 2);
ALTER TABLE user_ai_points_wallets
ALTER COLUMN total_earned TYPE numeric(20, 2)
USING total_earned::numeric(20, 2);
ALTER TABLE user_ai_points_wallets
ALTER COLUMN total_spent TYPE numeric(20, 2)
USING total_spent::numeric(20, 2);
ALTER TABLE user_ai_points_ledger
ALTER COLUMN delta TYPE numeric(20, 2)
USING delta::numeric(20, 2);
ALTER TABLE user_ai_points_ledger
ALTER COLUMN balance_after TYPE numeric(20, 2)
USING balance_after::numeric(20, 2);

CREATE TABLE IF NOT EXISTS user_ai_points_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reservation_key varchar(128) NOT NULL,
  external_task_id varchar(128) NULL,
  usage_reference_id varchar(128) NULL,
  capability varchar(32) NOT NULL DEFAULT 'video',
  reserved_points numeric(20, 2) NOT NULL DEFAULT 0,
  settled_points numeric(20, 2) NOT NULL DEFAULT 0,
  status varchar(32) NOT NULL DEFAULT 'pending',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_user_ai_points_wallets_app_user
ON user_ai_points_wallets(app_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_lookup
ON user_ai_points_ledger(app_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_reference_lookup
ON user_ai_points_ledger(app_id, reference_type, reference_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_request_id_lookup
ON user_ai_points_ledger(app_id, reference_type, ((metadata_json->>'request_id')), created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ai_points_reservations_unique_key
ON user_ai_points_reservations(app_id, user_id, reservation_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ai_points_reservations_unique_task
ON user_ai_points_reservations(app_id, user_id, external_task_id)
WHERE external_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_ai_points_reservations_lookup
ON user_ai_points_reservations(app_id, user_id, status, created_at DESC);

-- Payments, behavior analytics, and platform-admin support tables.
CREATE TABLE IF NOT EXISTS payment_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  code varchar(64) NOT NULL,
  name varchar(128) NOT NULL,
  description text NULL,
  type varchar(32) NOT NULL DEFAULT 'ONE_TIME',
  status varchar(32) NOT NULL DEFAULT 'ACTIVE',
  amount numeric(10, 2) NOT NULL,
  currency varchar(8) NOT NULL DEFAULT 'CNY',
  membership_days integer NOT NULL DEFAULT 0,
  points_topup integer NOT NULL DEFAULT 0,
  sign_scene varchar(64) NULL,
  sign_validity_period integer NULL DEFAULT 365,
  period_type varchar(16) NULL,
  period integer NULL,
  execute_time varchar(32) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);

CREATE TABLE IF NOT EXISTS alipay_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  out_trade_no varchar(64) NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES payment_products(id) ON DELETE RESTRICT,
  subject varchar(256) NOT NULL,
  total_amount numeric(10, 2) NOT NULL,
  original_amount numeric(10, 2) NULL,
  payable_amount numeric(10, 2) NULL,
  points_deduct_points bigint NOT NULL DEFAULT 0,
  points_deduct_amount numeric(10, 2) NOT NULL DEFAULT 0,
  points_deduct_ledger_id varchar(128) NULL,
  points_refund_ledger_id varchar(128) NULL,
  points_refund_status varchar(16) NOT NULL DEFAULT 'NONE',
  points_topup_points bigint NOT NULL DEFAULT 0,
  points_topup_ledger_id varchar(128) NULL,
  points_topup_status varchar(16) NOT NULL DEFAULT 'NONE',
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  trade_no varchar(64) NULL,
  trade_status varchar(64) NULL,
  payment_type varchar(32) NOT NULL DEFAULT 'ONE_TIME',
  notify_payload jsonb NULL,
  paid_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS original_amount numeric(10, 2) NULL;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS payable_amount numeric(10, 2) NULL;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_deduct_points bigint NOT NULL DEFAULT 0;
ALTER TABLE alipay_orders ALTER COLUMN points_deduct_points TYPE bigint USING points_deduct_points::bigint;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_deduct_amount numeric(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_deduct_ledger_id varchar(128) NULL;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_refund_ledger_id varchar(128) NULL;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_refund_status varchar(16) NOT NULL DEFAULT 'NONE';
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_topup_points bigint NOT NULL DEFAULT 0;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_topup_ledger_id varchar(128) NULL;
ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_topup_status varchar(16) NOT NULL DEFAULT 'NONE';

CREATE TABLE IF NOT EXISTS alipay_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES payment_products(id) ON DELETE RESTRICT,
  external_agreement_no varchar(64) NOT NULL UNIQUE,
  agreement_no varchar(64) NULL UNIQUE,
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  sign_scene varchar(64) NULL,
  period_type varchar(16) NULL,
  period integer NULL,
  execute_time varchar(32) NULL,
  sign_validity_period integer NULL,
  notify_payload jsonb NULL,
  signed_at timestamptz NULL,
  invalid_at timestamptz NULL,
  next_deduction_at timestamptz NULL,
  last_deducted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alipay_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agreement_id uuid NOT NULL REFERENCES alipay_agreements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES payment_products(id) ON DELETE RESTRICT,
  out_trade_no varchar(64) NOT NULL UNIQUE,
  amount numeric(10, 2) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  trade_no varchar(64) NULL,
  trade_status varchar(64) NULL,
  response_payload jsonb NULL,
  executed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alipay_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES alipay_orders(id) ON DELETE CASCADE,
  out_trade_no varchar(64) NOT NULL,
  out_request_no varchar(64) NOT NULL,
  refund_amount numeric(10, 2) NOT NULL,
  refund_reason varchar(256) NULL,
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  refund_fee numeric(10, 2) NULL,
  refund_no varchar(64) NULL,
  gmt_refund_pay timestamptz NULL,
  response_payload jsonb NULL,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, out_request_no)
);

CREATE INDEX IF NOT EXISTS idx_payment_products_app_created
ON payment_products(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_created
ON alipay_orders(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_user
ON alipay_orders(app_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_status_paid_at
ON alipay_orders(app_id, status, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_user_status_paid_at
ON alipay_orders(app_id, user_id, status, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_agreements_app_status
ON alipay_agreements(app_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_agreements_due
ON alipay_agreements(app_id, next_deduction_at);
CREATE INDEX IF NOT EXISTS idx_alipay_deductions_app_created
ON alipay_deductions(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_deductions_agreement_created
ON alipay_deductions(agreement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_refunds_app_created
ON alipay_refunds(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alipay_refunds_order_created
ON alipay_refunds(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_behavior_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  session_id varchar(80) NULL,
  event_name varchar(64) NOT NULL,
  event_category varchar(64) NOT NULL DEFAULT 'engagement',
  route_path varchar(512) NULL,
  referrer_path varchar(512) NULL,
  language_code varchar(16) NULL,
  source varchar(32) NOT NULL DEFAULT 'web',
  event_value numeric(14, 4) NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_agent varchar(512) NULL,
  ip_address varchar(64) NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_time
ON user_behavior_events(app_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_user_time
ON user_behavior_events(app_id, user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_session_time
ON user_behavior_events(app_id, session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_event_time
ON user_behavior_events(app_id, event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_route_time
ON user_behavior_events(app_id, route_path, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_user_occurred_at
ON user_behavior_events(app_id, user_id, occurred_at ASC);

CREATE TABLE IF NOT EXISTS wechat_open_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  app_id varchar(128) NOT NULL,
  app_secret text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_open_apps_name_unique
ON wechat_open_apps(LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_open_apps_appid_unique
ON wechat_open_apps(LOWER(app_id));
CREATE INDEX IF NOT EXISTS idx_wechat_open_apps_active
ON wechat_open_apps(is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_payment_methods (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_payment_methods_name_unique
ON platform_payment_methods(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_platform_payment_methods_provider
ON platform_payment_methods(provider_type, is_default DESC, is_active DESC, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_payment_methods_provider_default_unique
ON platform_payment_methods(provider_type)
WHERE is_default = true;

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
  provider_id uuid NOT NULL,
  sign_name varchar(96) NOT NULL,
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
  provider_id uuid NOT NULL,
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

-- Content-distribution runtime tables.
CREATE TABLE IF NOT EXISTS document_exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL,
  prompt_locale varchar(16) NOT NULL DEFAULT 'target',
  source_revision integer NOT NULL DEFAULT 0,
  source_anchor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  exercise_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_text text NOT NULL DEFAULT '',
  source_origin_text text NOT NULL DEFAULT '',
  source_origin_body_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_text_start_offset integer,
  source_block_id varchar(128),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE document_exercises ADD COLUMN IF NOT EXISTS source_origin_text text NOT NULL DEFAULT '';
ALTER TABLE document_exercises ADD COLUMN IF NOT EXISTS source_origin_body_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE document_exercises ADD COLUMN IF NOT EXISTS source_text_start_offset integer;
ALTER TABLE document_exercises ADD COLUMN IF NOT EXISTS prompt_locale varchar(16);
ALTER TABLE document_exercises ADD COLUMN IF NOT EXISTS source_revision integer;
ALTER TABLE document_exercises ADD COLUMN IF NOT EXISTS source_anchor_json jsonb;
ALTER TABLE document_exercises ADD COLUMN IF NOT EXISTS metadata_json jsonb;
UPDATE document_exercises SET prompt_locale = 'target' WHERE prompt_locale IS NULL OR TRIM(prompt_locale) = '';
ALTER TABLE document_exercises ALTER COLUMN prompt_locale SET DEFAULT 'target';
ALTER TABLE document_exercises ALTER COLUMN prompt_locale SET NOT NULL;
UPDATE document_exercises SET source_revision = 0 WHERE source_revision IS NULL;
ALTER TABLE document_exercises ALTER COLUMN source_revision SET DEFAULT 0;
ALTER TABLE document_exercises ALTER COLUMN source_revision SET NOT NULL;
UPDATE document_exercises SET source_anchor_json = '{}'::jsonb WHERE source_anchor_json IS NULL;
UPDATE document_exercises SET metadata_json = '{}'::jsonb WHERE metadata_json IS NULL;
ALTER TABLE document_exercises ALTER COLUMN source_anchor_json SET DEFAULT '{}'::jsonb;
ALTER TABLE document_exercises ALTER COLUMN source_anchor_json SET NOT NULL;
ALTER TABLE document_exercises ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
ALTER TABLE document_exercises ALTER COLUMN metadata_json SET NOT NULL;

CREATE TABLE IF NOT EXISTS document_exercise_batch_tasks (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  kind varchar(64) NOT NULL DEFAULT 'document_exercises',
  status varchar(32) NOT NULL DEFAULT 'running',
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS document_exercise_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  exercise_id uuid NOT NULL REFERENCES document_exercises(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES content_assignments(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  score numeric(6,2) NOT NULL DEFAULT 0,
  correct_count integer NOT NULL DEFAULT 0,
  total_count integer NOT NULL DEFAULT 0,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_reader_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES content_assignments(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine varchar(32) NOT NULL DEFAULT 'blocknote-page',
  chapter_id varchar(128),
  annotation_type varchar(16) NOT NULL,
  start_paragraph integer NOT NULL DEFAULT 0,
  start_offset integer NOT NULL DEFAULT 0,
  end_paragraph integer NOT NULL DEFAULT 0,
  end_offset integer NOT NULL DEFAULT 0,
  selected_text text NOT NULL DEFAULT '',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_reader_annotations_type_check
    CHECK (annotation_type IN ('underline', 'note'))
);

CREATE INDEX IF NOT EXISTS idx_document_exercise_batch_tasks_app_node_updated_at
ON document_exercise_batch_tasks(app_id, node_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_exercises_content
ON document_exercises(app_id, content_item_id, created_at DESC)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_exercise_attempts_user
ON document_exercise_attempts(app_id, user_id, exercise_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_reader_annotations_assignment
ON content_reader_annotations(app_id, user_id, assignment_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_content_reader_annotations_content
ON content_reader_annotations(app_id, user_id, content_item_id, created_at DESC);

-- Second-batch migration of remaining runtime schema.
CREATE TABLE IF NOT EXISTS redeem_runtime_migrations (
  name varchar(128) PRIMARY KEY,
  executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlement_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  description text NULL,
  cover_url text NULL,
  price_cny numeric(10, 2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE entitlement_packages ADD COLUMN IF NOT EXISTS price_cny numeric(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE entitlement_packages ADD COLUMN IF NOT EXISTS cover_url text NULL;
ALTER TABLE entitlement_packages ADD COLUMN IF NOT EXISTS language_code varchar(16) NULL;

CREATE TABLE IF NOT EXISTS entitlement_package_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES entitlement_packages(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  scope varchar(48) NOT NULL,
  resource_id uuid NULL,
  language_code varchar(16) NULL,
  days integer NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlement_code_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  note text NULL,
  code_prefix varchar(16) NULL,
  total_count integer NOT NULL DEFAULT 0,
  max_uses integer NOT NULL DEFAULT 1,
  expires_at timestamptz NULL,
  package_id uuid NULL REFERENCES entitlement_packages(id) ON DELETE SET NULL,
  grants_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlement_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  batch_id uuid NULL REFERENCES entitlement_code_batches(id) ON DELETE SET NULL,
  code varchar(64) NOT NULL,
  package_id uuid NULL REFERENCES entitlement_packages(id) ON DELETE SET NULL,
  grants_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text NULL,
  max_uses integer NOT NULL DEFAULT 1,
  used_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  void_reason text NULL,
  first_used_by_user_id uuid NULL,
  first_used_at timestamptz NULL,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);

CREATE TABLE IF NOT EXISTS entitlement_code_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  code_id uuid NOT NULL REFERENCES entitlement_codes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applied_grants_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  revoked_at timestamptz NULL,
  revoked_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code_id, user_id)
);

ALTER TABLE entitlement_code_redemptions ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL;
ALTER TABLE entitlement_code_redemptions ADD COLUMN IF NOT EXISTS revoked_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE entitlement_code_redemptions ADD COLUMN IF NOT EXISTS revoke_reason text NULL;

CREATE TABLE IF NOT EXISTS user_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement_key varchar(255) NOT NULL,
  scope varchar(48) NOT NULL,
  resource_id uuid NULL,
  language_code varchar(16) NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  is_active boolean NOT NULL DEFAULT true,
  source_code_id uuid NULL REFERENCES entitlement_codes(id) ON DELETE SET NULL,
  source_redemption_id uuid NULL REFERENCES entitlement_code_redemptions(id) ON DELETE SET NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, entitlement_key)
);

CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type varchar(64) NOT NULL DEFAULT 'system',
  title varchar(200) NOT NULL,
  message text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_packages_app_name_unique
ON entitlement_packages(app_id, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_entitlement_package_items_package
ON entitlement_package_items(app_id, package_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_entitlement_code_batches_app
ON entitlement_code_batches(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entitlement_codes_app_status
ON entitlement_codes(app_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entitlement_codes_batch
ON entitlement_codes(app_id, batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entitlement_redemptions_user
ON entitlement_code_redemptions(app_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entitlement_redemptions_revoked
ON entitlement_code_redemptions(app_id, revoked_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_entitlements_active
ON user_entitlements(app_id, user_id, is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
ON user_notifications(app_id, user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS user_feedbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content text NOT NULL,
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'pending',
  reward_points integer NOT NULL DEFAULT 0,
  admin_note text NULL,
  handled_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  handled_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_feedbacks_app_status_created
ON user_feedbacks(app_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_feedbacks_user_created
ON user_feedbacks(app_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  language_slug varchar(64) NOT NULL,
  language_label varchar(64) NOT NULL,
  slug varchar(160) NOT NULL,
  title varchar(255) NOT NULL,
  short_title varchar(255) NOT NULL,
  resource_type varchar(64) NOT NULL DEFAULT '免费 PDF',
  difficulty varchar(64),
  page_count integer NOT NULL DEFAULT 0,
  summary text NOT NULL DEFAULT '',
  seo_title varchar(255) NOT NULL,
  seo_description text NOT NULL DEFAULT '',
  cover_url varchar(2048),
  pdf_url varchar(2048),
  downloadable boolean NOT NULL DEFAULT true,
  status varchar(32) NOT NULL DEFAULT 'published',
  is_indexable boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  keyword_targets_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  highlights_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  sections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  faq_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_resources_status_check
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT public_resources_unique_path UNIQUE (app_id, language_slug, slug)
);
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS short_title varchar(255);
UPDATE public_resources SET short_title = title WHERE short_title IS NULL OR TRIM(short_title) = '';
ALTER TABLE public_resources ALTER COLUMN short_title SET NOT NULL;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS resource_type varchar(64) NOT NULL DEFAULT '免费 PDF';
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS difficulty varchar(64);
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS page_count integer NOT NULL DEFAULT 0;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS downloadable boolean NOT NULL DEFAULT true;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS status varchar(32) NOT NULL DEFAULT 'published';
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS is_indexable boolean NOT NULL DEFAULT true;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS keyword_targets_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS highlights_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS sections_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS faq_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_public_resources_public_lookup
ON public_resources(app_id, status, is_indexable, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_resources_language_lookup
ON public_resources(app_id, language_slug, status, is_indexable, sort_order, created_at DESC);

CREATE TABLE IF NOT EXISTS redbox_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  key_prefix varchar(32) NOT NULL,
  key_last4 varchar(8) NOT NULL,
  key_hash varchar(128) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_redbox_api_keys_key_hash_unique
ON redbox_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_redbox_api_keys_app_user_created
ON redbox_api_keys(app_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY,
  slug varchar(128) NOT NULL,
  name varchar(255) NOT NULL,
  description text NULL,
  scope varchar(32) NOT NULL DEFAULT 'global',
  owner_app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL,
  status varchar(32) NOT NULL DEFAULT 'draft',
  visibility varchar(32) NOT NULL DEFAULT 'private',
  latest_version_id uuid NULL,
  published_version_id uuid NULL,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS scope varchar(32) NOT NULL DEFAULT 'global';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS owner_app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ai_agent_versions (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  system_prompt_template text NOT NULL DEFAULT '',
  developer_prompt_template text NULL,
  default_model varchar(255) NULL,
  max_steps integer NOT NULL DEFAULT 6,
  max_tool_calls integer NOT NULL DEFAULT 8,
  timeout_ms integer NOT NULL DEFAULT 60000,
  output_mode varchar(32) NOT NULL DEFAULT 'text',
  input_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_tool_bindings (
  id uuid PRIMARY KEY,
  agent_version_id uuid NOT NULL REFERENCES ai_agent_versions(id) ON DELETE CASCADE,
  tool_key varchar(128) NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_app_bindings (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  route_slug varchar(128) NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  auth_policy varchar(32) NOT NULL DEFAULT 'user',
  points_cost numeric(12,2) NOT NULL DEFAULT 0,
  model_override varchar(255) NULL,
  system_prompt_override text NULL,
  tool_override_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  agent_version_id uuid NOT NULL REFERENCES ai_agent_versions(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES ai_agent_app_bindings(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL DEFAULT 'running',
  request_id varchar(128) NULL,
  request_path varchar(512) NULL,
  input_text text NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_text text NULL,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_prompt_tokens integer NOT NULL DEFAULT 0,
  total_completion_tokens integer NOT NULL DEFAULT 0,
  total_tool_calls integer NOT NULL DEFAULT 0,
  points_charged numeric(12,2) NOT NULL DEFAULT 0,
  rmb_cost numeric(12,4) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_agent_run_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  kind varchar(64) NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agents_slug_unique
ON ai_agents(LOWER(slug));
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_versions_agent_version_unique
ON ai_agent_versions(agent_id, version_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_tool_bindings_version_tool_unique
ON ai_agent_tool_bindings(agent_version_id, tool_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_app_bindings_app_agent_unique
ON ai_agent_app_bindings(app_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_app_bindings_app_route_unique
ON ai_agent_app_bindings(app_id, LOWER(route_slug));
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_agent_created
ON ai_agent_runs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_app_created
ON ai_agent_runs(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_run_steps_run_step
ON ai_agent_run_steps(run_id, step_index ASC);

CREATE TABLE IF NOT EXISTS ai_assistant_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language varchar(16) NOT NULL DEFAULT 'it',
  title varchar(255) NOT NULL DEFAULT '新会话',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS ai_assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES ai_assistant_sessions(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  role varchar(16) NOT NULL,
  input_type varchar(16) NOT NULL DEFAULT 'text',
  content text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_assistant_app_settings (
  app_id uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_assistant_sessions_user_last
ON ai_assistant_sessions(app_id, user_id, last_message_at DESC)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_assistant_messages_session_created
ON ai_assistant_messages(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS auth_sms_verification_codes (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  phone varchar(64) NOT NULL,
  code_hash varchar(128) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  provider_id uuid NULL,
  signature_id uuid NULL,
  expire_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_lookup
ON auth_sms_verification_codes(app_id, phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_expire
ON auth_sms_verification_codes(expire_at DESC);

CREATE TABLE IF NOT EXISTS auth_invite_codes (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_invite_redemptions (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  inviter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code varchar(64) NOT NULL,
  reward_points integer NOT NULL DEFAULT 200,
  credited_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth_invite_redemptions
ALTER COLUMN reward_points SET DEFAULT 200;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_invite_codes_app_code_unique
ON auth_invite_codes(app_id, invite_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_invite_codes_app_user_unique
ON auth_invite_codes(app_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_invite_redemptions_app_invitee_unique
ON auth_invite_redemptions(app_id, invitee_user_id);
CREATE INDEX IF NOT EXISTS idx_auth_invite_redemptions_app_inviter_created
ON auth_invite_redemptions(app_id, inviter_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_email_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  purpose varchar(32) NOT NULL,
  code_hash varchar(128) NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  expire_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_email_verification_lookup
ON auth_email_verification_codes(app_id, email, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_email_verification_expire
ON auth_email_verification_codes(expire_at DESC);

CREATE TABLE IF NOT EXISTS ai_async_video_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  public_task_id varchar(128) NOT NULL,
  external_task_id varchar(128) NULL,
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
  model_key varchar(120) NOT NULL,
  upstream_model varchar(160) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'QUEUED',
  reservation_key varchar(128) NULL,
  usage_reference_id varchar(120) NULL,
  request_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_json jsonb NULL,
  error_message text NULL,
  request_path varchar(255) NULL,
  metadata_json jsonb NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_async_video_tasks_public
ON ai_async_video_tasks(app_id, public_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_async_video_tasks_external
ON ai_async_video_tasks(app_id, external_task_id)
WHERE external_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_async_video_tasks_queue
ON ai_async_video_tasks(source_id, upstream_model, status, queued_at, created_at);

DO $$
BEGIN
  IF to_regclass('public.vocabulary_books') IS NOT NULL THEN
    ALTER TABLE vocabulary_books
    ADD COLUMN IF NOT EXISTS cover_url varchar(2048) NULL;
  END IF;

  IF to_regclass('public.vocabulary_chapters') IS NOT NULL THEN
    ALTER TABLE vocabulary_chapters
    ADD COLUMN IF NOT EXISTS cover_url varchar(2048) NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vocabulary_lexemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  language varchar(50) NOT NULL,
  lemma varchar(255) NOT NULL,
  lemma_norm varchar(255) NOT NULL,
  part_of_speech varchar(100) NULL,
  pos_norm varchar(100) NOT NULL DEFAULT '',
  meaning varchar(1024) NOT NULL,
  sentences_json jsonb NULL,
  word_audio_url varchar(1024) NULL,
  sentence_audio_url varchar(1024) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, language, lemma_norm, pos_norm)
);

CREATE TABLE IF NOT EXISTS vocabulary_chapter_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES vocabulary_books(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES vocabulary_chapters(id) ON DELETE CASCADE,
  lexeme_id uuid NOT NULL REFERENCES vocabulary_lexemes(id) ON DELETE RESTRICT,
  level varchar(50) NULL,
  category varchar(100) NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, chapter_id, lexeme_id)
);

CREATE TABLE IF NOT EXISTS vocabulary_tts_text_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  language varchar(50) NOT NULL,
  text_type varchar(16) NOT NULL,
  text text NOT NULL,
  text_norm text NOT NULL,
  text_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, language, text_type, text_hash)
);

CREATE TABLE IF NOT EXISTS vocabulary_tts_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  text_unit_id uuid NOT NULL REFERENCES vocabulary_tts_text_units(id) ON DELETE CASCADE,
  provider varchar(64) NOT NULL DEFAULT 'system',
  model varchar(128) NOT NULL DEFAULT '',
  voice_key varchar(128) NOT NULL DEFAULT 'default',
  audio_format varchar(16) NOT NULL DEFAULT 'mp3',
  sample_rate integer NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'pending',
  is_default boolean NOT NULL DEFAULT false,
  audio_url varchar(2048) NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, text_unit_id, provider, model, voice_key, audio_format, sample_rate)
);

CREATE TABLE IF NOT EXISTS vocabulary_lexeme_sentences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  lexeme_id uuid NOT NULL REFERENCES vocabulary_lexemes(id) ON DELETE CASCADE,
  sentence_index integer NOT NULL DEFAULT 0,
  sentence_text_unit_id uuid NOT NULL REFERENCES vocabulary_tts_text_units(id) ON DELETE CASCADE,
  meaning varchar(2048) NULL,
  default_audio_asset_id uuid NULL REFERENCES vocabulary_tts_assets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, lexeme_id, sentence_text_unit_id)
);

CREATE TABLE IF NOT EXISTS vocabulary_learning_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lexeme_id uuid NOT NULL REFERENCES vocabulary_lexemes(id) ON DELETE CASCADE,
  language varchar(50) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'new',
  ease_factor numeric(4,2) NOT NULL DEFAULT 2.50,
  interval_days integer NOT NULL DEFAULT 0,
  repetition integer NOT NULL DEFAULT 0,
  streak integer NOT NULL DEFAULT 0,
  total_reviews integer NOT NULL DEFAULT 0,
  correct_reviews integer NOT NULL DEFAULT 0,
  lapse_count integer NOT NULL DEFAULT 0,
  last_score smallint NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_reviewed_at timestamptz NULL,
  next_review_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, lexeme_id)
);

CREATE TABLE IF NOT EXISTS vocabulary_learning_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES vocabulary_books(id) ON DELETE CASCADE,
  chapter_id uuid NULL REFERENCES vocabulary_chapters(id) ON DELETE SET NULL,
  lexeme_id uuid NOT NULL REFERENCES vocabulary_lexemes(id) ON DELETE CASCADE,
  score smallint NOT NULL,
  response_ms integer NULL,
  was_due boolean NOT NULL DEFAULT false,
  prev_status varchar(16) NULL,
  next_status varchar(16) NOT NULL,
  prev_interval_days integer NOT NULL DEFAULT 0,
  next_interval_days integer NOT NULL DEFAULT 0,
  prev_ease_factor numeric(4,2) NOT NULL DEFAULT 2.50,
  next_ease_factor numeric(4,2) NOT NULL DEFAULT 2.50,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  next_review_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocabulary_learning_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES vocabulary_books(id) ON DELETE CASCADE,
  daily_target integer NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, book_id)
);

ALTER TABLE vocabulary_lexemes
ADD COLUMN IF NOT EXISTS word_text_unit_id uuid NULL REFERENCES vocabulary_tts_text_units(id) ON DELETE SET NULL;
ALTER TABLE vocabulary_lexemes
ADD COLUMN IF NOT EXISTS default_word_audio_asset_id uuid NULL REFERENCES vocabulary_tts_assets(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS vocabulary_runtime_migrations (
  name varchar(128) PRIMARY KEY,
  executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_lexemes_app_lang
ON vocabulary_lexemes(app_id, language);
CREATE INDEX IF NOT EXISTS idx_vocabulary_chapter_words_app_book_chapter
ON vocabulary_chapter_words(app_id, book_id, chapter_id);
CREATE INDEX IF NOT EXISTS idx_vocabulary_tts_text_units_lookup
ON vocabulary_tts_text_units(app_id, language, text_type);
CREATE INDEX IF NOT EXISTS idx_vocabulary_tts_assets_text
ON vocabulary_tts_assets(app_id, text_unit_id, status, is_default);
CREATE INDEX IF NOT EXISTS idx_vocabulary_lexeme_sentences_lexeme
ON vocabulary_lexeme_sentences(app_id, lexeme_id, sentence_index);
CREATE INDEX IF NOT EXISTS idx_vocabulary_learning_states_due
ON vocabulary_learning_states(app_id, user_id, next_review_at);
CREATE INDEX IF NOT EXISTS idx_vocabulary_learning_reviews_user_time
ON vocabulary_learning_reviews(app_id, user_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_vocabulary_learning_goals_user_book
ON vocabulary_learning_goals(app_id, user_id, book_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vocabulary_tts_assets_one_default
ON vocabulary_tts_assets(app_id, text_unit_id)
WHERE is_default = true AND status = 'ready';

COMMIT;
