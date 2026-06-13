CREATE TABLE IF NOT EXISTS email_cf_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  account_id varchar(120) NOT NULL,
  api_token_ciphertext text NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  notes text NULL,
  last_verified_at timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_cf_accounts_account_unique
ON email_cf_accounts(account_id);

CREATE INDEX IF NOT EXISTS idx_email_cf_accounts_status
ON email_cf_accounts(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cf_account_id uuid NOT NULL REFERENCES email_cf_accounts(id) ON DELETE CASCADE,
  app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  display_name varchar(160) NULL,
  domain varchar(255) NOT NULL,
  purpose varchar(32) NOT NULL DEFAULT 'both',
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  is_default boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_senders_email_unique
ON email_senders(LOWER(email));

CREATE INDEX IF NOT EXISTS idx_email_senders_app_purpose
ON email_senders(app_id, purpose, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_email_settings (
  app_id uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  marketing_sender_id uuid NULL REFERENCES email_senders(id) ON DELETE SET NULL,
  notification_sender_id uuid NULL REFERENCES email_senders(id) ON DELETE SET NULL,
  unsubscribe_base_url text NULL,
  brand_name varchar(160) NULL,
  footer_text text NULL,
  reply_to_email varchar(320) NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  email varchar(320) NOT NULL,
  display_name varchar(160) NULL,
  source varchar(32) NOT NULL DEFAULT 'manual',
  status varchar(24) NOT NULL DEFAULT 'subscribed',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_contacts_app_email_unique
ON email_contacts(app_id, LOWER(email));

CREATE INDEX IF NOT EXISTS idx_email_contacts_app_status
ON email_contacts(app_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_contact_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  description text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_contact_segments_app_name_unique
ON email_contact_segments(app_id, LOWER(name));

CREATE TABLE IF NOT EXISTS email_contact_segment_members (
  segment_id uuid NOT NULL REFERENCES email_contact_segments(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES email_contacts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(segment_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_email_contact_segment_members_contact
ON email_contact_segment_members(contact_id);

CREATE TABLE IF NOT EXISTS email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  subject varchar(240) NOT NULL,
  html text NOT NULL,
  text text NULL,
  variables_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_app_status
ON email_templates(app_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  sender_id uuid NULL REFERENCES email_senders(id) ON DELETE SET NULL,
  template_id uuid NULL REFERENCES email_templates(id) ON DELETE SET NULL,
  name varchar(180) NOT NULL,
  subject varchar(240) NOT NULL,
  html text NOT NULL,
  text text NULL,
  audience_type varchar(32) NOT NULL DEFAULT 'all',
  segment_id uuid NULL REFERENCES email_contact_segments(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  recipient_total integer NOT NULL DEFAULT 0,
  delivered_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_app_status
ON email_campaigns(app_id, status, scheduled_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  contact_id uuid NULL REFERENCES email_contacts(id) ON DELETE SET NULL,
  email_snapshot varchar(320) NOT NULL,
  display_name_snapshot varchar(160) NULL,
  status varchar(24) NOT NULL DEFAULT 'pending',
  provider_message_id varchar(255) NULL,
  error_code varchar(120) NULL,
  error_message text NULL,
  sent_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_campaign_recipients_unique
ON email_campaign_recipients(campaign_id, LOWER(email_snapshot));

CREATE INDEX IF NOT EXISTS idx_email_campaign_recipients_status
ON email_campaign_recipients(campaign_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_email_campaign_recipients_pending
ON email_campaign_recipients(status, created_at)
WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS email_suppression_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  reason varchar(32) NOT NULL DEFAULT 'unsubscribe',
  campaign_id uuid NULL REFERENCES email_campaigns(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_suppression_app_email_unique
ON email_suppression_list(app_id, LOWER(email));
