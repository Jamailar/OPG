ALTER TABLE apple_iap_transactions
  ADD COLUMN IF NOT EXISTS last_notification_type varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS last_notification_subtype varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS last_notification_signed_date timestamptz NULL,
  ADD COLUMN IF NOT EXISTS app_account_token uuid NULL,
  ADD COLUMN IF NOT EXISTS app_transaction_id varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS auto_renew_status integer NULL,
  ADD COLUMN IF NOT EXISTS expiration_intent integer NULL,
  ADD COLUMN IF NOT EXISTS is_in_billing_retry_period boolean NULL,
  ADD COLUMN IF NOT EXISTS grace_period_expires_date timestamptz NULL,
  ADD COLUMN IF NOT EXISTS renewal_date timestamptz NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason integer NULL,
  ADD COLUMN IF NOT EXISTS revocation_type varchar(64) NULL,
  ADD COLUMN IF NOT EXISTS revocation_percentage integer NULL,
  ADD COLUMN IF NOT EXISTS currency varchar(8) NULL,
  ADD COLUMN IF NOT EXISTS price_milliunits bigint NULL,
  ADD COLUMN IF NOT EXISTS renewal_price_milliunits bigint NULL;

CREATE INDEX IF NOT EXISTS idx_apple_iap_transactions_app_account_token
ON apple_iap_transactions(app_id, app_account_token)
WHERE app_account_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_apple_iap_transactions_notification_signed
ON apple_iap_transactions(app_id, original_transaction_id, last_notification_signed_date DESC);

ALTER TABLE apple_iap_notifications
  ADD COLUMN IF NOT EXISTS signed_date timestamptz NULL,
  ADD COLUMN IF NOT EXISTS processing_status varchar(32) NOT NULL DEFAULT 'PROCESSED',
  ADD COLUMN IF NOT EXISTS processing_error text NULL,
  ADD COLUMN IF NOT EXISTS processed_actions jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_apple_iap_notifications_status_created
ON apple_iap_notifications(processing_status, created_at DESC);
