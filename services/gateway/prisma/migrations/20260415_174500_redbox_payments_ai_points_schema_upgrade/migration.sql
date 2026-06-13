CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_ai_points_settings (
  app_id uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  text_chat_cost integer NOT NULL DEFAULT 100,
  voice_chat_cost integer NOT NULL DEFAULT 200,
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

CREATE INDEX IF NOT EXISTS idx_user_ai_points_wallets_app_user
ON user_ai_points_wallets(app_id, user_id);

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

CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_lookup
ON user_ai_points_ledger(app_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_reference_lookup
ON user_ai_points_ledger(app_id, reference_type, reference_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_request_id_lookup
ON user_ai_points_ledger(app_id, reference_type, ((metadata_json->>'request_id')), created_at DESC);

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

ALTER TABLE payment_products
ADD COLUMN IF NOT EXISTS points_topup integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_payment_products_app_created
ON payment_products(app_id, created_at DESC);

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

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS original_amount numeric(10, 2) NULL;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS payable_amount numeric(10, 2) NULL;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_deduct_points bigint NOT NULL DEFAULT 0;

ALTER TABLE alipay_orders
ALTER COLUMN points_deduct_points TYPE bigint
USING points_deduct_points::bigint;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_deduct_amount numeric(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_deduct_ledger_id varchar(128) NULL;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_refund_ledger_id varchar(128) NULL;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_refund_status varchar(16) NOT NULL DEFAULT 'NONE';

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_topup_points bigint NOT NULL DEFAULT 0;

ALTER TABLE alipay_orders
ALTER COLUMN points_topup_points TYPE bigint
USING points_topup_points::bigint;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_topup_ledger_id varchar(128) NULL;

ALTER TABLE alipay_orders
ADD COLUMN IF NOT EXISTS points_topup_status varchar(16) NOT NULL DEFAULT 'NONE';

CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_created
ON alipay_orders(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_user
ON alipay_orders(app_id, user_id, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_alipay_agreements_app_status
ON alipay_agreements(app_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alipay_agreements_due
ON alipay_agreements(app_id, next_deduction_at);

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

CREATE INDEX IF NOT EXISTS idx_alipay_deductions_app_created
ON alipay_deductions(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alipay_deductions_agreement_created
ON alipay_deductions(agreement_id, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_alipay_refunds_app_created
ON alipay_refunds(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alipay_refunds_order_created
ON alipay_refunds(order_id, created_at DESC);
