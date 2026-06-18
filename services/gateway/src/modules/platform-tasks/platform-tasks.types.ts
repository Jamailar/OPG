export type PlatformTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'retrying'
  | 'expired';

export type PlatformTaskLogStream = 'stdout' | 'stderr' | 'system';

export interface CreatePlatformTaskInput {
  app_id?: string | null;
  environment_key?: string | null;
  module: string;
  action: string;
  idempotency_key?: string | null;
  queue_name?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  actor_user_id?: string | null;
  request_id?: string | null;
  priority?: number | string | null;
  max_attempts?: number | string | null;
  timeout_ms?: number | string | null;
  input_summary?: Record<string, unknown> | null;
  output_summary?: Record<string, unknown> | null;
  cost_estimate?: Record<string, unknown> | null;
}

export interface ListPlatformTasksInput {
  app_id?: string;
  module?: string;
  action?: string;
  status?: string;
  queue_name?: string;
  request_id?: string;
  source_type?: string;
  source_id?: string;
  days?: string;
  page?: string;
  page_size?: string;
}

export interface TransitionPlatformTaskInput {
  worker_id?: string | null;
  progress?: number | string | null;
  output_summary?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  next_retry_at?: string | null;
}

export interface AppendPlatformTaskEventInput {
  event_type: string;
  stage?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface AppendPlatformTaskLogInput {
  stream?: PlatformTaskLogStream | null;
  message: string;
  metadata?: Record<string, unknown> | null;
}

export interface PlatformTaskQueueBackendStatus {
  backend: 'bullmq' | 'db';
  available: boolean;
  queue_name: string;
  redis_url_configured: boolean;
  last_error?: string | null;
}
