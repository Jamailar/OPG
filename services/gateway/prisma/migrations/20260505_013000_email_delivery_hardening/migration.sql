ALTER TABLE email_campaign_recipients
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_email_campaign_recipients_retry
ON email_campaign_recipients(status, next_retry_at, created_at)
WHERE status IN ('pending', 'retry');

ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS max_recipients integer NULL,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_email_campaigns_delivery_due
ON email_campaigns(status, scheduled_at, updated_at)
WHERE status IN ('scheduled', 'sending');
