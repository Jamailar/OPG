CREATE TABLE IF NOT EXISTS google_oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  client_id varchar(255) NOT NULL,
  client_secret text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_clients_name_unique
ON google_oauth_clients(LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_clients_client_id_unique
ON google_oauth_clients(LOWER(client_id));

CREATE INDEX IF NOT EXISTS idx_google_oauth_clients_active
ON google_oauth_clients(is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS github_oauth_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  client_id varchar(255) NOT NULL,
  client_secret text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_oauth_apps_name_unique
ON github_oauth_apps(LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_oauth_apps_client_id_unique
ON github_oauth_apps(LOWER(client_id));

CREATE INDEX IF NOT EXISTS idx_github_oauth_apps_active
ON github_oauth_apps(is_active, updated_at DESC);

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

ALTER TABLE alipay_orders
  ADD COLUMN IF NOT EXISTS provider_type varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS payment_method_id uuid NULL,
  ADD COLUMN IF NOT EXISTS external_object_id varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS external_customer_id varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS external_subscription_id varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS checkout_url text NULL,
  ADD COLUMN IF NOT EXISTS currency varchar(8) NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS raw_status varchar(64) NULL;

UPDATE alipay_orders
SET provider_type = CASE
  WHEN UPPER(payment_type) LIKE 'WECHAT%' THEN 'WECHAT'
  WHEN provider_type IS NULL OR provider_type = '' THEN 'ALIPAY'
  ELSE provider_type
END
WHERE provider_type IS NULL OR provider_type = '';

CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_status_created
ON alipay_orders(app_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_provider_created
ON alipay_orders(app_id, provider_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alipay_orders_external_object
ON alipay_orders(provider_type, external_object_id);
