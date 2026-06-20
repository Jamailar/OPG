export type AppConnectorRow = {
  id: string;
  app_id: string;
  slug: string;
  name: string;
  base_url: string;
  outbound_proxy_id: string | null;
  timeout_ms: number;
  retry_json: unknown;
  rate_limit_json: unknown;
  security_json: unknown;
  status: string;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AppConnectorCredentialRow = {
  id: string;
  app_id: string;
  connector_id: string;
  slug: string;
  auth_mode: string;
  public_config_json: unknown;
  secret_json_encrypted: string | null;
  status: string;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AppConnectorActionRow = {
  id: string;
  app_id: string;
  connector_id: string;
  credential_id: string | null;
  slug: string;
  name: string | null;
  method: string;
  path_template: string;
  input_schema_json: unknown;
  request_mapping_json: unknown;
  response_mapping_json: unknown;
  error_mapping_json: unknown;
  execution_mode: string;
  poller_json: unknown;
  cache_json: unknown;
  status: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AppConnectorRunRow = {
  id: string;
  app_id: string;
  connector_id: string;
  action_id: string;
  credential_id: string | null;
  actor_user_id: string | null;
  trigger_type: string;
  input_json: unknown;
  request_summary_json: unknown;
  response_summary_json: unknown;
  output_json: unknown;
  status: string;
  status_code: number | null;
  latency_ms: number | null;
  error_json: unknown;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
