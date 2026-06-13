export type OutboundProxyProtocol = 'http' | 'https' | 'socks5';
export type OutboundProxyStatus = 'active' | 'unhealthy' | 'disabled' | 'checking';

export type OutboundProxySummary = {
  id: string;
  name: string;
  protocol: OutboundProxyProtocol;
  status: OutboundProxyStatus;
  latency_ms: number | null;
  detected_ip: string | null;
  region: string | null;
};

export type OutboundProxyRow = {
  id: string;
  name: string;
  protocol: OutboundProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  encrypted_password: string | null;
  region: string | null;
  status: OutboundProxyStatus;
  latency_ms: number | null;
  detected_ip: string | null;
  fail_count: number;
  last_checked_at: Date | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};
