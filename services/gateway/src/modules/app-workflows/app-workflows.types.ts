export type AppWorkflowRow = {
  id: string;
  app_id: string;
  slug: string;
  name: string | null;
  trigger_json: unknown;
  steps_json: unknown;
  input_schema_json: unknown;
  output_schema_json: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export type AppWorkflowRunRow = {
  id: string;
  app_id: string;
  workflow_id: string;
  trigger_type: string;
  input_json: unknown;
  output_json: unknown;
  status: string;
  error_json: unknown;
  usage_json: unknown;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type WorkflowStepDefinition = {
  id?: string;
  type?: string;
  [key: string]: unknown;
};
