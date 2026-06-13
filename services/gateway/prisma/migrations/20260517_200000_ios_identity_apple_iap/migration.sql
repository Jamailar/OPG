ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_type varchar(32) NOT NULL DEFAULT 'REGISTERED',
  ADD COLUMN IF NOT EXISTS primary_auth_provider varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_app_account_type
ON users(app_id, account_type, deleted_at);

CREATE INDEX IF NOT EXISTS idx_users_app_apple_sub
ON users(app_id, apple_sub)
WHERE apple_sub IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS apple_login_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  bundle_id varchar(255) NOT NULL,
  service_id varchar(255) NULL,
  team_id varchar(64) NOT NULL,
  key_id varchar(64) NULL,
  issuer_id varchar(128) NULL,
  private_key text NULL,
  environment varchar(32) NOT NULL DEFAULT 'PRODUCTION',
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apple_login_credentials_name_unique
ON apple_login_credentials(LOWER(name));

CREATE INDEX IF NOT EXISTS idx_apple_login_credentials_active
ON apple_login_credentials(is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(32) NOT NULL,
  provider_subject varchar(255) NOT NULL,
  email varchar(255) NULL,
  is_verified boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_subject_unique
ON user_identities(app_id, provider, provider_subject);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_provider
ON user_identities(app_id, user_id, provider);

CREATE TABLE IF NOT EXISTS ios_auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  challenge varchar(255) NOT NULL,
  purpose varchar(64) NOT NULL,
  key_id varchar(255) NULL,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  consumed_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  ip_address varchar(128) NULL,
  user_agent text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ios_auth_challenges_challenge_unique
ON ios_auth_challenges(challenge);

CREATE INDEX IF NOT EXISTS idx_ios_auth_challenges_app_key
ON ios_auth_challenges(app_id, key_id, purpose, expires_at DESC);

CREATE TABLE IF NOT EXISTS ios_app_attest_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  key_id varchar(255) NOT NULL,
  public_key text NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  team_id varchar(64) NOT NULL,
  bundle_id varchar(255) NOT NULL,
  environment varchar(32) NOT NULL DEFAULT 'PRODUCTION',
  status varchar(32) NOT NULL DEFAULT 'ACTIVE',
  last_seen_at timestamptz NULL,
  revoked_at timestamptz NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ios_app_attest_devices_app_key_unique
ON ios_app_attest_devices(app_id, key_id);

CREATE INDEX IF NOT EXISTS idx_ios_app_attest_devices_user_status
ON ios_app_attest_devices(app_id, user_id, status);

CREATE TABLE IF NOT EXISTS apple_iap_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  transaction_id varchar(128) NOT NULL,
  original_transaction_id varchar(128) NOT NULL,
  web_order_line_item_id varchar(128) NULL,
  product_id uuid NULL,
  apple_product_id varchar(255) NOT NULL,
  environment varchar(32) NOT NULL DEFAULT 'PRODUCTION',
  status varchar(64) NOT NULL DEFAULT 'ACTIVE',
  purchase_date timestamptz NULL,
  expires_date timestamptz NULL,
  revocation_date timestamptz NULL,
  signed_transaction_info text NULL,
  signed_renewal_info text NULL,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apple_iap_transactions_transaction_unique
ON apple_iap_transactions(transaction_id);

CREATE INDEX IF NOT EXISTS idx_apple_iap_transactions_original
ON apple_iap_transactions(app_id, original_transaction_id);

CREATE INDEX IF NOT EXISTS idx_apple_iap_transactions_user_status
ON apple_iap_transactions(app_id, user_id, status, expires_date DESC);

CREATE TABLE IF NOT EXISTS apple_iap_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
  notification_uuid varchar(128) NOT NULL,
  notification_type varchar(128) NOT NULL,
  subtype varchar(128) NULL,
  transaction_id varchar(128) NULL,
  original_transaction_id varchar(128) NULL,
  environment varchar(32) NULL,
  signed_payload text NOT NULL,
  decoded_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apple_iap_notifications_uuid_unique
ON apple_iap_notifications(notification_uuid);

CREATE INDEX IF NOT EXISTS idx_apple_iap_notifications_original
ON apple_iap_notifications(app_id, original_transaction_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source varchar(32) NOT NULL,
  product_code varchar(128) NOT NULL,
  product_id uuid NULL,
  external_product_id varchar(255) NULL,
  original_transaction_id varchar(128) NULL,
  status varchar(32) NOT NULL DEFAULT 'ACTIVE',
  starts_at timestamptz NULL,
  expires_at timestamptz NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_entitlements
  ADD COLUMN IF NOT EXISTS source varchar(32) NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN IF NOT EXISTS product_code varchar(128) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS product_id uuid NULL,
  ADD COLUMN IF NOT EXISTS external_product_id varchar(255) NULL,
  ADD COLUMN IF NOT EXISTS original_transaction_id varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS status varchar(32) NOT NULL DEFAULT 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_entitlements_source_unique
ON user_entitlements(app_id, user_id, source, original_transaction_id)
WHERE original_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_entitlements_user_status
ON user_entitlements(app_id, user_id, status, expires_at DESC);

ALTER TABLE payment_products
  ADD COLUMN IF NOT EXISTS apple_product_id varchar(255) NULL;

CREATE INDEX IF NOT EXISTS idx_payment_products_app_apple_product
ON payment_products(app_id, apple_product_id)
WHERE apple_product_id IS NOT NULL;
