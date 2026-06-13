import {
  type RunningHubConcreteInputKind,
  type RunningHubInputKind,
  resolveRunningHubInputKind as resolveRunningHubInputKindRule,
  resolveRunningHubModelNameSuffix,
  resolveRunningHubSubmitActionSuffix,
} from './runninghub.rules';

export const RUNNINGHUB_PROVIDER_TYPE = 'runninghub-standard';
export const RUNNINGHUB_TASK_API_TYPE = 'runninghub-standard-task';
export const RUNNINGHUB_BASE_URL = 'https://www.runninghub.ai';
export const RUNNINGHUB_DEFAULT_QUERY_PATH = '/openapi/v2/query';
export const RUNNINGHUB_DEFAULT_UPLOAD_PATH = '/openapi/v2/media/upload/binary';
const RUNNINGHUB_DEFAULT_POLL_INTERVAL_MS = 2000;
const RUNNINGHUB_DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
export const RUNNINGHUB_VIDEO_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const RUNNINGHUB_LEGACY_BASE_URLS = [
  'https://www.runninghub.cn',
];

export type RunningHubSchemaMode = 'semantic' | 'field-map';
export type RunningHubSchema = {
  mode: RunningHubSchemaMode;
  input_kind: RunningHubInputKind;
  submit_path: string;
  submit_action: string;
  query_path: string;
  upload_path: string;
  field_map: Record<string, string>;
  defaults: Record<string, unknown>;
  limits: Record<string, unknown>;
  poll_interval_ms: number;
  poll_timeout_ms: number;
  max_input_images: number;
};

const GENERIC_NON_RUNNINGHUB_ENDPOINTS = new Set([
  '/chat/completions',
  '/v1/chat/completions',
  '/responses',
  '/v1/responses',
  '/embeddings',
  '/v1/embeddings',
  '/audio/speech',
  '/v1/audio/speech',
  '/audio/transcriptions',
  '/v1/audio/transcriptions',
  '/images/generations',
  '/v1/images/generations',
  '/videos/generations',
  '/v1/videos/generations',
  RUNNINGHUB_DEFAULT_QUERY_PATH,
  RUNNINGHUB_DEFAULT_UPLOAD_PATH,
]);

function normalizeObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeStringObject(value: unknown): Record<string, string> {
  const record = normalizeObject(value);
  const output: Record<string, string> = {};
  Object.entries(record).forEach(([key, item]) => {
    if (!key || item === undefined || item === null) {
      return;
    }
    const text = String(item).trim();
    if (!text) {
      return;
    }
    output[key] = text;
  });
  return output;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeEndpointPath(value: unknown, fallback = ''): string {
  const text = stringOrUndefined(value) || fallback;
  if (!text) {
    return '';
  }
  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeSubmitAction(value: unknown): string {
  const text = stringOrUndefined(value);
  if (!text) {
    return '';
  }
  return text.replace(/^\/+/, '').replace(/\/+$/, '');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function normalizeRunningHubInputKind(raw: unknown, submitPath: string): RunningHubInputKind {
  return resolveRunningHubInputKindRule(raw, submitPath);
}

function normalizeRunningHubMode(raw: unknown, fieldMap: Record<string, string>): RunningHubSchemaMode {
  const text = String(raw || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (text === 'field-map') {
    return 'field-map';
  }
  if (text === 'semantic') {
    return 'semantic';
  }
  if (Object.values(fieldMap).some((item) => item.includes('##'))) {
    return 'field-map';
  }
  return 'semantic';
}

function resolveRunningHubSubmitPath(rawSubmitPath: unknown, endpointPath: string): string {
  const candidate = normalizeEndpointPath(rawSubmitPath, normalizeEndpointPath(endpointPath));
  if (!candidate) {
    return '';
  }
  if (GENERIC_NON_RUNNINGHUB_ENDPOINTS.has(candidate)) {
    return '';
  }
  return candidate;
}

export function normalizeRunningHubModelName(value?: string | null): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  let normalized = trimmed
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '')
    .replace(/^openapi\/v2\//i, '')
    .replace(/\/+$/, '');
  normalized = resolveRunningHubModelNameSuffix(normalized);
  return normalized.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function resolveRunningHubModelRootPath(endpointPath?: string | null, upstreamModel?: string | null): string {
  const fromEndpoint = normalizeRunningHubModelName(endpointPath);
  const fromModel = normalizeRunningHubModelName(upstreamModel);
  if (fromEndpoint && fromEndpoint !== 'query' && fromEndpoint !== 'media/upload/binary') {
    if (fromModel) {
      if (fromEndpoint === fromModel || fromEndpoint.endsWith(`/${fromModel}`)) {
        return `/openapi/v2/${fromEndpoint}`;
      }
      if (fromModel.startsWith(`${fromEndpoint}/`)) {
        return `/openapi/v2/${fromModel}`;
      }
      if (!fromEndpoint.includes('/')) {
        return `/openapi/v2/${fromEndpoint}/${fromModel}`;
      }
    }
    return `/openapi/v2/${fromEndpoint}`;
  }
  if (fromModel) {
    return `/openapi/v2/${fromModel}`;
  }
  return '';
}

export function resolveRunningHubSubmitPathForInput(
  endpointPath: string | null | undefined,
  upstreamModel: string | null | undefined,
  inputKind: RunningHubConcreteInputKind,
  submitAction?: string | null,
): string {
  const rootPath = resolveRunningHubModelRootPath(endpointPath, upstreamModel);
  if (!rootPath) {
    return '';
  }
  const action = normalizeSubmitAction(submitAction) || resolveRunningHubSubmitActionSuffix(inputKind, rootPath);
  return `${rootPath}/${action}`;
}

export function isRunningHubProviderType(providerType?: string | null): boolean {
  return String(providerType || '').trim().toLowerCase() === RUNNINGHUB_PROVIDER_TYPE;
}

export function isRunningHubSource(providerType?: string | null, baseUrl?: string | null): boolean {
  if (isRunningHubProviderType(providerType)) {
    return true;
  }
  const normalizedBaseUrl = String(baseUrl || '').trim().toLowerCase();
  const allowedRoots = [RUNNINGHUB_BASE_URL, ...RUNNINGHUB_LEGACY_BASE_URLS];
  return allowedRoots.some((root) => normalizedBaseUrl === root || normalizedBaseUrl.startsWith(`${root}/`));
}

export function isRunningHubTaskApiType(apiType?: string | null): boolean {
  return String(apiType || '').trim().toLowerCase() === RUNNINGHUB_TASK_API_TYPE;
}

export function resolveRunningHubBaseUrl(providerType?: string | null, baseUrl?: string | null): string {
  if (isRunningHubProviderType(providerType)) {
    return RUNNINGHUB_BASE_URL;
  }
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

export function resolveRunningHubSchema(
  requestOverrides: unknown,
  endpointPath: string,
): RunningHubSchema {
  const root = normalizeObject(normalizeObject(requestOverrides).runninghub_schema);
  const fieldMap = normalizeStringObject(root.field_map);
  const submitPath = resolveRunningHubSubmitPath(root.submit_path, endpointPath);
  const submitAction = normalizeSubmitAction(root.submit_action ?? root.action);
  const queryPath = normalizeEndpointPath(root.query_path, RUNNINGHUB_DEFAULT_QUERY_PATH) || RUNNINGHUB_DEFAULT_QUERY_PATH;
  const uploadPath = normalizeEndpointPath(root.upload_path, RUNNINGHUB_DEFAULT_UPLOAD_PATH) || RUNNINGHUB_DEFAULT_UPLOAD_PATH;

  return {
    mode: normalizeRunningHubMode(root.mode, fieldMap),
    input_kind: normalizeRunningHubInputKind(root.input_kind, submitPath),
    submit_path: submitPath,
    submit_action: submitAction,
    query_path: queryPath,
    upload_path: uploadPath,
    field_map: fieldMap,
    defaults: normalizeObject(root.defaults),
    limits: normalizeObject(root.limits),
    poll_interval_ms: clampNumber(normalizeObject(root.poll).interval_ms, RUNNINGHUB_DEFAULT_POLL_INTERVAL_MS, 300, 15000),
    poll_timeout_ms: clampNumber(
      normalizeObject(root.poll).timeout_ms,
      RUNNINGHUB_DEFAULT_POLL_TIMEOUT_MS,
      2000,
      RUNNINGHUB_DEFAULT_POLL_TIMEOUT_MS,
    ),
    max_input_images: clampNumber(normalizeObject(root.limits).max_input_images, 10, 1, 10),
  };
}

export function extractRunningHubTaskId(data: Record<string, unknown>): string | null {
  const direct = stringOrUndefined(data.taskId) || stringOrUndefined(data.task_id);
  if (direct) {
    return direct;
  }
  const nested = normalizeObject(data.data);
  return stringOrUndefined(nested.taskId) || stringOrUndefined(nested.task_id) || null;
}

export function extractRunningHubTaskStatus(data: Record<string, unknown>): string {
  const direct = stringOrUndefined(data.status) || stringOrUndefined(data.taskStatus) || stringOrUndefined(data.task_status);
  if (direct) {
    return direct.toUpperCase();
  }
  const nested = normalizeObject(data.data);
  const nestedStatus =
    stringOrUndefined(nested.status) || stringOrUndefined(nested.taskStatus) || stringOrUndefined(nested.task_status);
  return nestedStatus ? nestedStatus.toUpperCase() : '';
}

export function isRunningHubTaskTerminalSuccess(status: string): boolean {
  return /SUCCEEDED|SUCCESS|DONE|COMPLETED|FINISHED/i.test(String(status || '').toUpperCase());
}

export function isRunningHubTaskTerminalFailure(status: string): boolean {
  return /FAILED|FAIL|ERROR|CANCEL|EXPIRED|REJECT/i.test(String(status || '').toUpperCase());
}

export function extractRunningHubTaskErrorMessage(data: Record<string, unknown>): string {
  const failedReason = data.failedReason ?? normalizeObject(data.data).failedReason;
  if (typeof failedReason === 'string' && failedReason.trim()) {
    return failedReason.trim();
  }
  if (failedReason && typeof failedReason === 'object') {
    try {
      const serialized = JSON.stringify(failedReason);
      if (serialized && serialized !== '{}') {
        return serialized;
      }
    } catch {
      // ignore
    }
  }
  return (
    stringOrUndefined(data.errorMessage)
    || stringOrUndefined(data.error_message)
    || stringOrUndefined(data.message)
    || stringOrUndefined(normalizeObject(data.data).errorMessage)
    || stringOrUndefined(normalizeObject(data.data).error_message)
    || stringOrUndefined(normalizeObject(data.data).message)
    || ''
  );
}

export function extractRunningHubResultUrls(data: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const pushUrl = (value: unknown) => {
    const text = stringOrUndefined(value);
    if (text && /^https?:\/\//i.test(text) && !urls.includes(text)) {
      urls.push(text);
    }
  };

  const resultArrays = [
    Array.isArray(data.results) ? data.results : [],
    Array.isArray(normalizeObject(data.data).results) ? (normalizeObject(data.data).results as unknown[]) : [],
  ];
  resultArrays.forEach((rows) => {
    rows.forEach((item) => {
      if (typeof item === 'string') {
        pushUrl(item);
        return;
      }
      const row = normalizeObject(item);
      pushUrl(row.url);
      pushUrl(row.image);
      pushUrl(row.image_url);
      pushUrl(row.download_url);
      pushUrl(row.video);
      pushUrl(row.video_url);
    });
  });

  return urls;
}

export function isRunningHubUploadSuccess(data: Record<string, unknown>): boolean {
  const code = Number(data.code);
  const downloadUrl =
    stringOrUndefined(normalizeObject(data.data).download_url)
    || stringOrUndefined(normalizeObject(data.data).url);
  return Number.isFinite(code) && code === 0 && !!downloadUrl;
}
