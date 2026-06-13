ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason text NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_email varchar(255) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_phone varchar(64) NULL;

CREATE INDEX IF NOT EXISTS idx_users_app_phone_deleted
ON users(app_id, phone, deleted_at);

CREATE INDEX IF NOT EXISTS idx_users_app_deleted_active_created
ON users(app_id, deleted_at, is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_user_payment_summary_sort
ON app_user_payment_summary(app_id, paid_amount_total DESC, user_id);

CREATE INDEX IF NOT EXISTS idx_app_user_ai_usage_summary_sort
ON app_user_ai_usage_summary(app_id, ai_requests_total DESC, user_id);

CREATE INDEX IF NOT EXISTS idx_user_ai_points_wallets_sort
ON user_ai_points_wallets(app_id, balance DESC, user_id);
