export type AppFunctionRow = {
  id: string;
  app_id: string;
  slug: string;
  runtime: string;
  entrypoint: string;
  source_json: unknown;
  secrets_scope: string | null;
  trigger_json: unknown;
  status: string;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AppFunctionVersionRow = {
  id: string;
  function_id: string;
  app_id: string;
  version: number;
  source_hash: string;
  source_json: unknown;
  build_status: string;
  created_at: Date;
};

export type AppFunctionRunRow = {
  id: string;
  app_id: string;
  function_id: string;
  version_id: string | null;
  trigger_type: string;
  input_json: unknown;
  status: string;
  output_json: unknown;
  error_json: unknown;
  usage_json: unknown;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
