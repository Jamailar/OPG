CREATE TABLE IF NOT EXISTS outbound_proxies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  protocol varchar(16) NOT NULL,
  host text NOT NULL,
  port integer NOT NULL,
  username text NULL,
  encrypted_password text NULL,
  region varchar(128) NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  latency_ms integer NULL,
  detected_ip varchar(64) NULL,
  fail_count integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz NULL,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_proxies_protocol_check CHECK (protocol IN ('http', 'https', 'socks5')),
  CONSTRAINT outbound_proxies_status_check CHECK (status IN ('active', 'unhealthy', 'disabled', 'checking')),
  CONSTRAINT outbound_proxies_port_check CHECK (port > 0 AND port <= 65535)
);

CREATE INDEX IF NOT EXISTS idx_outbound_proxies_status_updated
  ON outbound_proxies(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_proxies_protocol_status
  ON outbound_proxies(protocol, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_proxies_endpoint_unique
  ON outbound_proxies(protocol, LOWER(host), port, COALESCE(username, ''));

CREATE TABLE IF NOT EXISTS outbound_proxy_check_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proxy_id uuid NOT NULL REFERENCES outbound_proxies(id) ON DELETE CASCADE,
  check_type varchar(32) NOT NULL DEFAULT 'basic',
  target_url text NOT NULL,
  success boolean NOT NULL DEFAULT false,
  status_code integer NULL,
  latency_ms integer NULL,
  detected_ip varchar(64) NULL,
  region varchar(128) NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_proxy_check_logs_proxy_created
  ON outbound_proxy_check_logs(proxy_id, created_at DESC);

ALTER TABLE ai_global_sources
  ADD COLUMN IF NOT EXISTS outbound_proxy_id uuid NULL REFERENCES outbound_proxies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_global_sources_outbound_proxy
  ON ai_global_sources(outbound_proxy_id);

ALTER TABLE google_oauth_clients
  ADD COLUMN IF NOT EXISTS outbound_proxy_id uuid NULL REFERENCES outbound_proxies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_google_oauth_clients_outbound_proxy
  ON google_oauth_clients(outbound_proxy_id);
