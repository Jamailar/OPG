export type AgentStatus = 'draft' | 'published' | 'archived';
export type AgentVisibility = 'private' | 'internal' | 'public';
export type AgentOutputMode = 'text' | 'json';
export type AgentAuthPolicy = 'public' | 'user' | 'admin';
export type AgentScope = 'global' | 'app';
export type AgentToolPackKey = 'core_readonly' | 'user_readonly';
export type AgentToolSafetyLevel = 'readonly';

export type AgentRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  scope: string;
  owner_app_id: string | null;
  status: string;
  visibility: string;
  latest_version_id: string | null;
  published_version_id: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AgentVersionRow = {
  id: string;
  agent_id: string;
  version_number: number;
  system_prompt_template: string;
  developer_prompt_template: string | null;
  default_model: string | null;
  max_steps: number;
  max_tool_calls: number;
  timeout_ms: number;
  output_mode: string;
  input_schema_json: unknown;
  output_schema_json: unknown;
  tool_policy_json: unknown;
  created_by_user_id: string | null;
  created_at: Date;
};

export type AgentToolBindingRow = {
  id: string;
  agent_version_id: string;
  tool_key: string;
  is_enabled: boolean;
  config_json: unknown;
  created_at: Date;
  updated_at: Date;
};

export type AgentAppBindingRow = {
  id: string;
  app_id: string;
  agent_id: string;
  route_slug: string;
  is_enabled: boolean;
  auth_policy: string;
  points_cost: number | string;
  model_override: string | null;
  system_prompt_override: string | null;
  tool_override_json: unknown;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AgentRunRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  agent_id: string;
  agent_version_id: string;
  binding_id: string;
  status: string;
  request_id: string | null;
  request_path: string | null;
  route_slug: string | null;
  model_key: string | null;
  output_mode: string | null;
  auth_policy: string | null;
  input_text: string | null;
  input_json: unknown;
  output_text: string | null;
  output_json: unknown;
  error_json: unknown;
  error_name: string | null;
  error_message: string | null;
  observability_json: unknown;
  total_prompt_tokens: number | string;
  total_completion_tokens: number | string;
  total_tool_calls: number | string;
  points_charged: number | string;
  rmb_cost: number | string;
  duration_ms: number | string;
  started_at: Date;
  completed_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

export type AppRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

export type RequestActor = {
  userId: string | null;
  role: string | null;
  email: string | null;
  appSlug: string | null;
};

export type AgentToolDefinition = {
  key: string;
  name: string;
  description: string;
  tool_pack: AgentToolPackKey;
  safety_level: AgentToolSafetyLevel;
  input_schema: Record<string, unknown>;
  execute: (input: {
    app: AppRow;
    actor: RequestActor;
    args: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
};

export type AgentRunContext = {
  app: AppRow;
  actor: RequestActor;
  agent: AgentRow;
  version: AgentVersionRow;
  binding: AgentAppBindingRow;
};

export type AgentRuntimeEventHandler = (event: string, payload: Record<string, unknown>) => Promise<void> | void;

export const AGENT_TOOL_PACKS: Array<{
  key: AgentToolPackKey;
  name: string;
  description: string;
}> = [
  {
    key: 'core_readonly',
    name: 'Core Readonly',
    description: '通用只读工具，不涉及业务敏感数据写入。',
  },
  {
    key: 'user_readonly',
    name: 'User Readonly',
    description: '当前用户基础资料与身份信息的只读查询。',
  },
];
