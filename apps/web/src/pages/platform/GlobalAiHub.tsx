import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AiUsageInsightsPanel from '@/pages/platform/components/AiUsageInsightsPanel';
import {
  PlatformAiUsageBreakdown,
  PlatformAiGatewayRuntime,
  PlatformAiModelBatchConnectivityTestResult,
  PlatformAiModelConnectivityTestResult,
  PlatformAiModelItem,
  PlatformAiSourceConnectivityTestResult,
  PlatformAiSourceItem,
  PlatformAiUsageLogItem,
  PlatformAiUsageSummary,
  PlatformOutboundProxyItem,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type AiHubTab = 'sources' | 'models';
type TtsTestMode = 'default' | 'sync' | 'async';
type AudioModelKind = 'speech' | 'voice_clone';
type AiUsageRangePreset = '7' | '30' | '90' | '180' | '365' | 'custom';
type AiUsageCapabilityFilter = 'ALL' | 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
type AiUsageSuccessFilter = 'ALL' | 'SUCCESS' | 'FAILED';
type AiModelStatusGroupKey = 'enabled' | 'hidden' | 'disabled' | 'deleted';
type AiModelCapabilityFilter = 'ALL' | AiModelForm['capability'] | 'voice_clone';
type ImageQualityKey = 'low' | 'medium' | 'high';
type ImageResolutionKey = '1K' | '2K' | '4K';
type VideoResolutionKey = '480P' | '720P' | '1080P' | '2K' | '4K';

const IMAGE_QUALITY_OPTIONS: Array<{ key: ImageQualityKey; label: string }> = [
  { key: 'low', label: 'low' },
  { key: 'medium', label: 'medium' },
  { key: 'high', label: 'high' },
];

const IMAGE_RESOLUTION_OPTIONS: Array<{ key: ImageResolutionKey; label: string }> = [
  { key: '1K', label: '1k' },
  { key: '2K', label: '2k' },
  { key: '4K', label: '4k' },
];

const VIDEO_RESOLUTION_OPTIONS: Array<{ key: VideoResolutionKey; label: string }> = [
  { key: '480P', label: '480p' },
  { key: '720P', label: '720p' },
  { key: '1080P', label: '1080p' },
  { key: '2K', label: '2k' },
  { key: '4K', label: '4k' },
];

type VideoResolutionRateForm = {
  cost_rmb_per_second: string;
  points_per_second: string;
  preferred_route_key: string;
};

type ImageQualityResolutionRateForm = {
  cost_rmb_per_call: string;
  points_per_call: string;
  preferred_route_key: string;
};

interface GlobalAiHubProps {
  fixedTab?: AiHubTab;
  hideTopTabSwitcher?: boolean;
  hideUsageSection?: boolean;
}

interface AiSourceForm {
  editing_id?: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_keys: AiSourceApiKeyForm[];
  credentials: AiSourceCredentialsForm;
  custom_headers_json: string;
  outbound_proxy_id: string;
  is_active: boolean;
  test_path: string;
}

interface AiSourceCredentialsForm {
  auth_mode: 'api_key' | 'service_account_json' | 'adc';
  project_id: string;
  location: string;
  service_account_json: string;
  service_account_email?: string;
  has_service_account_json?: boolean;
}

interface AiSourceApiKeyForm {
  id?: string | null;
  label: string;
  api_key: string;
  api_key_masked?: string;
  is_active: boolean;
}

interface AiModelForm {
  editing_id?: string;
  model_key: string;
  display_name: string;
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  execution_mode: 'sync' | 'async';
  pricing_mode: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_mchar';
  rmb_per_mtoken: string;
  rmb_per_call: string;
  rmb_per_minute: string;
  points_per_mtoken: string;
  points_per_call: string;
  points_per_minute: string;
  image_quality_resolution_rates: Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRateForm>>;
  video_resolution_rates: Record<VideoResolutionKey, VideoResolutionRateForm>;
  default_source_id: string;
  upstream_model: string;
  endpoint_path: string;
  api_type: string;
  minimax_audio_mode: AudioModelKind;
  target_tts_model_key: string;
  request_overrides_json: string;
  is_default: boolean;
  is_active: boolean;
  is_visible: boolean;
  source_routes: AiModelSourceRouteForm[];
}

interface AiModelSourceRouteForm {
  route_key: string;
  source_id: string;
  is_active: boolean;
  upstream_model: string;
  endpoint_path: string;
  api_type: string;
  request_overrides_json: string;
}

interface AiProviderPreset {
  provider_type: string;
  label: string;
  base_url: string;
  description: string;
}

const RUNNINGHUB_PROVIDER_TYPE = 'runninghub-standard';
const RUNNINGHUB_BASE_URL = 'https://www.runninghub.ai';
const RUNNINGHUB_SOURCE_TEST_PATH = '/openapi/v2/media/upload/binary';
const GOOGLE_GENAI_PROVIDER_TYPE = 'google-genai';
const GOOGLE_GENAI_BASE_URL = 'https://generativelanguage.googleapis.com';
const GOOGLE_GENAI_TTS_API_TYPE = 'google-genai-tts';
const GOOGLE_GENAI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const VERTEX_AI_PROVIDER_TYPE = 'google-vertex-ai';
const VERTEX_AI_BASE_URL = 'https://aiplatform.googleapis.com';
const RUNNINGHUB_TASK_API_TYPE = 'runninghub-standard-task';
const MINIMAX_TTS_API_TYPE = 'minimax-tts';
const MINIMAX_VOICE_CLONE_API_TYPE = 'minimax-voice-clone';
const DASHSCOPE_COSYVOICE_PROVIDER_TYPE = 'dashscope-cosyvoice';
const DASHSCOPE_COSYVOICE_TTS_API_TYPE = 'dashscope-cosyvoice-tts';
const DASHSCOPE_COSYVOICE_VOICE_CLONE_API_TYPE = 'dashscope-cosyvoice-voice-clone';
const DASHSCOPE_COSYVOICE_TTS_ENDPOINT = '/services/audio/tts/SpeechSynthesizer';
const DASHSCOPE_COSYVOICE_VOICE_CLONE_ENDPOINT = '/services/audio/tts/customization';
const ALIYUN_ICE_PROVIDER_TYPE = 'aliyun-ice';
const ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE = 'aliyun-ice-video-translation';
const ALIYUN_ICE_VIDEO_TRANSLATION_MODEL_KEY = 'aliyun-video-translation';
const ALIYUN_ICE_DEFAULT_ENDPOINT = 'ice.cn-shanghai.aliyuncs.com';
const DASHSCOPE_VIDEORETALK_API_TYPE = 'dashscope-videoretalk';
const DASHSCOPE_VIDEORETALK_MODEL_KEY = 'videoretalk';
const DASHSCOPE_VIDEORETALK_ENDPOINT = '/api/v1/services/aigc/image2video/video-synthesis';

const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    provider_type: 'openai-compatible',
    label: 'OpenAI Compatible',
    base_url: 'https://api.openai.com/v1',
    description: '标准 OpenAI 兼容接口',
  },
  {
    provider_type: 'dashscope-openai',
    label: 'DashScope (Alibaba 最新)',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    description: '阿里云百炼兼容接口（内置）',
  },
  {
    provider_type: DASHSCOPE_COSYVOICE_PROVIDER_TYPE,
    label: 'DashScope CosyVoice',
    base_url: 'https://dashscope.aliyuncs.com/api/v1',
    description: 'CosyVoice 语音合成和声音复刻',
  },
  {
    provider_type: ALIYUN_ICE_PROVIDER_TYPE,
    label: 'Aliyun ICE',
    base_url: ALIYUN_ICE_DEFAULT_ENDPOINT,
    description: '阿里云智能媒体服务视频翻译',
  },
  {
    provider_type: 'dashscope-openai-intl',
    label: 'DashScope Intl (Alibaba)',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    description: '阿里云百炼国际站兼容接口（内置）',
  },
  {
    provider_type: 'openrouter-openai',
    label: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    description: '聚合路由，兼容 OpenAI 风格',
  },
  {
    provider_type: 'anthropic-official',
    label: 'Anthropic Claude Official',
    base_url: 'https://api.anthropic.com',
    description: 'Anthropic 官方 Claude API，内部走官方 SDK，适合直接接官方源',
  },
  {
    provider_type: 'anthropic-compatible',
    label: 'Anthropic Compatible',
    base_url: '',
    description: '通用 Anthropic Messages 兼容网关，填写根域名即可，适合自建或三方 Claude 网关',
  },
  {
    provider_type: GOOGLE_GENAI_PROVIDER_TYPE,
    label: 'Google Gemini API (AI Studio)',
    base_url: GOOGLE_GENAI_BASE_URL,
    description: 'AI Studio API Key 调用 Gemini 原生接口',
  },
  {
    provider_type: VERTEX_AI_PROVIDER_TYPE,
    label: 'Vertex AI / Agent Platform',
    base_url: VERTEX_AI_BASE_URL,
    description: 'Google Cloud 项目、区域和 API Key 或项目凭证',
  },
  {
    provider_type: 'gemini-compatible',
    label: 'Gemini Compatible',
    base_url: '',
    description: '通用 Gemini API 兼容网关，填写根域名即可，内部仍走 Google GenAI SDK',
  },
  {
    provider_type: 'deepseek-openai',
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    description: 'DeepSeek 官方兼容接口',
  },
  {
    provider_type: 'moonshot-openai',
    label: 'Moonshot',
    base_url: 'https://api.moonshot.cn/v1',
    description: 'Moonshot 官方兼容接口',
  },
  {
    provider_type: 'siliconflow-openai',
    label: 'SiliconFlow',
    base_url: 'https://api.siliconflow.cn/v1',
    description: 'SiliconFlow 兼容接口',
  },
  {
    provider_type: 'minimax-official',
    label: 'MiniMax Official',
    base_url: 'https://api.minimaxi.com/v1',
    description: 'MiniMax 官方接口（OpenAI 兼容默认入口）',
  },
  {
    provider_type: RUNNINGHUB_PROVIDER_TYPE,
    label: 'RunningHub Standard',
    base_url: RUNNINGHUB_BASE_URL,
    description: 'RunningHub 官方标准模型接口，固定使用官方域名，可按模型路径新增图片模型',
  },
  {
    provider_type: 'custom-openai-compatible',
    label: '自定义兼容源',
    base_url: '',
    description: '任意兼容 OpenAI 的自建或三方网关',
  },
];

const PROVIDER_PRESET_MAP = new Map<string, AiProviderPreset>(
  AI_PROVIDER_PRESETS.map((item) => [item.provider_type, item]),
);

const DASHSCOPE_LATEST_MODEL_HINTS = [
  'qwen-max-latest',
  'qwen-plus-latest',
  'qwen-turbo-latest',
  'qwen3-coder-plus',
];

const AI_CAPABILITY_OPTIONS: Array<{ value: AiModelForm['capability']; label: string; default_endpoint: string }> = [
  { value: 'chat', label: '对话 Chat', default_endpoint: '/chat/completions' },
  { value: 'embedding', label: '向量 Embedding', default_endpoint: '/embeddings' },
  { value: 'tts', label: '语音合成 TTS', default_endpoint: '/audio/speech' },
  { value: 'stt', label: '语音转录 STT', default_endpoint: '/audio/transcriptions' },
  { value: 'image', label: '图片生成 Image', default_endpoint: '/images/generations' },
  { value: 'video', label: '视频生成 Video', default_endpoint: '/videos/generations' },
];

const CAPABILITY_DEFAULT_ENDPOINT = new Map<string, string>(
  AI_CAPABILITY_OPTIONS.map((item) => [item.value, item.default_endpoint]),
);

const isMinimaxProviderType = (providerType?: string | null): boolean =>
  String(providerType || '').trim().toLowerCase().includes('minimax');

const isDashscopeCosyVoiceProviderType = (providerType?: string | null): boolean => {
  const normalized = String(providerType || '').trim().toLowerCase();
  return normalized === DASHSCOPE_COSYVOICE_PROVIDER_TYPE
    || (normalized.includes('dashscope') && normalized.includes('cosyvoice'));
};

const isGoogleGenAiProviderType = (providerType?: string | null): boolean =>
  String(providerType || '').trim().toLowerCase() === GOOGLE_GENAI_PROVIDER_TYPE;

const isAudioProviderType = (providerType?: string | null): boolean =>
  isMinimaxProviderType(providerType)
  || isDashscopeCosyVoiceProviderType(providerType)
  || isGoogleGenAiProviderType(providerType)
  || isVertexAiProviderType(providerType);

const supportsVoiceCloneProviderType = (providerType?: string | null): boolean =>
  isMinimaxProviderType(providerType) || isDashscopeCosyVoiceProviderType(providerType);

const resolveAudioProviderFamily = (providerType?: string | null): 'minimax' | 'dashscope-cosyvoice' | 'google-genai' | 'google-vertex-ai' | null => {
  if (isMinimaxProviderType(providerType)) return 'minimax';
  if (isDashscopeCosyVoiceProviderType(providerType)) return 'dashscope-cosyvoice';
  if (isGoogleGenAiProviderType(providerType)) return 'google-genai';
  if (isVertexAiProviderType(providerType)) return 'google-vertex-ai';
  return null;
};

const resolveAudioSpeechApiType = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType)
    ? DASHSCOPE_COSYVOICE_TTS_API_TYPE
    : isGoogleGenAiProviderType(providerType) || isVertexAiProviderType(providerType)
      ? GOOGLE_GENAI_TTS_API_TYPE
      : MINIMAX_TTS_API_TYPE;

const resolveAudioVoiceCloneApiType = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType) ? DASHSCOPE_COSYVOICE_VOICE_CLONE_API_TYPE : MINIMAX_VOICE_CLONE_API_TYPE;

const resolveAudioSpeechEndpoint = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType) ? DASHSCOPE_COSYVOICE_TTS_ENDPOINT : '/audio/speech';

const resolveAudioVoiceCloneEndpoint = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType) ? DASHSCOPE_COSYVOICE_VOICE_CLONE_ENDPOINT : '/voice_clone';

const resolveDefaultAudioSpeechModel = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType)
    ? 'cosyvoice-v3.5-plus'
    : isGoogleGenAiProviderType(providerType) || isVertexAiProviderType(providerType)
      ? GOOGLE_GENAI_TTS_MODEL
      : '';

const resolveDefaultVoiceCloneModel = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType) ? 'voice-enrollment' : 'voice-clone';

const resolveDefaultVoiceCloneKey = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType) ? 'cosyvoice-v3.5-plus-voice-clone' : 'minimax-voice-clone';

const resolveDefaultVoiceCloneDisplayName = (providerType?: string | null): string =>
  isDashscopeCosyVoiceProviderType(providerType) ? 'CosyVoice V3.5 声音复刻' : 'MiniMax 声音复刻';

const isVoiceCloneConfig = (apiType?: string | null, endpointPath?: string | null): boolean => {
  const normalizedApiType = String(apiType || '').trim().toLowerCase().replace(/_/g, '-');
  const normalizedEndpoint = String(endpointPath || '').trim().toLowerCase();
  return normalizedApiType === MINIMAX_VOICE_CLONE_API_TYPE
    || normalizedApiType === DASHSCOPE_COSYVOICE_VOICE_CLONE_API_TYPE
    || normalizedApiType.includes('voice-clone')
    || normalizedEndpoint.endsWith('/voice_clone')
    || normalizedEndpoint.endsWith('/services/audio/tts/customization');
};

const inferAudioModelKind = (apiType?: string | null, endpointPath?: string | null): AudioModelKind =>
  isVoiceCloneConfig(apiType, endpointPath) ? 'voice_clone' : 'speech';

const isRunningHubProviderType = (providerType?: string | null): boolean =>
  String(providerType || '').trim().toLowerCase() === RUNNINGHUB_PROVIDER_TYPE;

const isAliyunIceProviderType = (providerType?: string | null): boolean =>
  String(providerType || '').trim().toLowerCase() === ALIYUN_ICE_PROVIDER_TYPE;

const isDashscopeOpenAiProviderType = (providerType?: string | null): boolean =>
  String(providerType || '').trim().toLowerCase().startsWith('dashscope-openai');

const isDashscopeVideoRetalkModel = (form: Pick<AiModelForm, 'capability' | 'model_key' | 'upstream_model' | 'api_type'>): boolean => {
  const normalizedModelKey = form.model_key.trim().toLowerCase();
  const normalizedUpstreamModel = form.upstream_model.trim().toLowerCase();
  const normalizedApiType = form.api_type.trim().toLowerCase();
  return form.capability === 'video'
    && (
      normalizedModelKey === DASHSCOPE_VIDEORETALK_MODEL_KEY
      || normalizedUpstreamModel === DASHSCOPE_VIDEORETALK_MODEL_KEY
      || normalizedApiType === DASHSCOPE_VIDEORETALK_API_TYPE
    );
};

function resolveDefaultSourceTestPath(providerType?: string | null): string {
  const normalizedProvider = String(providerType || '').trim().toLowerCase();
  if (isRunningHubProviderType(providerType)) {
    return RUNNINGHUB_SOURCE_TEST_PATH;
  }
  if (isAliyunIceProviderType(providerType)) {
    return '/';
  }
  if (isVertexAiProviderType(providerType)) {
    return '/';
  }
  if (normalizedProvider.includes('google') || normalizedProvider.includes('gemini')) {
    return '/v1beta/models';
  }
  if (normalizedProvider.includes('anthropic')) {
    return '/v1/models';
  }
  return '/models';
}

function normalizeRunningHubModelName(value?: string | null): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '')
    .replace(/^openapi\/v2\//i, '')
    .replace(/\/(?:edit|image-to-image|text-to-image|image-to-video|text-to-video|reference-to-video)$/i, '')
    .replace(/\/+$/, '');
}

function buildRunningHubEndpointRoot(modelName?: string | null): string {
  const normalized = normalizeRunningHubModelName(modelName);
  return normalized ? `/openapi/v2/${normalized}` : '';
}

function resolveRunningHubEndpointRoot(endpointPath?: string | null, upstreamModel?: string | null): string {
  return buildRunningHubEndpointRoot(endpointPath) || buildRunningHubEndpointRoot(upstreamModel);
}

function shouldClearRunningHubEndpoint(endpointPath: string, capability: AiModelForm['capability']): boolean {
  const normalized = endpointPath.trim();
  const defaultEndpoint = CAPABILITY_DEFAULT_ENDPOINT.get(capability) || '/chat/completions';
  return !normalized
    || normalized === defaultEndpoint
    || normalized === '/chat/completions'
    || normalized === '/embeddings'
    || normalized === '/audio/speech'
    || normalized === '/audio/transcriptions'
    || normalized === '/images/generations'
    || normalized === '/videos/generations';
}

function applyRunningHubModelDefaults(form: AiModelForm): AiModelForm {
  const nextCapability = form.capability === 'chat' ? 'image' : form.capability;
  return {
    ...form,
    capability: nextCapability,
    pricing_mode: resolvePricingModeByCapability(nextCapability),
    endpoint_path: resolveRunningHubEndpointRoot(
      shouldClearRunningHubEndpoint(form.endpoint_path, form.capability) ? '' : form.endpoint_path,
      form.upstream_model,
    ),
    api_type: RUNNINGHUB_TASK_API_TYPE,
  };
}

function applyAliyunIceVideoTranslationDefaults(form: AiModelForm): AiModelForm {
  return {
    ...form,
    model_key: form.model_key.trim() || ALIYUN_ICE_VIDEO_TRANSLATION_MODEL_KEY,
    display_name: form.display_name.trim() || '视频翻译',
    capability: 'video',
    execution_mode: 'async',
    pricing_mode: 'per_call',
    upstream_model: 'SubmitVideoTranslationJob',
    endpoint_path: '/SubmitVideoTranslationJob',
    api_type: ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE,
  };
}

function applyDashscopeVideoRetalkDefaults(form: AiModelForm): AiModelForm {
  return {
    ...form,
    model_key: form.model_key.trim() || DASHSCOPE_VIDEORETALK_MODEL_KEY,
    display_name: form.display_name.trim() || 'VideoRetalk',
    capability: 'video',
    execution_mode: 'async',
    pricing_mode: 'per_call',
    upstream_model: DASHSCOPE_VIDEORETALK_MODEL_KEY,
    endpoint_path: DASHSCOPE_VIDEORETALK_ENDPOINT,
    api_type: DASHSCOPE_VIDEORETALK_API_TYPE,
  };
}

function normalizeStandardModelDefaults(form: AiModelForm): AiModelForm {
  const defaultEndpoint = CAPABILITY_DEFAULT_ENDPOINT.get(form.capability) || '/chat/completions';
  const normalizedEndpoint = form.endpoint_path.trim();
  const shouldResetEndpoint = !normalizedEndpoint || normalizedEndpoint.startsWith('/openapi/v2/');
  return {
    ...form,
    endpoint_path: shouldResetEndpoint ? defaultEndpoint : form.endpoint_path,
    api_type: form.api_type.trim().toLowerCase() === RUNNINGHUB_TASK_API_TYPE
      ? 'openai-chat-completions'
      : (form.api_type.trim() || 'openai-chat-completions'),
  };
}

const EMPTY_AI_SOURCE_FORM: AiSourceForm = {
  name: '',
  provider_type: 'openai-compatible',
  base_url: 'https://api.openai.com/v1',
  api_keys: [{ label: 'Default', api_key: '', is_active: true }],
  credentials: {
    auth_mode: 'api_key',
    project_id: '',
    location: 'global',
    service_account_json: '',
  },
  custom_headers_json: '{}',
  outbound_proxy_id: '',
  is_active: true,
  test_path: '/models',
};

function createEmptyVideoResolutionRates(): Record<VideoResolutionKey, VideoResolutionRateForm> {
  return VIDEO_RESOLUTION_OPTIONS.reduce((acc, item) => {
    acc[item.key] = {
      cost_rmb_per_second: '0',
      points_per_second: '0',
      preferred_route_key: '',
    };
    return acc;
  }, {} as Record<VideoResolutionKey, VideoResolutionRateForm>);
}

function createEmptyImageQualityResolutionRates(): Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRateForm>> {
  return IMAGE_QUALITY_OPTIONS.reduce((qualityAcc, quality) => {
    qualityAcc[quality.key] = IMAGE_RESOLUTION_OPTIONS.reduce((resolutionAcc, resolution) => {
      resolutionAcc[resolution.key] = {
        cost_rmb_per_call: '0',
        points_per_call: '0',
        preferred_route_key: '',
      };
      return resolutionAcc;
    }, {} as Record<ImageResolutionKey, ImageQualityResolutionRateForm>);
    return qualityAcc;
  }, {} as Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRateForm>>);
}

const EMPTY_AI_MODEL_FORM: AiModelForm = {
  model_key: '',
  display_name: '',
  capability: 'chat',
  execution_mode: 'sync',
  pricing_mode: 'per_mtoken',
  rmb_per_mtoken: '0',
  rmb_per_call: '0',
  rmb_per_minute: '0',
  points_per_mtoken: '0',
  points_per_call: '0',
  points_per_minute: '0',
  image_quality_resolution_rates: createEmptyImageQualityResolutionRates(),
  video_resolution_rates: createEmptyVideoResolutionRates(),
  default_source_id: '',
  upstream_model: '',
  endpoint_path: '/chat/completions',
  api_type: 'openai-chat-completions',
  minimax_audio_mode: 'speech',
  target_tts_model_key: '',
  request_overrides_json: '{}',
  is_default: false,
  is_active: true,
  is_visible: true,
  source_routes: [],
};

function parseJsonObject(input: string, fieldName: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${fieldName} 必须是 JSON 对象`);
    }
    return parsed as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(error?.message || `${fieldName} 不是合法 JSON`);
  }
}

function formatDateTime(input?: string) {
  if (!input) {
    return '-';
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return '-';
  }
  return parsed.toLocaleString();
}

function buildAiSourceApiKeyForms(item: PlatformAiSourceItem): AiSourceApiKeyForm[] {
  if (item.api_keys?.length) {
    return item.api_keys.map((key) => ({
      id: key.id,
      label: key.label || 'Default',
      api_key: '',
      api_key_masked: key.api_key_masked,
      is_active: key.is_active,
    }));
  }
  return [{
    label: 'Default',
    api_key: '',
    api_key_masked: item.api_key_masked,
    is_active: true,
  }];
}

function isVertexAiProviderType(providerType?: string | null) {
  return String(providerType || '').trim().toLowerCase().includes('vertex');
}

function buildAiSourceCredentialsForm(item?: PlatformAiSourceItem): AiSourceCredentialsForm {
  const credentials = item?.credentials || {};
  const authMode = credentials.auth_mode === 'service_account_json' || credentials.auth_mode === 'adc'
    ? credentials.auth_mode
    : 'api_key';
  return {
    auth_mode: authMode,
    project_id: String(credentials.project_id || ''),
    location: String(credentials.location || 'global'),
    service_account_json: '',
    service_account_email: String(credentials.service_account_email || ''),
    has_service_account_json: credentials.has_service_account_json === true,
  };
}

function buildAiSourceCredentialsPayload(form: AiSourceForm) {
  if (!isVertexAiProviderType(form.provider_type)) {
    return undefined;
  }
  return {
    auth_mode: form.credentials.auth_mode,
    project_id: form.credentials.project_id.trim(),
    location: form.credentials.location.trim() || 'global',
    service_account_json: form.credentials.auth_mode === 'service_account_json'
      ? form.credentials.service_account_json.trim() || undefined
      : undefined,
  };
}

function formatPricePerMToken(value: number | undefined) {
  return `¥${Number(value || 0).toFixed(4)} / 1M 输出 token`;
}

function formatPricePerMChar(value: number | undefined) {
  return `¥${Number(value || 0).toFixed(4)} / 1M 字符`;
}

function formatPricePerCall(value: number | undefined, callUnit = '张') {
  return `¥${Number(value || 0).toFixed(4)} / ${callUnit}`;
}

function formatPricePerMinute(value: number | undefined) {
  return `¥${Number(value || 0).toFixed(4)} / 分钟`;
}

function formatPricePerSecond(value: number | undefined) {
  return `¥${Number(value || 0).toFixed(4)} / 秒`;
}

function formatPointsPerMToken(value: number | undefined, isEmbedding = false) {
  return `${Number(value || 0).toFixed(4)} 积分 / 1M ${isEmbedding ? 'token' : '输出 token'}`;
}

function formatPointsPer100Chars(value: number | undefined) {
  return `${Number(value || 0).toFixed(4)} 积分 / 100 字符`;
}

function formatPointsPerCall(value: number | undefined, callUnit = '张') {
  return `${Number(value || 0).toFixed(4)} 积分 / ${callUnit}`;
}

function formatPointsPerMinute(value: number | undefined) {
  return `${Number(value || 0).toFixed(4)} 积分 / 分钟`;
}

function formatPointsPerSecond(value: number | undefined) {
  return `${Number(value || 0).toFixed(4)} 积分 / 秒`;
}

function resolvePricingModeByCapability(capability: AiModelForm['capability']): AiModelForm['pricing_mode'] {
  if (capability === 'image') {
    return 'per_call';
  }
  if (capability === 'video') {
    return 'per_call';
  }
  if (capability === 'tts' || capability === 'stt') {
    return 'per_minute';
  }
  return 'per_mtoken';
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function resolveCustomIsoRange(from: string, to: string) {
  const fromValue = from ? new Date(`${from}T00:00:00`) : null;
  const toValue = to ? new Date(`${to}T23:59:59`) : null;
  return {
    from: fromValue ? fromValue.toISOString() : undefined,
    to: toValue ? toValue.toISOString() : undefined,
  };
}

type VideoResolutionRate = {
  cost_rmb_per_second?: number;
  sell_rmb_per_second?: number;
  rmb_per_second?: number;
  points_per_second?: number;
  preferred_route_key?: string;
};

type ImageQualityResolutionRate = {
  cost_rmb_per_call?: number;
  sell_rmb_per_call?: number;
  rmb_per_call?: number;
  points_per_call?: number;
  preferred_route_key?: string;
};

function parseImageQualityResolutionRates(
  requestOverrides?: Record<string, unknown> | null,
): Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRate>> {
  const empty = IMAGE_QUALITY_OPTIONS.reduce((qualityAcc, quality) => {
    qualityAcc[quality.key] = IMAGE_RESOLUTION_OPTIONS.reduce((resolutionAcc, resolution) => {
      resolutionAcc[resolution.key] = {};
      return resolutionAcc;
    }, {} as Record<ImageResolutionKey, ImageQualityResolutionRate>);
    return qualityAcc;
  }, {} as Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRate>>);
  if (!requestOverrides || typeof requestOverrides !== 'object') {
    return empty;
  }
  const pricing =
    requestOverrides.pricing && typeof requestOverrides.pricing === 'object' && !Array.isArray(requestOverrides.pricing)
      ? requestOverrides.pricing as Record<string, unknown>
      : null;
  const rawRates = pricing?.image_quality_resolution_rates ?? pricing?.image_resolution_rates ?? requestOverrides.image_quality_resolution_rates ?? requestOverrides.image_resolution_rates;
  if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
    return empty;
  }
  const ratesObject = rawRates as Record<string, unknown>;
  const parseRate = (value: unknown): ImageQualityResolutionRate => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const record = value as Record<string, unknown>;
    const costRmbValue = Number(
      record.cost_rmb_per_call
      ?? record.costRmbPerCall
      ?? record.rmb_per_call
      ?? record.rmbPerCall
      ?? record.cost_per_call
      ?? record.costPerCall
      ?? 0,
    );
    const sellRmbValue = Number(
      record.sell_rmb_per_call
      ?? record.sellRmbPerCall
      ?? record.price_rmb_per_call
      ?? record.priceRmbPerCall
      ?? record.sale_rmb_per_call
      ?? record.saleRmbPerCall
      ?? 0,
    );
    const pointsValue = Number(
      record.points_per_call
      ?? record.pointsPerCall
      ?? record.sell_points_per_call
      ?? record.sellPointsPerCall
      ?? 0,
    );
    return {
      cost_rmb_per_call: Number.isFinite(costRmbValue) ? costRmbValue : 0,
      sell_rmb_per_call: Number.isFinite(sellRmbValue) ? sellRmbValue : 0,
      rmb_per_call: Number.isFinite(costRmbValue) ? costRmbValue : 0,
      points_per_call: Number.isFinite(pointsValue) ? pointsValue : 0,
      preferred_route_key: String(record.preferred_route_key ?? record.preferredRouteKey ?? '').trim(),
    };
  };
  return IMAGE_QUALITY_OPTIONS.reduce((qualityAcc, quality) => {
    const qualityRoot = ratesObject[quality.key] && typeof ratesObject[quality.key] === 'object' && !Array.isArray(ratesObject[quality.key])
      ? ratesObject[quality.key] as Record<string, unknown>
      : {};
    qualityAcc[quality.key] = IMAGE_RESOLUTION_OPTIONS.reduce((resolutionAcc, resolution) => {
      resolutionAcc[resolution.key] = parseRate(
        qualityRoot[resolution.key]
        ?? qualityRoot[resolution.key.toLowerCase()]
        ?? qualityRoot[resolution.key.replace('K', 'k')]
        ?? ratesObject[`${quality.key}_${resolution.key}`]
        ?? ratesObject[`${quality.key}_${resolution.key}`.toLowerCase()],
      );
      return resolutionAcc;
    }, {} as Record<ImageResolutionKey, ImageQualityResolutionRate>);
    return qualityAcc;
  }, {} as Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRate>>);
}

function assignImageQualityResolutionRates(
  requestOverrides: Record<string, unknown>,
  rates: Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRate>>,
) {
  const normalizedRates: Record<string, Record<string, { cost_rmb_per_call: number; points_per_call: number; preferred_route_key?: string }>> = {};
  IMAGE_QUALITY_OPTIONS.forEach((quality) => {
    IMAGE_RESOLUTION_OPTIONS.forEach((resolution) => {
      const rate = rates[quality.key]?.[resolution.key] || {};
      const costRmb = Number(rate.cost_rmb_per_call ?? rate.rmb_per_call ?? 0);
      const points = Number(rate.points_per_call ?? 0);
      const preferredRouteKey = String(rate.preferred_route_key || '').trim();
      if (costRmb > 0 || points > 0 || preferredRouteKey) {
        normalizedRates[quality.key] = normalizedRates[quality.key] || {};
        normalizedRates[quality.key][resolution.key] = {
          cost_rmb_per_call: costRmb,
          points_per_call: points,
          ...(preferredRouteKey ? { preferred_route_key: preferredRouteKey } : {}),
        };
      }
    });
  });

  const pricingRaw = requestOverrides.pricing;
  const pricing =
    pricingRaw && typeof pricingRaw === 'object' && !Array.isArray(pricingRaw)
      ? { ...(pricingRaw as Record<string, unknown>) }
      : {};

  if (Object.keys(normalizedRates).length > 0) {
    pricing.image_quality_resolution_rates = normalizedRates;
    requestOverrides.pricing = pricing;
  } else {
    delete pricing.image_quality_resolution_rates;
    if (Object.keys(pricing).length > 0) {
      requestOverrides.pricing = pricing;
    } else {
      delete requestOverrides.pricing;
    }
  }

  delete requestOverrides.image_quality_resolution_rates;
  delete requestOverrides.image_resolution_rates;
}

function parseVideoResolutionRates(
  requestOverrides?: Record<string, unknown> | null,
): Record<VideoResolutionKey, VideoResolutionRate> {
  const empty = VIDEO_RESOLUTION_OPTIONS.reduce((acc, item) => {
    acc[item.key] = {};
    return acc;
  }, {} as Record<VideoResolutionKey, VideoResolutionRate>);
  if (!requestOverrides || typeof requestOverrides !== 'object') {
    return empty;
  }
  const pricing =
    requestOverrides.pricing && typeof requestOverrides.pricing === 'object' && !Array.isArray(requestOverrides.pricing)
      ? requestOverrides.pricing as Record<string, unknown>
      : null;
  const rawRates = pricing?.video_resolution_rates ?? requestOverrides.video_resolution_rates;
  if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
    return empty;
  }
  const ratesObject = rawRates as Record<string, unknown>;
  const parseRate = (value: unknown): VideoResolutionRate => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const record = value as Record<string, unknown>;
    const costRmbValue = Number(
      record.cost_rmb_per_second
      ?? record.costRmbPerSecond
      ?? record.rmb_per_second
      ?? record.rmbPerSecond
      ?? record.cost_per_second
      ?? record.costPerSecond
      ?? 0,
    );
    const sellRmbValue = Number(
      record.sell_rmb_per_second
      ?? record.sellRmbPerSecond
      ?? record.price_rmb_per_second
      ?? record.priceRmbPerSecond
      ?? record.sale_rmb_per_second
      ?? record.saleRmbPerSecond
      ?? 0,
    );
    const pointsValue = Number(
      record.points_per_second
      ?? record.pointsPerSecond
      ?? record.sell_points_per_second
      ?? record.sellPointsPerSecond
      ?? 0,
    );
    return {
      cost_rmb_per_second: Number.isFinite(costRmbValue) ? costRmbValue : 0,
      sell_rmb_per_second: Number.isFinite(sellRmbValue) ? sellRmbValue : 0,
      rmb_per_second: Number.isFinite(costRmbValue) ? costRmbValue : 0,
      points_per_second: Number.isFinite(pointsValue) ? pointsValue : 0,
      preferred_route_key: String(record.preferred_route_key ?? record.preferredRouteKey ?? '').trim(),
    };
  };
  return VIDEO_RESOLUTION_OPTIONS.reduce((acc, item) => {
    acc[item.key] = parseRate(
      ratesObject[item.key]
      ?? ratesObject[item.key.toLowerCase()]
      ?? ratesObject[item.key.replace('P', 'p')]
      ?? ratesObject[item.key.replace('K', 'k')]
      ?? ratesObject[item.key.replace(/[PK]$/, '')],
    );
    return acc;
  }, {} as Record<VideoResolutionKey, VideoResolutionRate>);
}

function assignVideoResolutionRates(
  requestOverrides: Record<string, unknown>,
  rates: Record<VideoResolutionKey, VideoResolutionRate>,
) {
  const normalizedRates: Record<string, { cost_rmb_per_second: number; points_per_second: number; preferred_route_key?: string }> = {};
  VIDEO_RESOLUTION_OPTIONS.forEach(({ key: resolution }) => {
    const costRmb = Number(rates[resolution]?.cost_rmb_per_second ?? rates[resolution]?.rmb_per_second ?? 0);
    const points = Number(rates[resolution]?.points_per_second || 0);
    const preferredRouteKey = String(rates[resolution]?.preferred_route_key || '').trim();
    if (costRmb > 0 || points > 0 || preferredRouteKey) {
      normalizedRates[resolution] = {
        cost_rmb_per_second: costRmb,
        points_per_second: points,
        ...(preferredRouteKey ? { preferred_route_key: preferredRouteKey } : {}),
      };
    }
  });

  const pricingRaw = requestOverrides.pricing;
  const pricing =
    pricingRaw && typeof pricingRaw === 'object' && !Array.isArray(pricingRaw)
      ? { ...(pricingRaw as Record<string, unknown>) }
      : {};

  if (Object.keys(normalizedRates).length > 0) {
    pricing.video_resolution_rates = normalizedRates;
    requestOverrides.pricing = pricing;
  } else {
    delete pricing.video_resolution_rates;
    if (Object.keys(pricing).length > 0) {
      requestOverrides.pricing = pricing;
    } else {
      delete requestOverrides.pricing;
    }
  }

  delete requestOverrides.video_resolution_rates;
}

function buildModelSourceRoutesFromItem(item: PlatformAiModelItem): AiModelSourceRouteForm[] {
  const routes = Array.isArray(item.source_routes) && item.source_routes.length > 0
    ? item.source_routes
    : [{
        id: null,
        route_key: item.default_source_id,
        source_id: item.default_source_id,
        is_active: item.default_source_is_active,
        sort_order: 0,
        upstream_model: item.upstream_model,
        endpoint_path: item.endpoint_path,
        api_type: item.api_type,
        request_overrides: {},
      }];
  return routes
    .filter((route) => !!route.source_id)
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0))
    .map((route) => ({
      route_key: String(route.route_key || route.id || createModelSourceRouteKey(route.source_id)),
      source_id: route.source_id,
      is_active: route.is_active !== false,
      upstream_model: String(route.upstream_model || ''),
      endpoint_path: String(route.endpoint_path || ''),
      api_type: String(route.api_type || ''),
      request_overrides_json: JSON.stringify(route.request_overrides || {}, null, 2),
    }));
}

function buildDefaultModelSourceRoute(sourceId: string): AiModelSourceRouteForm {
  return {
    route_key: createModelSourceRouteKey(sourceId),
    source_id: sourceId,
    is_active: true,
    upstream_model: '',
    endpoint_path: '',
    api_type: '',
    request_overrides_json: '{}',
  };
}

function createModelSourceRouteKey(sourceId: string): string {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `route-${sourceId}-${randomPart}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function clearPreferredRouteKeyFromImageRates(
  rates: Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRateForm>>,
  routeKey: string,
) {
  if (!routeKey) return rates;
  return IMAGE_QUALITY_OPTIONS.reduce((qualityAcc, quality) => {
    qualityAcc[quality.key] = IMAGE_RESOLUTION_OPTIONS.reduce((resolutionAcc, resolution) => {
      const rate = rates[quality.key]?.[resolution.key] || {
        cost_rmb_per_call: '0',
        points_per_call: '0',
        preferred_route_key: '',
      };
      resolutionAcc[resolution.key] = {
        ...rate,
        preferred_route_key: rate.preferred_route_key === routeKey ? '' : rate.preferred_route_key,
      };
      return resolutionAcc;
    }, {} as Record<ImageResolutionKey, ImageQualityResolutionRateForm>);
    return qualityAcc;
  }, {} as Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRateForm>>);
}

function clearPreferredRouteKeyFromVideoRates(
  rates: Record<VideoResolutionKey, VideoResolutionRateForm>,
  routeKey: string,
) {
  if (!routeKey) return rates;
  return VIDEO_RESOLUTION_OPTIONS.reduce((acc, option) => {
    const rate = rates[option.key] || {
      cost_rmb_per_second: '0',
      points_per_second: '0',
      preferred_route_key: '',
    };
    acc[option.key] = {
      ...rate,
      preferred_route_key: rate.preferred_route_key === routeKey ? '' : rate.preferred_route_key,
    };
    return acc;
  }, {} as Record<VideoResolutionKey, VideoResolutionRateForm>);
}

export default function GlobalAiHub({ fixedTab, hideTopTabSwitcher = false, hideUsageSection = false }: GlobalAiHubProps) {
  const navigate = useNavigate();
  const [, setLoading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [activeTab, setActiveTab] = useState<AiHubTab>(fixedTab || 'sources');

  const [aiSources, setAiSources] = useState<PlatformAiSourceItem[]>([]);
  const [aiModels, setAiModels] = useState<PlatformAiModelItem[]>([]);
  const [deletedAiModels, setDeletedAiModels] = useState<PlatformAiModelItem[]>([]);
  const [outboundProxies, setOutboundProxies] = useState<PlatformOutboundProxyItem[]>([]);
  const [usageRangePreset, setUsageRangePreset] = useState<AiUsageRangePreset>('30');
  const [usageCustomFrom, setUsageCustomFrom] = useState(() => formatDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [usageCustomTo, setUsageCustomTo] = useState(() => formatDateInput(new Date()));
  const [usageCapabilityFilter, setUsageCapabilityFilter] = useState<AiUsageCapabilityFilter>('ALL');
  const [usageModelIdFilter, setUsageModelIdFilter] = useState('');
  const [usageSourceIdFilter, setUsageSourceIdFilter] = useState('');
  const [usageSuccessFilter, setUsageSuccessFilter] = useState<AiUsageSuccessFilter>('ALL');
  const [usageSummary, setUsageSummary] = useState<PlatformAiUsageSummary | null>(null);
  const [usageBreakdown, setUsageBreakdown] = useState<PlatformAiUsageBreakdown | null>(null);
  const [usageLogs, setUsageLogs] = useState<PlatformAiUsageLogItem[]>([]);
  const [gatewayRuntime, setGatewayRuntime] = useState<PlatformAiGatewayRuntime | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageBreakdownLoading, setUsageBreakdownLoading] = useState(false);

  const [aiSourceForm, setAiSourceForm] = useState<AiSourceForm>(EMPTY_AI_SOURCE_FORM);
  const [aiModelForm, setAiModelForm] = useState<AiModelForm>(EMPTY_AI_MODEL_FORM);

  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [modelModalOpen, setModelModalOpen] = useState(false);

  const [sourceQuery, setSourceQuery] = useState('');
  const [sourceProviderFilter, setSourceProviderFilter] = useState<string>('ALL');
  const [modelQuery, setModelQuery] = useState('');
  const [modelStatusFilter, setModelStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [modelCapabilityFilter, setModelCapabilityFilter] = useState<AiModelCapabilityFilter>('ALL');
  const [collapsedModelGroups, setCollapsedModelGroups] = useState<Record<AiModelStatusGroupKey, boolean>>({
    enabled: false,
    hidden: false,
    disabled: false,
    deleted: false,
  });

  const [showAdvancedHeaders, setShowAdvancedHeaders] = useState(false);

  const [aiSourceSaving, setAiSourceSaving] = useState(false);
  const [aiModelSaving, setAiModelSaving] = useState(false);
  const [aiSourceTesting, setAiSourceTesting] = useState(false);
  const [aiSourceTestResult, setAiSourceTestResult] = useState<PlatformAiSourceConnectivityTestResult | null>(null);
  const [aiModelTesting, setAiModelTesting] = useState(false);
  const [aiModelTestMode, setAiModelTestMode] = useState<TtsTestMode>('default');
  const [aiModelTestSourceId, setAiModelTestSourceId] = useState('');
  const [aiModelTestPrompt, setAiModelTestPrompt] = useState('ping');
  const [aiModelTestVoiceId, setAiModelTestVoiceId] = useState('male-qn-qingse');
  const [aiModelTestLanguageBoost, setAiModelTestLanguageBoost] = useState('English');
  const [aiModelTestResult, setAiModelTestResult] = useState<PlatformAiModelConnectivityTestResult | null>(null);
  const [aiImageModelBatchTesting, setAiImageModelBatchTesting] = useState(false);
  const [aiImageModelBatchResult, setAiImageModelBatchResult] =
    useState<PlatformAiModelBatchConnectivityTestResult | null>(null);

  const aiSourceMap = useMemo(
    () => new Map(aiSources.map((item) => [item.id, item])),
    [aiSources],
  );

  const selectedSourcePreset = useMemo(
    () => PROVIDER_PRESET_MAP.get(aiSourceForm.provider_type) || null,
    [aiSourceForm.provider_type],
  );

  const isSourceFormRunningHub = useMemo(
    () => isRunningHubProviderType(aiSourceForm.provider_type),
    [aiSourceForm.provider_type],
  );

  const isSourceFormVertexAi = useMemo(
    () => isVertexAiProviderType(aiSourceForm.provider_type),
    [aiSourceForm.provider_type],
  );

  const selectedModelSource = useMemo(
    () => {
      const firstActiveRoute = aiModelForm.source_routes.find((item) => item.is_active && item.source_id);
      return aiSources.find((item) => item.id === (firstActiveRoute?.source_id || aiModelForm.default_source_id)) || null;
    },
    [aiSources, aiModelForm.default_source_id, aiModelForm.source_routes],
  );

  const selectedModelProviderPreset = useMemo(
    () => (selectedModelSource ? PROVIDER_PRESET_MAP.get(selectedModelSource.provider_type) || null : null),
    [selectedModelSource],
  );

  const activeModelSourceRouteOptions = useMemo(
    () => aiModelForm.source_routes
      .filter((route) => route.source_id && route.is_active)
      .map((route, index) => {
        const source = aiSourceMap.get(route.source_id);
        const upstream = route.upstream_model.trim() || aiModelForm.upstream_model.trim() || aiModelForm.model_key.trim();
        return {
          route_key: route.route_key,
          label: `${source?.name || '未选择供应商'}${upstream ? ` / ${upstream}` : ''} #${index + 1}`,
        };
      }),
    [aiModelForm.model_key, aiModelForm.source_routes, aiModelForm.upstream_model, aiSourceMap],
  );

  const selectedModelTestSource = useMemo(
    () => aiSourceMap.get(aiModelTestSourceId || aiModelForm.default_source_id) || null,
    [aiSourceMap, aiModelForm.default_source_id, aiModelTestSourceId],
  );

  const isModelFormRunningHub = useMemo(
    () => isRunningHubProviderType(selectedModelSource?.provider_type),
    [selectedModelSource?.provider_type],
  );

  const isModelFormMinimaxTts = useMemo(
    () => aiModelForm.capability === 'tts' && isAudioProviderType(selectedModelSource?.provider_type),
    [aiModelForm.capability, selectedModelSource?.provider_type],
  );

  const isModelFormVoiceCloneCapable = useMemo(
    () => isModelFormMinimaxTts && supportsVoiceCloneProviderType(selectedModelSource?.provider_type),
    [isModelFormMinimaxTts, selectedModelSource?.provider_type],
  );

  const isModelFormMinimaxVoiceClone = useMemo(
    () => isModelFormVoiceCloneCapable && aiModelForm.minimax_audio_mode === 'voice_clone',
    [aiModelForm.minimax_audio_mode, isModelFormVoiceCloneCapable],
  );

  const targetTtsModelOptions = useMemo(() => {
    if (!selectedModelSource) return [];
    return aiModels.filter((item) => {
      if (item.capability !== 'tts' || isVoiceCloneConfig(item.api_type, item.endpoint_path)) {
        return false;
      }
      if (item.default_source_id === selectedModelSource.id) {
        return true;
      }
      return (item.source_routes || []).some((route) => route.source_id === selectedModelSource.id && route.is_active !== false);
    });
  }, [aiModels, selectedModelSource]);

  const isModelTestSourceMinimaxTts = useMemo(
    () => aiModelForm.capability === 'tts'
      && aiModelForm.minimax_audio_mode !== 'voice_clone'
      && isMinimaxProviderType(selectedModelTestSource?.provider_type),
    [aiModelForm.capability, aiModelForm.minimax_audio_mode, selectedModelTestSource?.provider_type],
  );

  const formatModelPrice = (item: {
    capability?: PlatformAiModelItem['capability'] | PlatformAiUsageLogItem['capability'];
    pricing_mode?: PlatformAiModelItem['pricing_mode'] | PlatformAiUsageLogItem['unit_price_mode'];
    unit_price_mode?: PlatformAiUsageLogItem['unit_price_mode'];
    rmb_per_mtoken?: number;
    rmb_per_call?: number;
    rmb_per_minute?: number;
    points_per_mtoken?: number;
    points_per_call?: number;
    points_per_minute?: number;
    unit_price_rmb_per_mtoken?: number;
    unit_price_rmb_per_call?: number;
    unit_price_rmb_per_minute?: number;
    unit_price_points_per_mtoken?: number;
    unit_price_points_per_call?: number;
    unit_price_points_per_minute?: number;
    request_overrides?: Record<string, unknown>;
  }) => {
    const capability = item.capability || 'chat';
    if (capability === 'image') {
      const imageRates = parseImageQualityResolutionRates(item.request_overrides);
      const parts = IMAGE_QUALITY_OPTIONS.flatMap((quality) =>
        IMAGE_RESOLUTION_OPTIONS
          .filter((resolution) => Number(imageRates[quality.key]?.[resolution.key]?.cost_rmb_per_call ?? imageRates[quality.key]?.[resolution.key]?.rmb_per_call ?? 0) > 0)
          .map((resolution) => `${quality.label}/${resolution.label} ${formatPricePerCall(imageRates[quality.key]?.[resolution.key]?.cost_rmb_per_call ?? imageRates[quality.key]?.[resolution.key]?.rmb_per_call, '次')}`),
      );
      if (parts.length > 0) {
        return parts.join(' · ');
      }
    }
    if (capability === 'video') {
      const videoRates = parseVideoResolutionRates(item.request_overrides);
      const parts = VIDEO_RESOLUTION_OPTIONS
        .filter(({ key }) => Number(videoRates[key]?.cost_rmb_per_second ?? videoRates[key]?.rmb_per_second ?? 0) > 0)
        .map(({ key, label }) => `${label} ${formatPricePerSecond(videoRates[key]?.cost_rmb_per_second ?? videoRates[key]?.rmb_per_second)}`);
      if (parts.length > 0) {
        return parts.join(' · ');
      }
    }
    const callUnit = capability === 'video' || capability === 'tts' ? '次' : '张';
    const isEmbedding = capability === 'embedding';
    const pricingMode = item.pricing_mode || item.unit_price_mode || 'per_mtoken';
    if (pricingMode === 'per_mchar') {
      return formatPricePerMChar(item.rmb_per_mtoken ?? item.unit_price_rmb_per_mtoken);
    }
    if (pricingMode === 'per_minute') {
      return formatPricePerMinute(item.rmb_per_minute ?? item.unit_price_rmb_per_minute);
    }
    if (pricingMode === 'per_call') {
      return formatPricePerCall(item.rmb_per_call ?? item.unit_price_rmb_per_call, callUnit);
    }
    return isEmbedding
      ? `¥${Number((item.rmb_per_mtoken ?? item.unit_price_rmb_per_mtoken) || 0).toFixed(4)} / 1M token`
      : formatPricePerMToken(item.rmb_per_mtoken ?? item.unit_price_rmb_per_mtoken);
  };

  const formatModelSellPrice = (item: {
    capability?: PlatformAiModelItem['capability'] | PlatformAiUsageLogItem['capability'];
    pricing_mode?: PlatformAiModelItem['pricing_mode'] | PlatformAiUsageLogItem['unit_price_mode'];
    unit_price_mode?: PlatformAiUsageLogItem['unit_price_mode'];
    points_per_mtoken?: number;
    points_per_call?: number;
    points_per_minute?: number;
    request_overrides?: Record<string, unknown>;
  }) => {
    const capability = item.capability || 'chat';
    if (capability === 'image') {
      const imageRates = parseImageQualityResolutionRates(item.request_overrides);
      const parts = IMAGE_QUALITY_OPTIONS.flatMap((quality) =>
        IMAGE_RESOLUTION_OPTIONS
          .filter((resolution) => Number(imageRates[quality.key]?.[resolution.key]?.points_per_call || 0) > 0)
          .map((resolution) => `${quality.label}/${resolution.label} ${formatPointsPerCall(imageRates[quality.key]?.[resolution.key]?.points_per_call, '张')}`),
      );
      if (parts.length > 0) {
        return parts.join(' · ');
      }
    }
    if (capability === 'video') {
      const videoRates = parseVideoResolutionRates(item.request_overrides);
      const parts = VIDEO_RESOLUTION_OPTIONS
        .filter(({ key }) => Number(videoRates[key]?.points_per_second || 0) > 0)
        .map(({ key, label }) => `${label} ${formatPointsPerSecond(videoRates[key]?.points_per_second)}`);
      if (parts.length > 0) {
        return parts.join(' · ');
      }
    }
    const callUnit = capability === 'video' || capability === 'tts' ? '次' : '张';
    const isEmbedding = capability === 'embedding';
    const pricingMode = item.pricing_mode || item.unit_price_mode || 'per_mtoken';
    if (pricingMode === 'per_mchar') {
      return formatPointsPer100Chars(item.points_per_call);
    }
    if (pricingMode === 'per_minute') {
      return formatPointsPerMinute(item.points_per_minute);
    }
    if (pricingMode === 'per_call') {
      return formatPointsPerCall(item.points_per_call, callUnit);
    }
    return formatPointsPerMToken(item.points_per_mtoken, isEmbedding);
  };

  const sourceStats = useMemo(() => {
    const total = aiSources.length;
    const active = aiSources.filter((item) => item.is_active).length;
    const inactive = total - active;
    return { total, active, inactive };
  }, [aiSources]);

  const modelStats = useMemo(() => {
    const total = aiModels.length;
    const active = aiModels.filter((item) => item.is_active).length;
    const defaultModel = aiModels.find((item) => item.is_default);
    return { total, active, defaultModel: defaultModel?.model_key || '-' };
  }, [aiModels]);

  const usageModelOptions = useMemo(
    () => aiModels.map((item) => ({ value: item.id, label: `${item.display_name || item.model_key} / ${item.model_key}` })),
    [aiModels],
  );

  const usageSourceOptions = useMemo(
    () => aiSources.map((item) => ({ id: item.id, name: item.name, provider_type: item.provider_type })),
    [aiSources],
  );
  const shouldLoadUsage = activeTab === 'models' && !hideUsageSection;

  const filteredSources = useMemo(() => {
    const query = sourceQuery.trim().toLowerCase();
    return aiSources.filter((item) => {
      const matchProvider = sourceProviderFilter === 'ALL' || item.provider_type === sourceProviderFilter;
      if (!matchProvider) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        item.name.toLowerCase().includes(query) ||
        item.provider_type.toLowerCase().includes(query) ||
        item.base_url.toLowerCase().includes(query)
      );
    });
  }, [aiSources, sourceQuery, sourceProviderFilter]);

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return aiModels.filter((item) => {
      if (modelStatusFilter === 'ACTIVE' && !item.is_active) {
        return false;
      }
      if (modelStatusFilter === 'INACTIVE' && item.is_active) {
        return false;
      }
      const itemIsVoiceClone = isVoiceCloneConfig(item.api_type, item.endpoint_path);
      if (modelCapabilityFilter === 'voice_clone') {
        if (!itemIsVoiceClone) {
          return false;
        }
      } else if (modelCapabilityFilter !== 'ALL' && item.capability !== modelCapabilityFilter) {
        return false;
      } else if (modelCapabilityFilter === 'tts' && itemIsVoiceClone) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        item.model_key.toLowerCase().includes(query) ||
        (item.display_name || '').toLowerCase().includes(query) ||
        item.upstream_model.toLowerCase().includes(query) ||
        (item.capability || '').toLowerCase().includes(query)
      );
    });
  }, [aiModels, modelQuery, modelStatusFilter, modelCapabilityFilter]);

  const filteredDeletedModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return deletedAiModels.filter((item) => {
      const itemIsVoiceClone = isVoiceCloneConfig(item.api_type, item.endpoint_path);
      if (modelCapabilityFilter === 'voice_clone') {
        if (!itemIsVoiceClone) {
          return false;
        }
      } else if (modelCapabilityFilter !== 'ALL' && item.capability !== modelCapabilityFilter) {
        return false;
      } else if (modelCapabilityFilter === 'tts' && itemIsVoiceClone) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        item.model_key.toLowerCase().includes(query) ||
        (item.display_name || '').toLowerCase().includes(query) ||
        item.upstream_model.toLowerCase().includes(query) ||
        (item.capability || '').toLowerCase().includes(query)
      );
    });
  }, [deletedAiModels, modelQuery, modelCapabilityFilter]);

  const modelGroups = useMemo(() => {
    const groups: Record<AiModelStatusGroupKey, PlatformAiModelItem[]> = {
      enabled: [],
      hidden: [],
      disabled: [],
      deleted: [],
    };
    const sortByPriority = (items: PlatformAiModelItem[]) => [...items].sort((left, right) => {
      if (left.is_default !== right.is_default) {
        return left.is_default ? -1 : 1;
      }
      return left.model_key.localeCompare(right.model_key);
    });

    filteredModels.forEach((item) => {
      if (!item.is_visible) {
        groups.hidden.push(item);
        return;
      }
      if (!item.is_active) {
        groups.disabled.push(item);
        return;
      }
      groups.enabled.push(item);
    });
    groups.deleted = filteredDeletedModels;

    return [
      { key: 'enabled' as const, label: '启用', items: sortByPriority(groups.enabled), isDeleted: false },
      { key: 'hidden' as const, label: '隐藏', items: sortByPriority(groups.hidden), isDeleted: false },
      { key: 'disabled' as const, label: '禁用', items: sortByPriority(groups.disabled), isDeleted: false },
      { key: 'deleted' as const, label: '已删除', items: sortByPriority(groups.deleted), isDeleted: true },
    ].filter((group) => group.items.length > 0);
  }, [filteredModels, filteredDeletedModels]);

  const buildUsageParams = () => {
    const params: Record<string, unknown> = {};
    if (usageRangePreset === 'custom') {
      Object.assign(params, resolveCustomIsoRange(usageCustomFrom, usageCustomTo));
    } else {
      params.days = Number(usageRangePreset);
    }
    if (usageCapabilityFilter !== 'ALL') params.capability = usageCapabilityFilter;
    if (usageModelIdFilter) params.model_id = usageModelIdFilter;
    if (usageSourceIdFilter) params.source_id = usageSourceIdFilter;
    if (usageSuccessFilter === 'SUCCESS') params.success = true;
    if (usageSuccessFilter === 'FAILED') params.success = false;
    return params;
  };

  const loadConfigData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [sourceResp, modelResp, proxyResp] = await Promise.all([
        platformApi.listGlobalAiSources(),
        platformApi.listGlobalAiModels(),
        platformApi.listOutboundProxies({ status: 'all', protocol: 'all' }),
      ]);
      const sourceData = pickApiData<{ items: PlatformAiSourceItem[] }>(sourceResp);
      const modelData = pickApiData<{ items: PlatformAiModelItem[] }>(modelResp);
      const proxyData = pickApiData<{ items: PlatformOutboundProxyItem[] }>(proxyResp);
      setAiSources(sourceData?.items || []);
      setAiModels(modelData?.items || []);
      setOutboundProxies(proxyData?.items || []);
      setDeletedAiModels((prev) => prev.filter(
        (item) => !(modelData?.items || []).some((model) => model.id === item.id),
      ));
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 AI 配置失败') });
    } finally {
      setLoading(false);
    }
  };

  const loadGatewayRuntime = async () => {
    try {
      const response = await platformApi.getAiGatewayRuntime();
      setGatewayRuntime(pickApiData<PlatformAiGatewayRuntime>(response) || null);
    } catch {
      setGatewayRuntime(null);
    }
  };

  useEffect(() => {
    loadConfigData();
    void loadGatewayRuntime();
  }, []);

  const loadUsageData = async () => {
    if (!shouldLoadUsage) {
      setUsageSummary(null);
      setUsageLogs([]);
      setUsageLoading(false);
      return;
    }
    setUsageLoading(true);
    setMessage(null);
    try {
      const usageParams = buildUsageParams();
      const [usageSummaryResp, usageLogsResp] = await Promise.all([
        platformApi.getGlobalAiUsageSummary(usageParams),
        platformApi.listGlobalAiUsageLogs({ ...usageParams, page: 1, page_size: 20 }),
      ]);
      const summaryData = pickApiData<PlatformAiUsageSummary>(usageSummaryResp);
      const logsData = pickApiData<{ items: PlatformAiUsageLogItem[] } & Record<string, unknown>>(usageLogsResp);
      setUsageSummary(summaryData || null);
      setUsageLogs((logsData?.items || []) as PlatformAiUsageLogItem[]);
      return usageParams;
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 AI 调用统计失败') });
      return null;
    } finally {
      setUsageLoading(false);
    }
  };

  const loadUsageBreakdown = async (paramsOverride?: Record<string, unknown> | null) => {
    if (!shouldLoadUsage) {
      setUsageBreakdown(null);
      setUsageBreakdownLoading(false);
      return;
    }
    const usageParams = paramsOverride || buildUsageParams();
    setUsageBreakdownLoading(true);
    try {
      const response = await platformApi.getGlobalAiUsageBreakdown(usageParams);
      const data = pickApiData<PlatformAiUsageBreakdown>(response);
      setUsageBreakdown(data || null);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 AI 调用分布失败') });
    } finally {
      setUsageBreakdownLoading(false);
    }
  };

  const loadData = async () => {
    await Promise.all([loadConfigData(), loadGatewayRuntime()]);
    if (shouldLoadUsage) {
      await loadUsageData();
    }
  };

  useEffect(() => {
    if (usageRangePreset === 'custom' && (!usageCustomFrom || !usageCustomTo)) {
      return;
    }
    if (!shouldLoadUsage) {
      setUsageSummary(null);
      setUsageBreakdown(null);
      setUsageLogs([]);
      setUsageLoading(false);
      setUsageBreakdownLoading(false);
      return;
    }
    setUsageBreakdown(null);
    void (async () => {
      const params = await loadUsageData();
      if (params) {
        void loadUsageBreakdown(params);
      }
    })();
  }, [shouldLoadUsage, usageRangePreset, usageCustomFrom, usageCustomTo, usageCapabilityFilter, usageModelIdFilter, usageSourceIdFilter, usageSuccessFilter]);

  useEffect(() => {
    if (fixedTab) {
      setActiveTab(fixedTab);
    }
  }, [fixedTab]);

  useEffect(() => {
    setAiSourceTestResult(null);
  }, [
    aiSourceForm.editing_id,
    aiSourceForm.provider_type,
    aiSourceForm.base_url,
    aiSourceForm.api_keys,
    aiSourceForm.custom_headers_json,
    aiSourceForm.test_path,
  ]);

  useEffect(() => {
    setAiModelTestResult(null);
  }, [
    aiModelForm.editing_id,
    aiModelForm.default_source_id,
    aiModelForm.upstream_model,
    aiModelForm.endpoint_path,
    aiModelForm.api_type,
    aiModelForm.request_overrides_json,
    aiModelTestSourceId,
    aiModelTestPrompt,
    aiModelTestVoiceId,
    aiModelTestLanguageBoost,
  ]);

  const handleUsageRangePresetChange = (value: AiUsageRangePreset) => {
    if (value === 'custom' && (!usageCustomFrom || !usageCustomTo)) {
      setUsageCustomFrom(formatDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
      setUsageCustomTo(formatDateInput(new Date()));
    }
    setUsageRangePreset(value);
  };

  const resetAiSourceForm = () => {
    setAiSourceForm(EMPTY_AI_SOURCE_FORM);
    setShowAdvancedHeaders(false);
    setAiSourceTestResult(null);
  };

  const openCreateAiSourceModal = () => {
    resetAiSourceForm();
    setSourceModalOpen(true);
  };

  const closeAiSourceModal = () => {
    setSourceModalOpen(false);
  };

  const openEditAiSourceModal = (item: PlatformAiSourceItem) => {
    const hasCustomHeaders = Object.keys(item.custom_headers || {}).length > 0;
    setAiSourceForm({
      editing_id: item.id,
      name: item.name,
      provider_type: item.provider_type || 'openai-compatible',
      base_url: isRunningHubProviderType(item.provider_type) ? RUNNINGHUB_BASE_URL : item.base_url,
      api_keys: buildAiSourceApiKeyForms(item),
      credentials: buildAiSourceCredentialsForm(item),
      custom_headers_json: JSON.stringify(item.custom_headers || {}, null, 2),
      outbound_proxy_id: item.outbound_proxy_id || '',
      is_active: item.is_active,
      test_path: resolveDefaultSourceTestPath(item.provider_type),
    });
    setShowAdvancedHeaders(hasCustomHeaders);
    setSourceModalOpen(true);
  };

  const addAiSourceApiKey = () => {
    setAiSourceForm((prev) => ({
      ...prev,
      api_keys: [
        ...prev.api_keys,
        { label: `Key ${prev.api_keys.length + 1}`, api_key: '', is_active: true },
      ],
    }));
  };

  const updateAiSourceApiKey = (index: number, patch: Partial<AiSourceApiKeyForm>) => {
    setAiSourceForm((prev) => ({
      ...prev,
      api_keys: prev.api_keys.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      )),
    }));
  };

  const removeAiSourceApiKey = (index: number) => {
    setAiSourceForm((prev) => {
      if (prev.api_keys.length <= 1) {
        return prev;
      }
      return {
        ...prev,
        api_keys: prev.api_keys.filter((_, itemIndex) => itemIndex !== index),
      };
    });
  };

  const resetAiModelForm = () => {
    setAiModelForm(EMPTY_AI_MODEL_FORM);
    setAiModelTestSourceId('');
    setAiModelTestMode('default');
    setAiModelTestResult(null);
  };

  const openCreateAiModelModal = () => {
    const preferredSource = aiSources.find((item) => item.is_active) || aiSources[0];
    resetAiModelForm();
    if (preferredSource) {
      setAiModelForm((prev) => {
        const nextForm = {
          ...prev,
          default_source_id: preferredSource.id,
          source_routes: [buildDefaultModelSourceRoute(preferredSource.id)],
        };
        return isRunningHubProviderType(preferredSource.provider_type)
          ? applyRunningHubModelDefaults(nextForm)
          : nextForm;
      });
      setAiModelTestSourceId(preferredSource.id);
    }
    setModelModalOpen(true);
  };

  const openCreateAliyunIceVideoTranslationModelModal = () => {
    const videoSource = aiSources.find((item) => item.is_active && isAliyunIceProviderType(item.provider_type))
      || aiSources.find((item) => isAliyunIceProviderType(item.provider_type));
    resetAiModelForm();
    setAiModelForm((prev) => {
      const nextForm = videoSource
        ? {
            ...prev,
            default_source_id: videoSource.id,
            source_routes: [buildDefaultModelSourceRoute(videoSource.id)],
          }
        : prev;
      return applyAliyunIceVideoTranslationDefaults(nextForm);
    });
    setAiModelTestSourceId(videoSource?.id || '');
    setModelModalOpen(true);
  };

  const openCreateDashscopeVideoRetalkModelModal = () => {
    const videoSource = aiSources.find((item) => item.is_active && isDashscopeOpenAiProviderType(item.provider_type))
      || aiSources.find((item) => isDashscopeOpenAiProviderType(item.provider_type));
    resetAiModelForm();
    setAiModelForm((prev) => {
      const nextForm = videoSource
        ? {
            ...prev,
            default_source_id: videoSource.id,
            source_routes: [buildDefaultModelSourceRoute(videoSource.id)],
          }
        : prev;
      return applyDashscopeVideoRetalkDefaults(nextForm);
    });
    setAiModelTestSourceId(videoSource?.id || '');
    setModelModalOpen(true);
  };

  const openCreateVoiceCloneModelModal = () => {
    const audioSource = aiSources.find((item) => item.is_active && supportsVoiceCloneProviderType(item.provider_type))
      || aiSources.find((item) => supportsVoiceCloneProviderType(item.provider_type));
    resetAiModelForm();
    if (audioSource) {
      const providerType = audioSource.provider_type;
      setAiModelForm((prev) => ({
        ...prev,
        model_key: resolveDefaultVoiceCloneKey(providerType),
        display_name: resolveDefaultVoiceCloneDisplayName(providerType),
        capability: 'tts',
        execution_mode: 'sync',
        pricing_mode: 'per_call',
        rmb_per_call: prev.rmb_per_call || '0',
        points_per_call: prev.points_per_call || '0',
        default_source_id: audioSource.id,
        upstream_model: resolveDefaultVoiceCloneModel(providerType),
        endpoint_path: resolveAudioVoiceCloneEndpoint(providerType),
        api_type: resolveAudioVoiceCloneApiType(providerType),
        minimax_audio_mode: 'voice_clone',
        is_default: false,
        source_routes: [{
          ...buildDefaultModelSourceRoute(audioSource.id),
          upstream_model: resolveDefaultVoiceCloneModel(providerType),
          endpoint_path: resolveAudioVoiceCloneEndpoint(providerType),
          api_type: resolveAudioVoiceCloneApiType(providerType),
        }],
      }));
      setAiModelTestSourceId(audioSource.id);
    } else {
      setAiModelForm((prev) => ({
        ...prev,
        model_key: resolveDefaultVoiceCloneKey(),
        display_name: resolveDefaultVoiceCloneDisplayName(),
        capability: 'tts',
        execution_mode: 'sync',
        pricing_mode: 'per_call',
        upstream_model: resolveDefaultVoiceCloneModel(),
        endpoint_path: resolveAudioVoiceCloneEndpoint(),
        api_type: resolveAudioVoiceCloneApiType(),
        minimax_audio_mode: 'voice_clone',
        is_default: false,
      }));
    }
    setModelModalOpen(true);
  };

  const closeAiModelModal = () => {
    setModelModalOpen(false);
  };

  const openEditAiModelModal = (item: PlatformAiModelItem) => {
    const imageQualityResolutionRates = parseImageQualityResolutionRates(item.request_overrides);
    const imageQualityResolutionRateForm = IMAGE_QUALITY_OPTIONS.reduce((qualityAcc, quality) => {
      qualityAcc[quality.key] = IMAGE_RESOLUTION_OPTIONS.reduce((resolutionAcc, resolution) => {
        const rate = imageQualityResolutionRates[quality.key]?.[resolution.key] || {};
        resolutionAcc[resolution.key] = {
          cost_rmb_per_call: String(rate.cost_rmb_per_call ?? rate.rmb_per_call ?? 0),
          points_per_call: String(rate.points_per_call ?? 0),
          preferred_route_key: String(rate.preferred_route_key || ''),
        };
        return resolutionAcc;
      }, {} as Record<ImageResolutionKey, ImageQualityResolutionRateForm>);
      return qualityAcc;
    }, createEmptyImageQualityResolutionRates());
    const videoResolutionRates = parseVideoResolutionRates(item.request_overrides);
    const videoResolutionRateForm = VIDEO_RESOLUTION_OPTIONS.reduce((acc, option) => {
      const rate = videoResolutionRates[option.key] || {};
      acc[option.key] = {
        cost_rmb_per_second: String(rate.cost_rmb_per_second ?? rate.rmb_per_second ?? 0),
        points_per_second: String(rate.points_per_second ?? 0),
        preferred_route_key: String(rate.preferred_route_key || ''),
      };
      return acc;
    }, createEmptyVideoResolutionRates());
    const source = aiSourceMap.get(item.default_source_id);
    const minimaxAudioMode = inferAudioModelKind(item.api_type, item.endpoint_path);
    const audioOverrides = (item.request_overrides?.audio && typeof item.request_overrides.audio === 'object' && !Array.isArray(item.request_overrides.audio))
      ? item.request_overrides.audio as Record<string, unknown>
      : {};
    const useMinimaxCharacterPricing =
      item.capability === 'tts'
      && minimaxAudioMode === 'speech'
      && isAudioProviderType(source?.provider_type);
    const nextForm = {
      editing_id: item.id,
      model_key: item.model_key,
      display_name: item.display_name || '',
      capability: item.capability || 'chat',
      execution_mode: item.execution_mode || 'sync',
      pricing_mode:
        useMinimaxCharacterPricing
          ? 'per_mchar'
          : item.capability === 'video'
          ? 'per_call'
          : item.pricing_mode === 'per_second'
            ? 'per_minute'
            : item.pricing_mode || resolvePricingModeByCapability(item.capability || 'chat'),
      rmb_per_mtoken: String(item.rmb_per_mtoken ?? 0),
      rmb_per_call: String(item.rmb_per_call ?? 0),
      rmb_per_minute: String(item.rmb_per_minute ?? 0),
      points_per_mtoken: String(item.points_per_mtoken ?? 0),
      points_per_call: String(item.points_per_call ?? 0),
      points_per_minute: String(item.points_per_minute ?? 0),
      image_quality_resolution_rates: imageQualityResolutionRateForm,
      video_resolution_rates: videoResolutionRateForm,
      default_source_id: item.default_source_id,
      upstream_model: item.upstream_model,
      endpoint_path: isRunningHubProviderType(source?.provider_type)
        ? resolveRunningHubEndpointRoot(item.endpoint_path, item.upstream_model)
        : item.endpoint_path || '/chat/completions',
      api_type: item.api_type || (isRunningHubProviderType(source?.provider_type) ? RUNNINGHUB_TASK_API_TYPE : 'openai-chat-completions'),
      minimax_audio_mode: minimaxAudioMode,
      target_tts_model_key: String(audioOverrides.linked_tts_model_key || ''),
      request_overrides_json: JSON.stringify(item.request_overrides || {}, null, 2),
      is_default: item.is_default,
      is_active: item.is_active,
      is_visible: item.is_visible !== false,
      source_routes: buildModelSourceRoutesFromItem(item),
    };
    setAiModelForm(
      isRunningHubProviderType(source?.provider_type)
        ? nextForm
        : normalizeStandardModelDefaults(nextForm),
    );
    setAiModelTestSourceId(item.default_source_id);
    setModelModalOpen(true);
  };

  const handleProviderTypeChange = (providerType: string) => {
    const nextPreset = PROVIDER_PRESET_MAP.get(providerType);
    setAiSourceForm((prev) => {
      const currentPreset = PROVIDER_PRESET_MAP.get(prev.provider_type);
      const currentBase = prev.base_url.trim();
      const currentTestPath = prev.test_path.trim();
      const shouldApplyPresetBase =
        !currentBase || (!!currentPreset && currentBase === currentPreset.base_url);
      const shouldApplyPresetTestPath =
        !currentTestPath
        || currentTestPath === '/models'
        || currentTestPath === '/v1beta/models'
        || currentTestPath === RUNNINGHUB_SOURCE_TEST_PATH
        || currentTestPath === '/'
        || currentTestPath === '/t2a_v2'
        || currentTestPath === '/v1/t2a_v2';
      const nextDefaultTestPath = resolveDefaultSourceTestPath(providerType);
      const nextBaseUrl = isRunningHubProviderType(providerType)
        ? RUNNINGHUB_BASE_URL
        : shouldApplyPresetBase
          ? nextPreset?.base_url || ''
          : prev.base_url;

      return {
        ...prev,
        provider_type: providerType,
        base_url: nextBaseUrl,
        credentials: isVertexAiProviderType(providerType)
          ? {
              ...prev.credentials,
              auth_mode: prev.credentials.auth_mode || 'api_key',
              location: prev.credentials.location || 'global',
            }
          : prev.credentials,
        test_path: isRunningHubProviderType(providerType) || isAliyunIceProviderType(providerType) || shouldApplyPresetTestPath
          ? nextDefaultTestPath
          : prev.test_path,
      };
    });
  };

  const applyDashScopeModelHint = (modelName: string) => {
    setAiModelForm((prev) => ({
      ...prev,
      model_key: prev.model_key.trim() ? prev.model_key : modelName,
      upstream_model: modelName,
      display_name: prev.display_name.trim() ? prev.display_name : modelName,
    }));
  };

  const applyDashscopeVideoRetalkTemplate = () => {
    setAiModelTestMode('default');
    setAiModelTestResult(null);
    setAiModelForm((prev) => applyDashscopeVideoRetalkDefaults(prev));
  };

  const handleModelCapabilityChange = (capability: AiModelForm['capability']) => {
    setAiModelForm((prev) => {
      const currentDefault = CAPABILITY_DEFAULT_ENDPOINT.get(prev.capability) || '/chat/completions';
      const nextDefault = CAPABILITY_DEFAULT_ENDPOINT.get(capability) || '/chat/completions';
      const currentEndpoint = prev.endpoint_path.trim();
      const shouldUpdateEndpoint = !currentEndpoint || currentEndpoint === currentDefault;
      const nextSource = aiSourceMap.get(prev.default_source_id);
      if (isRunningHubProviderType(nextSource?.provider_type)) {
        return {
          ...prev,
          capability,
          pricing_mode: resolvePricingModeByCapability(capability),
          endpoint_path: resolveRunningHubEndpointRoot(
            shouldUpdateEndpoint || shouldClearRunningHubEndpoint(currentEndpoint, prev.capability)
              ? ''
              : prev.endpoint_path,
            prev.upstream_model,
          ),
          api_type: RUNNINGHUB_TASK_API_TYPE,
        };
      }
      if (capability === 'video' && isAliyunIceProviderType(nextSource?.provider_type)) {
        return applyAliyunIceVideoTranslationDefaults({
          ...prev,
          capability,
        });
      }
      if (capability === 'tts' && isAudioProviderType(nextSource?.provider_type)) {
        return {
          ...prev,
          capability,
          pricing_mode: 'per_mchar',
          minimax_audio_mode: 'speech',
          endpoint_path: resolveAudioSpeechEndpoint(nextSource?.provider_type),
          api_type: resolveAudioSpeechApiType(nextSource?.provider_type),
          upstream_model: prev.upstream_model.trim() || resolveDefaultAudioSpeechModel(nextSource?.provider_type),
        };
      }
      return {
        ...prev,
        capability,
        pricing_mode: resolvePricingModeByCapability(capability),
        minimax_audio_mode: capability === 'tts' ? prev.minimax_audio_mode : 'speech',
        endpoint_path: shouldUpdateEndpoint ? nextDefault : prev.endpoint_path,
      };
    });
  };

  const addModelSourceRoute = (sourceId: string) => {
    if (!sourceId) return;
    setAiModelForm((prev) => {
      const source = aiSourceMap.get(sourceId);
      const nextRoutes = [...prev.source_routes, buildDefaultModelSourceRoute(sourceId)];
      const nextForm = {
        ...prev,
        default_source_id: prev.default_source_id || sourceId,
        source_routes: nextRoutes,
      };
      if (nextRoutes.length === 1 && isRunningHubProviderType(source?.provider_type)) {
        return applyRunningHubModelDefaults(nextForm);
      }
      if (nextRoutes.length === 1 && prev.capability === 'video' && isAliyunIceProviderType(source?.provider_type)) {
        return applyAliyunIceVideoTranslationDefaults(nextForm);
      }
      if (nextRoutes.length === 1 && prev.capability === 'tts' && isAudioProviderType(source?.provider_type)) {
        return {
          ...nextForm,
          pricing_mode: 'per_mchar',
          minimax_audio_mode: 'speech',
          endpoint_path: resolveAudioSpeechEndpoint(source?.provider_type),
          api_type: resolveAudioSpeechApiType(source?.provider_type),
          upstream_model: prev.upstream_model.trim() || resolveDefaultAudioSpeechModel(source?.provider_type),
        };
      }
      return nextForm;
    });
  };

  const updateModelSourceRoute = (index: number, patch: Partial<AiModelSourceRouteForm>) => {
    setAiModelForm((prev) => ({
      ...prev,
      source_routes: prev.source_routes.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      )),
    }));
  };

  const moveModelSourceRoute = (index: number, direction: -1 | 1) => {
    setAiModelForm((prev) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.source_routes.length) {
        return prev;
      }
      const nextRoutes = [...prev.source_routes];
      const current = nextRoutes[index];
      nextRoutes[index] = nextRoutes[nextIndex];
      nextRoutes[nextIndex] = current;
      const primary = nextRoutes.find((item) => item.is_active && item.source_id) || nextRoutes[0];
      return {
        ...prev,
        default_source_id: primary?.source_id || prev.default_source_id,
        source_routes: nextRoutes,
      };
    });
  };

  const removeModelSourceRoute = (index: number) => {
    setAiModelForm((prev) => {
      const removedRouteKey = prev.source_routes[index]?.route_key || '';
      const nextRoutes = prev.source_routes.filter((_, itemIndex) => itemIndex !== index);
      const primary = nextRoutes.find((item) => item.is_active && item.source_id) || nextRoutes[0];
      return {
        ...prev,
        default_source_id: primary?.source_id || '',
        source_routes: nextRoutes,
        image_quality_resolution_rates: clearPreferredRouteKeyFromImageRates(prev.image_quality_resolution_rates, removedRouteKey),
        video_resolution_rates: clearPreferredRouteKeyFromVideoRates(prev.video_resolution_rates, removedRouteKey),
      };
    });
  };

  const applyMinimaxAudioTemplate = (mode: AudioModelKind) => {
    const nextMode: AudioModelKind = mode === 'voice_clone' && !supportsVoiceCloneProviderType(selectedModelSource?.provider_type)
      ? 'speech'
      : mode;
    const isVoiceClone = nextMode === 'voice_clone';
    setAiModelTestMode('default');
    setAiModelTestResult(null);
    setAiModelForm((prev) => ({
      ...prev,
      capability: 'tts',
      execution_mode: 'sync',
      pricing_mode: isVoiceClone ? 'per_call' : 'per_mchar',
      minimax_audio_mode: nextMode,
      model_key: isVoiceClone && !prev.model_key.trim()
        ? resolveDefaultVoiceCloneKey(selectedModelSource?.provider_type)
        : prev.model_key,
      display_name: isVoiceClone && !prev.display_name.trim()
        ? resolveDefaultVoiceCloneDisplayName(selectedModelSource?.provider_type)
        : prev.display_name,
      upstream_model: isVoiceClone
        ? (prev.upstream_model.trim() || resolveDefaultVoiceCloneModel(selectedModelSource?.provider_type))
        : (prev.upstream_model.trim() || resolveDefaultAudioSpeechModel(selectedModelSource?.provider_type)),
      api_type: isVoiceClone
        ? resolveAudioVoiceCloneApiType(selectedModelSource?.provider_type)
        : resolveAudioSpeechApiType(selectedModelSource?.provider_type),
      endpoint_path: isVoiceClone
        ? resolveAudioVoiceCloneEndpoint(selectedModelSource?.provider_type)
        : resolveAudioSpeechEndpoint(selectedModelSource?.provider_type),
      source_routes: prev.source_routes.map((route) => {
        const source = aiSourceMap.get(route.source_id);
        if (!isAudioProviderType(source?.provider_type)) {
          return route;
        }
        return {
          ...route,
          api_type: isVoiceClone ? resolveAudioVoiceCloneApiType(source?.provider_type) : resolveAudioSpeechApiType(source?.provider_type),
          endpoint_path: isVoiceClone ? resolveAudioVoiceCloneEndpoint(source?.provider_type) : resolveAudioSpeechEndpoint(source?.provider_type),
          upstream_model: route.upstream_model.trim()
            ? route.upstream_model
            : isVoiceClone
              ? resolveDefaultVoiceCloneModel(source?.provider_type)
              : resolveDefaultAudioSpeechModel(source?.provider_type),
        };
      }),
    }));
  };

  const runAiSourceConnectivityTest = async (sourceFromList?: PlatformAiSourceItem) => {
    setAiSourceTesting(true);
    setMessage(null);
    try {
      let payload: {
        source_id?: string;
        provider_type?: string;
        base_url?: string;
        api_key?: string;
        custom_headers?: Record<string, string>;
        credentials?: Record<string, unknown>;
        outbound_proxy_id?: string | null;
        test_path?: string;
      };

      if (sourceFromList) {
        payload = {
          source_id: sourceFromList.id,
          provider_type: sourceFromList.provider_type,
          base_url: isRunningHubProviderType(sourceFromList.provider_type) ? RUNNINGHUB_BASE_URL : sourceFromList.base_url,
          custom_headers: sourceFromList.custom_headers,
          outbound_proxy_id: sourceFromList.outbound_proxy_id || null,
          test_path: resolveDefaultSourceTestPath(sourceFromList.provider_type),
        };
      } else {
        const customHeadersRaw = parseJsonObject(aiSourceForm.custom_headers_json, '自定义请求头');
        const customHeaders: Record<string, string> = {};
        Object.entries(customHeadersRaw).forEach(([key, value]) => {
          customHeaders[key] = String(value);
        });
        const testApiKey = aiSourceForm.api_keys.find((item) => item.api_key.trim())?.api_key.trim() || '';

        payload = {
          source_id: aiSourceForm.editing_id,
          provider_type: aiSourceForm.provider_type,
          base_url: isRunningHubProviderType(aiSourceForm.provider_type) ? RUNNINGHUB_BASE_URL : aiSourceForm.base_url.trim(),
          api_key: testApiKey,
          custom_headers: customHeaders,
          credentials: buildAiSourceCredentialsPayload(aiSourceForm),
          outbound_proxy_id: aiSourceForm.outbound_proxy_id || null,
          test_path: isRunningHubProviderType(aiSourceForm.provider_type)
            ? RUNNINGHUB_SOURCE_TEST_PATH
            : aiSourceForm.test_path.trim() || resolveDefaultSourceTestPath(aiSourceForm.provider_type),
        };
      }

      const response = await platformApi.testGlobalAiSourceConnection(payload);
      const result = pickApiData<PlatformAiSourceConnectivityTestResult>(response);
      setAiSourceTestResult(result);

      setMessage({
        type: result.ok ? 'success' : 'error',
        text: result.ok ? 'AI 源连通性测试通过' : `${result.message}${result.status_code ? ` (HTTP ${result.status_code})` : ''}`,
      });
    } catch (error: any) {
      setAiSourceTestResult(null);
      setMessage({ type: 'error', text: pickApiErrorMessage(error, 'AI 源连通性测试失败') });
    } finally {
      setAiSourceTesting(false);
    }
  };

  const runAiModelConnectivityTest = async (itemFromList?: PlatformAiModelItem, ttsMode: TtsTestMode = 'default') => {
    setAiModelTesting(true);
    setAiModelTestMode(ttsMode);
    setMessage(null);
    try {
      let modelPayload: {
        model_id?: string;
        capability?: AiModelForm['capability'];
        source_id?: string;
        upstream_model?: string;
        endpoint_path?: string;
        api_type?: string;
        request_overrides?: Record<string, unknown>;
        test_prompt?: string;
      };

      const capability = itemFromList ? itemFromList.capability || 'chat' : aiModelForm.capability;
      const effectiveSourceId = itemFromList
        ? itemFromList.default_source_id
        : aiModelTestSourceId || aiModelForm.default_source_id;
      const effectiveSource = aiSourceMap.get(effectiveSourceId);
      const isMinimaxTts = capability === 'tts' && isMinimaxProviderType(effectiveSource?.provider_type);
      const ttsProbeOverrides =
        capability === 'tts'
          ? {
              voice_id: aiModelTestVoiceId.trim() || 'male-qn-qingse',
              language_boost: aiModelTestLanguageBoost.trim() || 'English',
              output_format: 'hex',
            }
          : {};

      if (itemFromList) {
        modelPayload = {
          model_id: itemFromList.id,
          capability,
          source_id: effectiveSourceId,
          request_overrides: ttsProbeOverrides,
          test_prompt: aiModelTestPrompt.trim() || 'ping',
        };
      } else {
        const requestOverrides = parseJsonObject(aiModelForm.request_overrides_json, '请求覆盖参数');
        const mergedRequestOverrides =
          capability === 'tts'
            ? {
                ...requestOverrides,
                voice_id: aiModelTestVoiceId.trim() || (requestOverrides.voice_id as string) || ttsProbeOverrides.voice_id,
                language_boost:
                  aiModelTestLanguageBoost.trim() || (requestOverrides.language_boost as string) || ttsProbeOverrides.language_boost,
                output_format: 'hex',
              }
            : requestOverrides;
        modelPayload = {
          model_id: aiModelForm.editing_id,
          capability,
          source_id: effectiveSourceId,
          upstream_model: aiModelForm.upstream_model.trim() || aiModelForm.model_key.trim(),
          endpoint_path: isRunningHubProviderType(effectiveSource?.provider_type)
            ? resolveRunningHubEndpointRoot(aiModelForm.endpoint_path, aiModelForm.upstream_model)
            : aiModelForm.endpoint_path.trim() || '/chat/completions',
          api_type: isRunningHubProviderType(effectiveSource?.provider_type)
            ? RUNNINGHUB_TASK_API_TYPE
            : aiModelForm.api_type.trim() || 'openai-chat-completions',
          request_overrides: mergedRequestOverrides,
          test_prompt: aiModelTestPrompt.trim() || 'ping',
        };
      }

      if (isMinimaxTts && ttsMode !== 'default') {
        modelPayload.api_type = ttsMode === 'sync' ? 'minimax-tts-sync' : 'minimax-tts-async';
        modelPayload.endpoint_path = ttsMode === 'sync' ? '/v1/t2a_v2' : '/v1/t2a_async_v2';
      }

      if (!modelPayload.source_id) {
        throw new Error('请先选择测试供应商');
      }

      const response = await platformApi.testGlobalAiModelConnection(modelPayload);
      const result = pickApiData<PlatformAiModelConnectivityTestResult>(response);
      setAiModelTestResult(result);

      const modeLabel = ttsMode === 'sync' ? '（同步）' : ttsMode === 'async' ? '（异步）' : '';

      setMessage({
        type: result.ok ? 'success' : 'error',
        text: result.ok
          ? `AI 模型测试通过${modeLabel}`
          : `${result.message}${result.status_code ? ` (HTTP ${result.status_code})` : ''}`,
      });
    } catch (error: any) {
      setAiModelTestResult(null);
      setMessage({ type: 'error', text: pickApiErrorMessage(error, 'AI 模型测试失败') });
    } finally {
      setAiModelTesting(false);
    }
  };

  const runAiImageModelBatchTest = async () => {
    setAiImageModelBatchTesting(true);
    setAiImageModelBatchResult(null);
    setMessage(null);
    try {
      const response = await platformApi.testGlobalAiModelsBatchConnection({
        capability: 'image',
        only_active: true,
        test_prompt: aiModelTestPrompt.trim() || '测试图片',
      });
      const result = pickApiData<PlatformAiModelBatchConnectivityTestResult>(response);
      setAiImageModelBatchResult(result);
      setMessage({
        type: result.failed > 0 ? 'error' : 'success',
        text: `生图模型批量实测完成：成功 ${result.success}，失败 ${result.failed}，共 ${result.total}`,
      });
    } catch (error: any) {
      setAiImageModelBatchResult(null);
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '生图模型批量实测失败') });
    } finally {
      setAiImageModelBatchTesting(false);
    }
  };

  const saveAiSource = async (event: React.FormEvent) => {
    event.preventDefault();
    setAiSourceSaving(true);
    setMessage(null);
    try {
      const customHeadersRaw = parseJsonObject(aiSourceForm.custom_headers_json, '自定义请求头');
      const customHeaders: Record<string, string> = {};
      Object.entries(customHeadersRaw).forEach(([key, value]) => {
        customHeaders[key] = String(value);
      });

      const providerType = aiSourceForm.provider_type.trim() || 'openai-compatible';
      const preset = PROVIDER_PRESET_MAP.get(providerType);
      const baseUrl = isRunningHubProviderType(providerType)
        ? RUNNINGHUB_BASE_URL
        : aiSourceForm.base_url.trim() || preset?.base_url || '';
      const apiKeys = aiSourceForm.api_keys.map((item, index) => ({
        id: item.id || null,
        label: item.label.trim() || `Key ${index + 1}`,
        api_key: item.api_key.trim(),
        sort_order: index,
        is_active: item.is_active,
      }));
      const primaryApiKey = apiKeys.find((item) => item.api_key)?.api_key || '';

      const payload = {
        name: aiSourceForm.name.trim(),
        provider_type: providerType,
        base_url: baseUrl,
        api_key: primaryApiKey,
        api_keys: isVertexAiProviderType(providerType) && aiSourceForm.credentials.auth_mode !== 'api_key' ? undefined : apiKeys,
        custom_headers: customHeaders,
        credentials: buildAiSourceCredentialsPayload(aiSourceForm),
        outbound_proxy_id: aiSourceForm.outbound_proxy_id || null,
        is_active: aiSourceForm.is_active,
      };

      if (aiSourceForm.editing_id) {
        const updatePayload: Record<string, unknown> = { ...payload };
        if (!payload.api_key) {
          delete updatePayload.api_key;
        }
        await platformApi.updateGlobalAiSource(aiSourceForm.editing_id, updatePayload);
        setMessage({ type: 'success', text: 'AI 源已更新' });
      } else {
        if (
          (!isVertexAiProviderType(providerType) || aiSourceForm.credentials.auth_mode === 'api_key')
          && (!payload.api_key || !apiKeys.some((item) => item.api_key && item.is_active))
        ) {
          throw new Error('新增 AI 源时必须填写 API Key');
        }
        await platformApi.createGlobalAiSource(payload);
        setMessage({ type: 'success', text: 'AI 源已创建' });
      }

      setSourceModalOpen(false);
      resetAiSourceForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存 AI 源失败') });
    } finally {
      setAiSourceSaving(false);
    }
  };

  const toggleAiSourceActive = async (item: PlatformAiSourceItem) => {
    setMessage(null);
    try {
      await platformApi.updateGlobalAiSource(item.id, { is_active: !item.is_active });
      setMessage({ type: 'success', text: 'AI 源状态已更新' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新 AI 源状态失败') });
    }
  };

  const removeAiSource = async (item: PlatformAiSourceItem) => {
    if (!window.confirm(`确认删除 AI 源 ${item.name} 吗？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalAiSource(item.id);
      setMessage({ type: 'success', text: 'AI 源已删除' });
      if (aiSourceForm.editing_id === item.id) {
        resetAiSourceForm();
      }
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除 AI 源失败') });
    }
  };

  const saveAiModel = async (event: React.FormEvent) => {
    event.preventDefault();
    setAiModelSaving(true);
    setMessage(null);
    try {
      const requestOverrides = parseJsonObject(aiModelForm.request_overrides_json, '请求覆盖参数');
      const unitPricePerMToken = Number(aiModelForm.rmb_per_mtoken);
      const unitPricePerCall = Number(aiModelForm.rmb_per_call);
      const unitPricePerMinute = Number(aiModelForm.rmb_per_minute);
      const sellPointsPerMToken = Number(aiModelForm.points_per_mtoken);
      const sellPointsPerCall = aiModelForm.capability === 'image' ? 0 : Number(aiModelForm.points_per_call);
      const sellPointsPerMinute = Number(aiModelForm.points_per_minute);
      const imageQualityResolutionRates = IMAGE_QUALITY_OPTIONS.reduce((qualityAcc, quality) => {
        qualityAcc[quality.key] = IMAGE_RESOLUTION_OPTIONS.reduce((resolutionAcc, resolution) => {
          const rawRate = aiModelForm.image_quality_resolution_rates[quality.key]?.[resolution.key] || {
            cost_rmb_per_call: '0',
            points_per_call: '0',
            preferred_route_key: '',
          };
          const costRmb = Number(rawRate.cost_rmb_per_call);
          const points = Number(rawRate.points_per_call);
          if (!Number.isFinite(costRmb) || costRmb < 0) {
            throw new Error(`图片 ${quality.label} ${resolution.label} 成本（人民币 / 次）必须是大于等于 0 的数字`);
          }
          if (!Number.isFinite(points) || points < 0) {
            throw new Error(`图片 ${quality.label} ${resolution.label} 扣费（积分 / 张）必须是大于等于 0 的数字`);
          }
          resolutionAcc[resolution.key] = {
            cost_rmb_per_call: costRmb,
            points_per_call: points,
            preferred_route_key: String(rawRate.preferred_route_key || '').trim(),
          };
          return resolutionAcc;
        }, {} as Record<ImageResolutionKey, ImageQualityResolutionRate>);
        return qualityAcc;
      }, {} as Record<ImageQualityKey, Record<ImageResolutionKey, ImageQualityResolutionRate>>);
      const videoResolutionRates = VIDEO_RESOLUTION_OPTIONS.reduce((acc, option) => {
        const rawRate = aiModelForm.video_resolution_rates[option.key] || {
          cost_rmb_per_second: '0',
          points_per_second: '0',
          preferred_route_key: '',
        };
        const costRmb = Number(rawRate.cost_rmb_per_second);
        const points = Number(rawRate.points_per_second);
        if (!Number.isFinite(costRmb) || costRmb < 0) {
          throw new Error(`视频 ${option.label} 成本（人民币 / 秒）必须是大于等于 0 的数字`);
        }
        if (!Number.isFinite(points) || points < 0) {
          throw new Error(`视频 ${option.label} 扣费（积分 / 秒）必须是大于等于 0 的数字`);
        }
        acc[option.key] = {
          cost_rmb_per_second: costRmb,
          points_per_second: points,
          preferred_route_key: String(rawRate.preferred_route_key || '').trim(),
        };
        return acc;
      }, {} as Record<VideoResolutionKey, VideoResolutionRate>);
      if (!Number.isFinite(unitPricePerMToken) || unitPricePerMToken < 0) {
        throw new Error(
          aiModelForm.pricing_mode === 'per_mchar'
            ? '模型成本单价（按 1M 字符）必须是大于等于 0 的数字'
            : '模型成本单价（按输出 token）必须是大于等于 0 的数字',
        );
      }
      if (!Number.isFinite(unitPricePerCall) || unitPricePerCall < 0) {
        throw new Error('模型成本单价（按次/张）必须是大于等于 0 的数字');
      }
      if (!Number.isFinite(unitPricePerMinute) || unitPricePerMinute < 0) {
        throw new Error('模型成本单价（按分钟）必须是大于等于 0 的数字');
      }
      if (!Number.isFinite(sellPointsPerMToken) || sellPointsPerMToken < 0) {
        throw new Error('模型扣费（按 token 积分）必须是大于等于 0 的数字');
      }
      if (!Number.isFinite(sellPointsPerCall) || sellPointsPerCall < 0) {
        throw new Error(
          aiModelForm.pricing_mode === 'per_mchar'
            ? '模型扣费（按 100 字符积分）必须是大于等于 0 的数字'
            : '模型扣费（按次/张积分）必须是大于等于 0 的数字',
        );
      }
      if (!Number.isFinite(sellPointsPerMinute) || sellPointsPerMinute < 0) {
        throw new Error('模型扣费（按分钟积分）必须是大于等于 0 的数字');
      }
      assignImageQualityResolutionRates(requestOverrides, imageQualityResolutionRates);
      assignVideoResolutionRates(requestOverrides, videoResolutionRates);
      const selectedPrimaryRoute =
        aiModelForm.source_routes.find((item) => item.is_active && item.source_id)
        || aiModelForm.source_routes.find((item) => item.source_id);
      const primarySourceCandidate = aiSourceMap.get(selectedPrimaryRoute?.source_id || '');
      const isAudioProviderModel = aiModelForm.capability === 'tts' && isAudioProviderType(primarySourceCandidate?.provider_type);
      const isMinimaxVoiceCloneModel =
        isAudioProviderModel
        && supportsVoiceCloneProviderType(primarySourceCandidate?.provider_type)
        && aiModelForm.minimax_audio_mode === 'voice_clone';
      const linkedTtsModel = isMinimaxVoiceCloneModel
        ? targetTtsModelOptions.find((item) => item.model_key === aiModelForm.target_tts_model_key)
        : null;
      if (isMinimaxVoiceCloneModel && isDashscopeCosyVoiceProviderType(primarySourceCandidate?.provider_type) && !linkedTtsModel) {
        throw new Error('请选择目标语音模型');
      }
      const audioProviderFamily = resolveAudioProviderFamily(primarySourceCandidate?.provider_type);
      if (isAudioProviderModel) {
        const nextAudioOverrides: Record<string, unknown> = {
          ...(requestOverrides.audio && typeof requestOverrides.audio === 'object' && !Array.isArray(requestOverrides.audio)
            ? requestOverrides.audio as Record<string, unknown>
            : {}),
          kind: isMinimaxVoiceCloneModel ? 'voice_clone' : 'speech',
          provider_family: audioProviderFamily,
          ...(linkedTtsModel ? {
            linked_tts_model_key: linkedTtsModel.model_key,
            target_model: linkedTtsModel.upstream_model || linkedTtsModel.model_key,
          } : {}),
          ...(!isMinimaxVoiceCloneModel ? {
            target_model: aiModelForm.upstream_model.trim() || aiModelForm.model_key.trim(),
          } : {}),
        };
        if (!isMinimaxVoiceCloneModel) {
          delete nextAudioOverrides.linked_tts_model_key;
          delete nextAudioOverrides.linked_tts_model_id;
        }
        requestOverrides.audio = nextAudioOverrides;
      }
      const sourceRoutes = aiModelForm.source_routes
        .filter((item) => item.source_id)
        .map((item, index) => {
          const routeSource = aiSourceMap.get(item.source_id);
          const isAudioRoute = isAudioProviderModel && isAudioProviderType(routeSource?.provider_type);
          const isAliyunIceRoute = aiModelForm.capability === 'video' && isAliyunIceProviderType(routeSource?.provider_type);
          const isDashscopeVideoRetalkRoute =
            isDashscopeVideoRetalkModel(aiModelForm)
            && isDashscopeOpenAiProviderType(routeSource?.provider_type);
          const routeRequestOverrides = parseJsonObject(item.request_overrides_json, '来源覆盖参数');
          if (isAudioRoute) {
            const nextRouteAudioOverrides: Record<string, unknown> = {
              ...(routeRequestOverrides.audio && typeof routeRequestOverrides.audio === 'object' && !Array.isArray(routeRequestOverrides.audio)
                ? routeRequestOverrides.audio as Record<string, unknown>
                : {}),
              kind: isMinimaxVoiceCloneModel ? 'voice_clone' : 'speech',
              provider_family: resolveAudioProviderFamily(routeSource?.provider_type),
              ...(linkedTtsModel ? {
                linked_tts_model_key: linkedTtsModel.model_key,
                target_model: linkedTtsModel.upstream_model || linkedTtsModel.model_key,
              } : {}),
              ...(!isMinimaxVoiceCloneModel ? {
                target_model: item.upstream_model.trim() || aiModelForm.upstream_model.trim() || aiModelForm.model_key.trim(),
              } : {}),
            };
            if (!isMinimaxVoiceCloneModel) {
              delete nextRouteAudioOverrides.linked_tts_model_key;
              delete nextRouteAudioOverrides.linked_tts_model_id;
            }
            routeRequestOverrides.audio = nextRouteAudioOverrides;
          }
          return {
            route_key: item.route_key,
            source_id: item.source_id,
            sort_order: index,
            is_active: item.is_active,
            upstream_model: isAliyunIceRoute
              ? 'SubmitVideoTranslationJob'
              : isDashscopeVideoRetalkRoute
              ? DASHSCOPE_VIDEORETALK_MODEL_KEY
              : item.upstream_model.trim() || (isAudioRoute ? (isMinimaxVoiceCloneModel ? resolveDefaultVoiceCloneModel(routeSource?.provider_type) : resolveDefaultAudioSpeechModel(routeSource?.provider_type)) : null),
            endpoint_path: isAliyunIceRoute
              ? '/SubmitVideoTranslationJob'
              : isDashscopeVideoRetalkRoute
              ? DASHSCOPE_VIDEORETALK_ENDPOINT
              : isAudioRoute
              ? isMinimaxVoiceCloneModel ? resolveAudioVoiceCloneEndpoint(routeSource?.provider_type) : resolveAudioSpeechEndpoint(routeSource?.provider_type)
              : item.endpoint_path.trim() || null,
            api_type: isAliyunIceRoute
              ? ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE
              : isDashscopeVideoRetalkRoute
              ? DASHSCOPE_VIDEORETALK_API_TYPE
              : isAudioRoute
              ? isMinimaxVoiceCloneModel ? resolveAudioVoiceCloneApiType(routeSource?.provider_type) : resolveAudioSpeechApiType(routeSource?.provider_type)
              : item.api_type.trim() || null,
            request_overrides: routeRequestOverrides,
          };
        });
      if (sourceRoutes.length === 0) {
        throw new Error('至少选择一个供应商');
      }
      const primarySourceId = sourceRoutes.find((item) => item.is_active)?.source_id || sourceRoutes[0].source_id;
      const primarySource = aiSourceMap.get(primarySourceId);
      const isRunningHubModel = isRunningHubProviderType(primarySource?.provider_type);
      const isAliyunIceVideoTranslationModel =
        aiModelForm.capability === 'video' && isAliyunIceProviderType(primarySource?.provider_type);
      const isDashscopeVideoRetalkPrimaryModel =
        isDashscopeVideoRetalkModel(aiModelForm) && isDashscopeOpenAiProviderType(primarySource?.provider_type);
      const pricingMode = isMinimaxVoiceCloneModel
        ? 'per_call'
        : isAudioProviderModel
          ? 'per_mchar'
          : aiModelForm.pricing_mode || resolvePricingModeByCapability(aiModelForm.capability);
      const payload = {
        model_key: aiModelForm.model_key.trim(),
        display_name: aiModelForm.display_name.trim() || aiModelForm.model_key.trim(),
        capability: aiModelForm.capability,
        execution_mode: isAudioProviderModel ? 'sync' : aiModelForm.execution_mode,
        pricing_mode: pricingMode,
        rmb_per_mtoken: unitPricePerMToken,
        rmb_per_call: unitPricePerCall,
        rmb_per_minute: unitPricePerMinute,
        points_per_mtoken: sellPointsPerMToken,
        points_per_call: sellPointsPerCall,
        points_per_minute: sellPointsPerMinute,
        default_source_id: primarySourceId,
        source_routes: sourceRoutes,
        upstream_model: isAliyunIceVideoTranslationModel
          ? 'SubmitVideoTranslationJob'
          : isDashscopeVideoRetalkPrimaryModel
            ? DASHSCOPE_VIDEORETALK_MODEL_KEY
          : aiModelForm.upstream_model.trim() || aiModelForm.model_key.trim(),
        endpoint_path: isAudioProviderModel
          ? isMinimaxVoiceCloneModel ? resolveAudioVoiceCloneEndpoint(primarySource?.provider_type) : resolveAudioSpeechEndpoint(primarySource?.provider_type)
          : isAliyunIceVideoTranslationModel
            ? '/SubmitVideoTranslationJob'
          : isDashscopeVideoRetalkPrimaryModel
            ? DASHSCOPE_VIDEORETALK_ENDPOINT
          : isRunningHubModel
            ? resolveRunningHubEndpointRoot(aiModelForm.endpoint_path, aiModelForm.upstream_model)
            : aiModelForm.endpoint_path.trim() || CAPABILITY_DEFAULT_ENDPOINT.get(aiModelForm.capability) || '/chat/completions',
        api_type: isAudioProviderModel
          ? isMinimaxVoiceCloneModel ? resolveAudioVoiceCloneApiType(primarySource?.provider_type) : resolveAudioSpeechApiType(primarySource?.provider_type)
          : isAliyunIceVideoTranslationModel
            ? ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE
          : isDashscopeVideoRetalkPrimaryModel
            ? DASHSCOPE_VIDEORETALK_API_TYPE
          : isRunningHubModel
            ? RUNNINGHUB_TASK_API_TYPE
            : aiModelForm.api_type.trim() || 'openai-chat-completions',
        request_overrides: requestOverrides,
        is_default: isMinimaxVoiceCloneModel ? false : aiModelForm.is_default,
        is_active: aiModelForm.is_active,
        is_visible: aiModelForm.is_visible,
      };

      if (aiModelForm.editing_id) {
        await platformApi.updateGlobalAiModel(aiModelForm.editing_id, payload);
        setMessage({ type: 'success', text: 'AI 模型已更新' });
      } else {
        await platformApi.createGlobalAiModel(payload);
        setMessage({ type: 'success', text: 'AI 模型已创建' });
      }

      setModelModalOpen(false);
      resetAiModelForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存 AI 模型失败') });
    } finally {
      setAiModelSaving(false);
    }
  };

  const toggleAiModelActive = async (item: PlatformAiModelItem) => {
    setMessage(null);
    try {
      await platformApi.updateGlobalAiModel(item.id, { is_active: !item.is_active });
      setMessage({ type: 'success', text: 'AI 模型状态已更新' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新 AI 模型状态失败') });
    }
  };

  const toggleAiModelVisibility = async (item: PlatformAiModelItem) => {
    setMessage(null);
    try {
      await platformApi.updateGlobalAiModel(item.id, { is_visible: !item.is_visible });
      setMessage({ type: 'success', text: `模型已${item.is_visible ? '隐藏' : '显示'}` });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新模型可见性失败') });
    }
  };

  const setAsDefaultModel = async (item: PlatformAiModelItem) => {
    if (isVoiceCloneConfig(item.api_type, item.endpoint_path)) {
      setMessage({ type: 'error', text: '声音复刻不能设为默认语音合成模型' });
      return;
    }
    setMessage(null);
    try {
      await platformApi.updateGlobalAiModel(item.id, { is_default: true });
      setMessage({ type: 'success', text: `默认模型已切换为 ${item.model_key}` });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '设置默认模型失败') });
    }
  };

  const removeAiModel = async (item: PlatformAiModelItem) => {
    if (!window.confirm(`确认删除 AI 模型 ${item.model_key} 吗？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalAiModel(item.id);
      setMessage({ type: 'success', text: 'AI 模型已删除' });
      if (aiModelForm.editing_id === item.id) {
        resetAiModelForm();
      }
      setAiModels((prev) => prev.filter((model) => model.id !== item.id));
      setDeletedAiModels((prev) => {
        if (prev.some((deleted) => deleted.id === item.id)) {
          return prev;
        }
        return [item, ...prev];
      });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除 AI 模型失败') });
    }
  };

  const getModelCardStatusClass = (item: PlatformAiModelItem, isDeleted = false) => {
    if (isDeleted) {
      return 'model-state-deleted';
    }
    if (!item.is_visible) {
      return 'model-state-hidden';
    }
    if (!item.is_active) {
      return 'model-state-disabled';
    }
    return '';
  };

  const toggleModelGroup = (groupKey: AiModelStatusGroupKey) => {
    setCollapsedModelGroups((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  };

  const renderModelCard = (item: PlatformAiModelItem, isDeleted = false) => {
    const itemSource = aiSourceMap.get(item.default_source_id);
    const itemIsVoiceClone = isVoiceCloneConfig(item.api_type, item.endpoint_path);
    const itemSupportsDualTtsTest = item.capability === 'tts'
      && isMinimaxProviderType(itemSource?.provider_type)
      && !itemIsVoiceClone;
    return (
      <article key={item.id} className={`ai-hub-item-card ${getModelCardStatusClass(item, isDeleted)}`}>
        <div className="ai-hub-item-head">
          <div>
            <h4>{item.model_key}</h4>
            <p>{item.display_name || item.model_key}</p>
          </div>
          <div className="ai-hub-item-status">
            {isDeleted ? (
              <span className="status-tag error">DELETED</span>
            ) : (
              <>
                {item.is_default && <span className="status-tag info">DEFAULT</span>}
                <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                  {item.is_active ? 'ACTIVE' : 'INACTIVE'}
                </span>
                {!item.is_visible && <span className="status-tag warning">HIDDEN</span>}
              </>
            )}
          </div>
        </div>
        <div className="ai-hub-item-meta">
          <div>
            <span>能力</span>
            <strong>{itemIsVoiceClone ? '声音复刻' : item.capability}</strong>
          </div>
          {!isDeleted && (
            <div>
              <span>成本 / 积分售价</span>
              <strong>{formatModelPrice(item)}</strong>
              <div className="ai-hub-usage-subline">{formatModelSellPrice(item)}</div>
            </div>
          )}
          <div>
            <span>{isDeleted ? '默认源' : '优先来源'}</span>
            <strong>{item.default_source_name}</strong>
            {!isDeleted && Array.isArray(item.source_routes) && item.source_routes.length > 1 && (
              <div className="ai-hub-usage-subline">备用 {item.source_routes.length - 1} 个</div>
            )}
          </div>
          <div>
            <span>上游模型</span>
            <strong>{item.upstream_model}</strong>
          </div>
          {isDeleted && (
            <>
              <div>
                <span>状态</span>
                <strong>{item.is_visible ? (item.is_active ? 'ACTIVE' : 'INACTIVE') : 'HIDDEN'}</strong>
              </div>
              <div>
                <span>更新时间</span>
                <strong>{formatDateTime(item.updated_at)}</strong>
              </div>
            </>
          )}
        </div>
        {!isDeleted && (
          <div className="ai-hub-item-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => navigate(`/platform-admin/ai/playground?model_id=${encodeURIComponent(item.id)}`)}
            >
              打开 Playground
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => openEditAiModelModal(item)}
            >
              编辑
            </button>
            {!item.is_default && !itemIsVoiceClone && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => setAsDefaultModel(item)}
              >
                设默认
              </button>
            )}
            {itemIsVoiceClone ? null : itemSupportsDualTtsTest ? (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => runAiModelConnectivityTest(item, 'sync')}
                  disabled={aiModelTesting}
                >
                  测试同步
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => runAiModelConnectivityTest(item, 'async')}
                  disabled={aiModelTesting}
                >
                  测试异步
                </button>
              </>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => runAiModelConnectivityTest(item)}
                disabled={aiModelTesting}
              >
                测试
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={async () => toggleAiModelActive(item)}
            >
              {item.is_active ? '禁用' : '启用'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={async () => toggleAiModelVisibility(item)}
            >
              {item.is_visible ? '隐藏' : '显示'}
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => removeAiModel(item)}
            >
              删除
            </button>
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="platform-page ai-hub-page">
      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <div className="platform-stats-grid compact">
        <div className="platform-stat-card">
          <span>AI 源总数</span>
          <strong>{sourceStats.total}</strong>
        </div>
        <div className="platform-stat-card">
          <span>启用源</span>
          <strong>{sourceStats.active}</strong>
        </div>
        <div className="platform-stat-card">
          <span>模型总数</span>
          <strong>{modelStats.total}</strong>
        </div>
        <div className="platform-stat-card">
          <span>默认模型</span>
          <strong>{modelStats.defaultModel}</strong>
        </div>
      </div>

      {!hideTopTabSwitcher && !fixedTab && (
        <section className="card" style={{ paddingBottom: 10 }}>
          <div className="ai-hub-tabs" role="tablist" aria-label="AI 配置分区">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'sources'}
              className={`ai-hub-tab ${activeTab === 'sources' ? 'active' : ''}`}
              onClick={() => setActiveTab('sources')}
            >
              供应商
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'models'}
              className={`ai-hub-tab ${activeTab === 'models' ? 'active' : ''}`}
              onClick={() => setActiveTab('models')}
            >
              模型
            </button>
          </div>
        </section>
      )}

      {activeTab === 'sources' && (
        <section className="card ai-hub-list-page">
          <div className="platform-section-head">
            <h3>供应商列表</h3>
            <button className="btn btn-secondary btn-sm" onClick={openCreateAiSourceModal}>
              + 新建供应商
            </button>
          </div>

          {gatewayRuntime && (
            <div className="ai-gateway-runtime-grid">
              <div>
                <span>队列</span>
                <strong>
                  {gatewayRuntime.usage_queue?.queue_length ?? 0}
                  {' / '}
                  {gatewayRuntime.usage_queue?.max_queue_size ?? 0}
                </strong>
              </div>
              <div>
                <span>活跃请求</span>
                <strong>{(gatewayRuntime.throttle?.active || []).reduce((sum, item) => sum + Number(item.active || 0), 0)}</strong>
              </div>
              <div>
                <span>冷却源</span>
                <strong>{gatewayRuntime.throttle?.cooldowns?.length || 0}</strong>
              </div>
              <div>
                <span>会话保持</span>
                <strong>{gatewayRuntime.scheduler?.active_sticky_sessions || 0}</strong>
              </div>
            </div>
          )}

          <div className="ai-hub-filter-row">
            <input
              className="platform-filter-input"
              value={sourceQuery}
              onChange={(event) => setSourceQuery(event.target.value)}
              placeholder="搜索名称 / Provider / URL"
            />
            <select
              value={sourceProviderFilter}
              onChange={(event) => setSourceProviderFilter(event.target.value)}
            >
              <option value="ALL">全部 Provider</option>
              {AI_PROVIDER_PRESETS.map((item) => (
                <option key={item.provider_type} value={item.provider_type}>
                  {item.label}
                </option>
              ))}
            </select>
            <div className="platform-filter-hint">共 {filteredSources.length} 个</div>
          </div>

          {aiSourceTestResult && (
            <div className={`ai-hub-test-result ${aiSourceTestResult.ok ? 'success' : 'error'}`}>
              <strong>{aiSourceTestResult.ok ? '连通性测试通过' : '连通性测试失败'}</strong>
              <div>消息：{aiSourceTestResult.message}</div>
              <div>HTTP 状态：{aiSourceTestResult.status_code ?? '无响应'}</div>
              <div>耗时：{aiSourceTestResult.latency_ms} ms</div>
              <div>
                测试地址：<code>{aiSourceTestResult.endpoint_url}</code>
              </div>
              {aiSourceTestResult.response_excerpt && (
                <details>
                  <summary>响应片段</summary>
                  <pre>{aiSourceTestResult.response_excerpt}</pre>
                </details>
              )}
            </div>
          )}

          <div className="ai-hub-list-scroll">
            {filteredSources.map((item) => (
              <article key={item.id} className="ai-hub-item-card">
                <div className="ai-hub-item-head">
                  <div>
                    <h4>{item.name}</h4>
                    <p>{PROVIDER_PRESET_MAP.get(item.provider_type)?.label || item.provider_type}</p>
                  </div>
                  <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                    {item.is_active ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
                <div className="ai-hub-item-meta">
                  <div>
                    <span>Base URL</span>
                    <strong>{item.base_url}</strong>
                  </div>
                  <div>
                    <span>API Key</span>
                    <strong>
                      {item.active_api_key_count ?? (item.has_api_key ? 1 : 0)}
                      {' / '}
                      {item.api_key_count ?? (item.has_api_key ? 1 : 0)}
                    </strong>
                    <div className="ai-hub-usage-subline">{item.api_key_masked || '-'}</div>
                  </div>
                  <div>
                    <span>代理</span>
                    <strong>
                      {item.outbound_proxy?.name || '不使用代理'}
                      {item.outbound_proxy?.latency_ms ? ` · ${item.outbound_proxy.latency_ms} ms` : ''}
                    </strong>
                    <div className="ai-hub-usage-subline">{item.outbound_proxy?.status || '-'}</div>
                  </div>
                  <div>
                    <span>更新时间</span>
                    <strong>{formatDateTime(item.updated_at)}</strong>
                  </div>
                </div>
                <div className="ai-hub-item-actions">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => openEditAiSourceModal(item)}
                  >
                    编辑
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={async () => runAiSourceConnectivityTest(item)}
                    disabled={aiSourceTesting}
                  >
                    测试
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={async () => toggleAiSourceActive(item)}
                  >
                    {item.is_active ? '禁用' : '启用'}
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => removeAiSource(item)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}

            {!filteredSources.length && <div className="ai-hub-empty">没有匹配的供应商</div>}
          </div>
        </section>
      )}

      {activeTab === 'models' && (
        <section className="card ai-hub-list-page">
          <div className="platform-section-head">
            <h3>模型列表</h3>
            <div className="button-row compact">
              <button className="btn btn-secondary btn-sm" onClick={openCreateAliyunIceVideoTranslationModelModal}>
                + 视频翻译
              </button>
              <button className="btn btn-secondary btn-sm" onClick={openCreateDashscopeVideoRetalkModelModal}>
                + VideoRetalk
              </button>
              <button className="btn btn-secondary btn-sm" onClick={openCreateVoiceCloneModelModal}>
                + 声音复刻
              </button>
              <button className="btn btn-secondary btn-sm" onClick={openCreateAiModelModal}>
                + 新建模型
              </button>
            </div>
          </div>

          {!hideUsageSection && (
            <AiUsageInsightsPanel
              title="平台 AI 调用统计"
              description="在模型配置页直接看调用量、积分消耗、RMB 成本、来源分布和最近日志。"
              summary={usageSummary}
              breakdown={usageBreakdown}
              logs={usageLogs}
              loading={usageLoading}
              breakdownLoading={usageBreakdownLoading}
              rangePreset={usageRangePreset}
              onRangePresetChange={handleUsageRangePresetChange}
              customFrom={usageCustomFrom}
              customTo={usageCustomTo}
              onCustomFromChange={setUsageCustomFrom}
              onCustomToChange={setUsageCustomTo}
              capabilityFilter={usageCapabilityFilter}
              onCapabilityFilterChange={setUsageCapabilityFilter}
              modelIdFilter={usageModelIdFilter}
              onModelIdFilterChange={setUsageModelIdFilter}
              sourceIdFilter={usageSourceIdFilter}
              onSourceIdFilterChange={setUsageSourceIdFilter}
              successFilter={usageSuccessFilter}
              onSuccessFilterChange={setUsageSuccessFilter}
              modelOptions={usageModelOptions}
              sourceOptions={usageSourceOptions}
              onRefresh={loadData}
              showAppColumn
              showSourceColumn
            />
          )}

          <div className="ai-hub-model-toolbar">
            <div className="ai-hub-tabs ai-hub-model-capability-tabs" role="tablist" aria-label="模型能力分组">
              <button
                type="button"
                role="tab"
                aria-selected={modelCapabilityFilter === 'ALL'}
                className={`ai-hub-tab ${modelCapabilityFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setModelCapabilityFilter('ALL')}
              >
                全部能力
              </button>
              {AI_CAPABILITY_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={modelCapabilityFilter === item.value}
                  className={`ai-hub-tab ${modelCapabilityFilter === item.value ? 'active' : ''}`}
                  onClick={() => setModelCapabilityFilter(item.value)}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={modelCapabilityFilter === 'voice_clone'}
                className={`ai-hub-tab ${modelCapabilityFilter === 'voice_clone' ? 'active' : ''}`}
                onClick={() => setModelCapabilityFilter('voice_clone')}
              >
                声音复刻
              </button>
            </div>

            <div className="ai-hub-filter-row ai-hub-model-filter-row">
              <input
                className="platform-filter-input"
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder="搜索模型标识 / 显示名 / 上游模型"
              />
              <select
                value={modelStatusFilter}
                onChange={(event) => setModelStatusFilter(event.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}
              >
                <option value="ALL">全部状态</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
              </select>
              <button
                className="btn btn-secondary btn-sm"
                onClick={runAiImageModelBatchTest}
                disabled={aiImageModelBatchTesting}
              >
                {aiImageModelBatchTesting ? '生图批量实测中...' : '批量实测生图模型'}
              </button>
              <div className="platform-filter-hint">共 {filteredModels.length} 个</div>
            </div>
          </div>

          {aiModelTestResult && (
            <div className={`ai-hub-test-result ${aiModelTestResult.ok ? 'success' : 'error'}`}>
              <strong>{aiModelTestResult.ok ? '模型测试通过' : '模型测试失败'}</strong>
              <div>模型：{aiModelTestResult.model_key}</div>
              <div>供应商：{aiModelTestResult.source_name}</div>
              <div>消息：{aiModelTestResult.message}</div>
              <div>HTTP 状态：{aiModelTestResult.status_code ?? '无响应'}</div>
              <div>耗时：{aiModelTestResult.latency_ms} ms</div>
              <div>测试模式：{aiModelTestMode === 'sync' ? '同步' : aiModelTestMode === 'async' ? '异步' : '默认'}</div>
              {typeof aiModelTestResult.audio_detected === 'boolean' ? (
                <div>音频有效性：{aiModelTestResult.audio_detected ? '已检测到可播放音频' : '未检测到可播放音频'}</div>
              ) : null}
              {aiModelTestResult.async_task_id ? <div>异步任务ID：{aiModelTestResult.async_task_id}</div> : null}
              <div>
                测试地址：<code>{aiModelTestResult.endpoint_url}</code>
              </div>
              {aiModelTestResult.response_excerpt && (
                <details>
                  <summary>响应片段</summary>
                  <pre>{aiModelTestResult.response_excerpt}</pre>
                </details>
              )}
            </div>
          )}

          {aiImageModelBatchResult && (
            <div className={`ai-hub-test-result ${aiImageModelBatchResult.failed > 0 ? 'error' : 'success'}`}>
              <strong>
                生图模型批量实测{aiImageModelBatchResult.failed > 0 ? '有失败' : '全部通过'}
              </strong>
              <div>能力：{aiImageModelBatchResult.capability}</div>
              <div>结果：成功 {aiImageModelBatchResult.success} / 失败 {aiImageModelBatchResult.failed}</div>
              <div>总数：{aiImageModelBatchResult.total}</div>
              <div>开始：{formatDateTime(aiImageModelBatchResult.started_at)}</div>
              <div>结束：{formatDateTime(aiImageModelBatchResult.finished_at)}</div>
            </div>
          )}

          {aiImageModelBatchResult && aiImageModelBatchResult.items.length > 0 && (
            <div className="platform-api-table-wrap">
              <table className="platform-api-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>供应商</th>
                    <th>状态</th>
                    <th>HTTP</th>
                    <th>耗时</th>
                    <th>消息</th>
                  </tr>
                </thead>
                <tbody>
                  {aiImageModelBatchResult.items.map((item) => (
                    <tr key={item.model_id}>
                      <td>{item.model_key}</td>
                      <td>{item.source_name || item.provider_type}</td>
                      <td>
                        <span className={`status-tag ${item.ok ? 'success' : 'error'}`}>
                          {item.ok ? 'PASS' : 'FAIL'}
                        </span>
                      </td>
                      <td>{item.status_code ?? '无响应'}</td>
                      <td>{item.latency_ms} ms</td>
                      <td>
                        <div>{item.message}</div>
                        <div className="ai-hub-usage-subline"><code>{item.endpoint_url}</code></div>
                        {item.response_excerpt ? (
                          <details>
                            <summary>响应片段</summary>
                            <pre>{item.response_excerpt}</pre>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="ai-hub-list-scroll ai-hub-model-groups">
            {modelGroups.map((group) => {
              const collapsed = collapsedModelGroups[group.key];
              return (
                <section key={group.key} className={`ai-hub-model-group ai-hub-model-group-${group.key}`}>
                  <button
                    type="button"
                    className="ai-hub-model-group-head"
                    onClick={() => toggleModelGroup(group.key)}
                    aria-expanded={!collapsed}
                  >
                    <span className="ai-hub-model-group-title">{group.label}</span>
                    <span className="ai-hub-model-group-count">共 {group.items.length} 个</span>
                    <span className="ai-hub-model-group-action">{collapsed ? '展开' : '收起'}</span>
                  </button>
                  {!collapsed && (
                    <div className="ai-hub-model-list">
                      {group.items.map((item) => renderModelCard(item, group.isDeleted))}
                    </div>
                  )}
                </section>
              );
            })}

            {!modelGroups.length && <div className="ai-hub-empty">没有匹配的模型</div>}
          </div>
        </section>
      )}

      {sourceModalOpen && (
        <div className="modal-overlay" onClick={closeAiSourceModal}>
          <div className="modal modal-lg" onClick={(event) => event.stopPropagation()}>
            <div className="card-header">
              <h3>{aiSourceForm.editing_id ? '编辑供应商' : '创建供应商'}</h3>
              <button className="btn btn-secondary btn-sm" onClick={closeAiSourceModal}>
                关闭
              </button>
            </div>

            <form onSubmit={saveAiSource} className="platform-form-grid">
              <div className="form-group">
                <label>名称</label>
                <input
                  value={aiSourceForm.name}
                  onChange={(event) => setAiSourceForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="例如：OpenAI 主线路"
                  required
                />
              </div>
              <div className="form-group">
                <label>Provider 类型</label>
                <select
                  value={aiSourceForm.provider_type}
                  onChange={(event) => handleProviderTypeChange(event.target.value)}
                  required
                >
                  {AI_PROVIDER_PRESETS.map((item) => (
                    <option key={item.provider_type} value={item.provider_type}>
                      {item.label}
                    </option>
                  ))}
                  {!PROVIDER_PRESET_MAP.has(aiSourceForm.provider_type) && (
                    <option value={aiSourceForm.provider_type}>当前值（{aiSourceForm.provider_type}）</option>
                  )}
                </select>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {selectedSourcePreset?.description || '兼容 OpenAI 的通用转发源'}
                </div>
              </div>
              <div className="form-group platform-form-span-2">
                <label>Base URL</label>
                <input
                  value={aiSourceForm.base_url}
                  onChange={(event) => setAiSourceForm((prev) => ({ ...prev, base_url: event.target.value }))}
                  placeholder={isSourceFormRunningHub ? RUNNINGHUB_BASE_URL : 'https://api.openai.com/v1'}
                  readOnly={isSourceFormRunningHub}
                  required
                />
                {isSourceFormRunningHub ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    固定地址：<code>{RUNNINGHUB_BASE_URL}</code>
                  </div>
                ) : selectedSourcePreset?.base_url && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    推荐默认值：<code>{selectedSourcePreset.base_url}</code>
                  </div>
                )}
              </div>
              <div className="form-group">
                <label>代理</label>
                <select
                  value={aiSourceForm.outbound_proxy_id}
                  onChange={(event) => setAiSourceForm((prev) => ({ ...prev, outbound_proxy_id: event.target.value }))}
                >
                  <option value="">不使用代理</option>
                  {outboundProxies.map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      {proxy.name} · {proxy.status}
                    </option>
                  ))}
                </select>
              </div>
              {isSourceFormVertexAi && (
                <>
                  <div className="form-group">
                    <label>鉴权方式</label>
                    <select
                      value={aiSourceForm.credentials.auth_mode}
                      onChange={(event) => setAiSourceForm((prev) => ({
                        ...prev,
                        credentials: {
                          ...prev.credentials,
                          auth_mode: event.target.value === 'adc'
                            ? 'adc'
                            : event.target.value === 'service_account_json'
                              ? 'service_account_json'
                              : 'api_key',
                        },
                      }))}
                    >
                      <option value="api_key">API Key</option>
                      <option value="service_account_json">Service Account JSON</option>
                      <option value="adc">ADC</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Project ID</label>
                    <input
                      value={aiSourceForm.credentials.project_id}
                      onChange={(event) => setAiSourceForm((prev) => ({
                        ...prev,
                        credentials: { ...prev.credentials, project_id: event.target.value },
                      }))}
                      placeholder="my-gcp-project"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Location</label>
                    <input
                      value={aiSourceForm.credentials.location}
                      onChange={(event) => setAiSourceForm((prev) => ({
                        ...prev,
                        credentials: { ...prev.credentials, location: event.target.value },
                      }))}
                      placeholder="global"
                      required
                    />
                  </div>
                  {aiSourceForm.credentials.auth_mode === 'service_account_json' && (
                    <div className="form-group platform-form-span-2">
                      <label>Service Account JSON</label>
                      <textarea
                        value={aiSourceForm.credentials.service_account_json}
                        onChange={(event) => setAiSourceForm((prev) => ({
                          ...prev,
                          credentials: { ...prev.credentials, service_account_json: event.target.value },
                        }))}
                        rows={6}
                        placeholder={aiSourceForm.credentials.has_service_account_json ? '留空保持不变' : '{ "type": "service_account" }'}
                        required={!aiSourceForm.editing_id && !aiSourceForm.credentials.has_service_account_json}
                      />
                      {aiSourceForm.credentials.service_account_email && (
                        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                          {aiSourceForm.credentials.service_account_email}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              {(!isSourceFormVertexAi || aiSourceForm.credentials.auth_mode === 'api_key') && (
                <div className="form-group platform-form-span-2">
                  <div className="ai-source-key-head">
                    <label>API Keys</label>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={addAiSourceApiKey}>
                      添加 Key
                    </button>
                  </div>
                  <div className="ai-source-key-list">
                    {aiSourceForm.api_keys.map((item, index) => (
                      <div key={item.id || index} className="ai-source-key-row">
                        <input
                          value={item.label}
                          onChange={(event) => updateAiSourceApiKey(index, { label: event.target.value })}
                          placeholder={`Key ${index + 1}`}
                        />
                        <input
                          type="password"
                          value={item.api_key}
                          onChange={(event) => updateAiSourceApiKey(index, { api_key: event.target.value })}
                          placeholder={item.api_key_masked || (aiSourceForm.editing_id ? '留空保持不变' : 'sk-...')}
                        />
                        <label className="checkbox-label ai-source-key-enabled">
                          <input
                            type="checkbox"
                            checked={item.is_active}
                            onChange={(event) => updateAiSourceApiKey(index, { is_active: event.target.checked })}
                          />
                          启用
                        </label>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => removeAiSourceApiKey(index)}
                          disabled={aiSourceForm.api_keys.length <= 1}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="form-group">
                <label>测试端点路径</label>
                <input
                  value={aiSourceForm.test_path}
                  onChange={(event) => setAiSourceForm((prev) => ({ ...prev, test_path: event.target.value }))}
                  placeholder={resolveDefaultSourceTestPath(aiSourceForm.provider_type)}
                  readOnly={isSourceFormRunningHub}
                />
                {isSourceFormRunningHub && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    RunningHub 源测试固定走上传接口：<code>{RUNNINGHUB_SOURCE_TEST_PATH}</code>
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={aiSourceForm.is_active}
                    onChange={(event) => setAiSourceForm((prev) => ({ ...prev, is_active: event.target.checked }))}
                  />
                  启用
                </label>
              </div>
              <div className="form-group platform-form-span-2">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={showAdvancedHeaders}
                    onChange={(event) => setShowAdvancedHeaders(event.target.checked)}
                  />
                  显示高级配置（自定义请求头）
                </label>
                {showAdvancedHeaders && (
                  <>
                    <textarea
                      value={aiSourceForm.custom_headers_json}
                      onChange={(event) =>
                        setAiSourceForm((prev) => ({ ...prev, custom_headers_json: event.target.value }))
                      }
                      rows={4}
                      style={{ marginTop: 8 }}
                    />
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                      仅在上游要求额外请求头时使用，例如 OpenRouter 的 <code>HTTP-Referer</code>、<code>X-Title</code>。
                    </div>
                  </>
                )}
              </div>

              <div className="platform-form-actions platform-form-span-2">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => runAiSourceConnectivityTest()}
                  disabled={aiSourceTesting}
                >
                  {aiSourceTesting ? '测试中...' : '测试连通性'}
                </button>
                <button className="btn" type="submit" disabled={aiSourceSaving}>
                  {aiSourceSaving ? '保存中...' : aiSourceForm.editing_id ? '更新供应商' : '创建供应商'}
                </button>
              </div>
            </form>

            {aiSourceTestResult && (
              <div className={`ai-hub-test-result ${aiSourceTestResult.ok ? 'success' : 'error'}`}>
                <strong>{aiSourceTestResult.ok ? '连通性测试通过' : '连通性测试失败'}</strong>
                <div>消息：{aiSourceTestResult.message}</div>
                <div>HTTP 状态：{aiSourceTestResult.status_code ?? '无响应'}</div>
                <div>耗时：{aiSourceTestResult.latency_ms} ms</div>
                <div>
                  测试地址：<code>{aiSourceTestResult.endpoint_url}</code>
                </div>
                {aiSourceTestResult.response_excerpt && (
                  <details>
                    <summary>响应片段</summary>
                    <pre>{aiSourceTestResult.response_excerpt}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {modelModalOpen && (
        <div className="modal-overlay" onClick={closeAiModelModal}>
          <div className="modal modal-lg" onClick={(event) => event.stopPropagation()}>
            <div className="card-header">
              <h3>{aiModelForm.editing_id ? '编辑模型' : '创建模型'}</h3>
              <button className="btn btn-secondary btn-sm" onClick={closeAiModelModal}>
                关闭
              </button>
            </div>

            <form onSubmit={saveAiModel} className="platform-form-grid">
              <div className="form-group">
                <label>模型标识</label>
                <input
                  value={aiModelForm.model_key}
                  onChange={(event) => setAiModelForm((prev) => ({ ...prev, model_key: event.target.value }))}
                  placeholder="gpt-4o-mini"
                  required
                />
              </div>
              <div className="form-group">
                <label>显示名</label>
                <input
                  value={aiModelForm.display_name}
                  onChange={(event) => setAiModelForm((prev) => ({ ...prev, display_name: event.target.value }))}
                  placeholder="可选，默认同模型标识"
                />
              </div>
              <div className="form-group">
                <label>能力类型</label>
                <select
                  value={aiModelForm.capability}
                  onChange={(event) => handleModelCapabilityChange(event.target.value as AiModelForm['capability'])}
                >
                  {AI_CAPABILITY_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              {isModelFormMinimaxTts ? (
                <>
                  <div className="form-group">
                    <label>音频用途</label>
                    <select
                      value={isModelFormVoiceCloneCapable ? aiModelForm.minimax_audio_mode : 'speech'}
                      onChange={(event) => applyMinimaxAudioTemplate(event.target.value as AudioModelKind)}
                    >
                      <option value="speech">语音合成</option>
                      {isModelFormVoiceCloneCapable && <option value="voice_clone">声音复刻</option>}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>执行模式</label>
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {isModelFormMinimaxVoiceClone ? '同步' : '同步 / 异步'}
                    </div>
                  </div>
                  {isModelFormMinimaxVoiceClone && isDashscopeCosyVoiceProviderType(selectedModelSource?.provider_type) && (
                    <div className="form-group">
                      <label>目标语音模型</label>
                      <select
                        value={aiModelForm.target_tts_model_key}
                        onChange={(event) => setAiModelForm((prev) => ({ ...prev, target_tts_model_key: event.target.value }))}
                        required
                      >
                        <option value="">请选择模型</option>
                        {targetTtsModelOptions.map((item) => (
                          <option key={item.id} value={item.model_key}>
                            {item.display_name || item.model_key}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              ) : (
                <div className="form-group">
                  <label>执行模式</label>
                  <select
                    value={aiModelForm.execution_mode}
                    onChange={(event) =>
                      setAiModelForm((prev) => ({
                        ...prev,
                        execution_mode: event.target.value as AiModelForm['execution_mode'],
                      }))
                    }
                  >
                    <option value="sync">同步 Sync</option>
                    <option value="async">异步 Async</option>
                  </select>
                </div>
              )}
              <div className="form-group">
                <label>计费规则</label>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {aiModelForm.pricing_mode === 'per_call'
                    ? aiModelForm.capability === 'video'
                      ? '视频按分辨率和秒数计费；未设置分辨率单价时才使用按次价格。'
                      : '图片模型固定按张计费。'
                    : aiModelForm.pricing_mode === 'per_mchar'
                      ? '语音合成按输入文本字符数扣费。'
                    : aiModelForm.pricing_mode === 'per_minute'
                      ? '语音转录与语音生成固定按分钟计费。'
                      : aiModelForm.capability === 'embedding'
                        ? '嵌入模型按 token 计费。'
                        : '文字模型按输出 token 计费。'}
                </div>
              </div>
              <div className="form-group">
                <label>
                  {aiModelForm.pricing_mode === 'per_call'
                    ? aiModelForm.capability === 'video'
                      ? '备用成本（人民币 / 次）'
                      : aiModelForm.capability === 'tts'
                        ? '成本单价（人民币 / 次）'
                        : '成本单价（人民币 / 张）'
                    : aiModelForm.pricing_mode === 'per_minute'
                      ? '成本单价（人民币 / 分钟）'
                      : aiModelForm.pricing_mode === 'per_mchar'
                        ? '成本单价（人民币 / 1M 字符）'
                      : aiModelForm.capability === 'embedding'
                        ? '成本单价（人民币 / 1M token）'
                        : '成本单价（人民币 / 1M 输出 token）'}
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.0001"
                  value={
                    aiModelForm.pricing_mode === 'per_call'
                      ? aiModelForm.rmb_per_call
                      : aiModelForm.pricing_mode === 'per_minute'
                        ? aiModelForm.rmb_per_minute
                        : aiModelForm.rmb_per_mtoken
                  }
                  onChange={(event) =>
                    setAiModelForm((prev) => (
                      prev.pricing_mode === 'per_call'
                        ? { ...prev, rmb_per_call: event.target.value }
                        : prev.pricing_mode === 'per_minute'
                          ? { ...prev, rmb_per_minute: event.target.value }
                          : { ...prev, rmb_per_mtoken: event.target.value }
                    ))
                  }
                  placeholder={
                    aiModelForm.pricing_mode === 'per_call'
                      ? '例如 0.0500'
                      : aiModelForm.pricing_mode === 'per_minute'
                        ? '例如 0.3000'
                        : aiModelForm.pricing_mode === 'per_mchar'
                          ? '例如 100'
                        : '例如 2.5000'
                  }
                />
              </div>
              {aiModelForm.capability !== 'image' && (
                <div className="form-group">
                  <label>
                    {aiModelForm.pricing_mode === 'per_call'
                      ? aiModelForm.capability === 'video'
                        ? '备用售价（积分 / 次）'
                        : aiModelForm.capability === 'tts'
                          ? '扣费（积分 / 次）'
                          : '扣费（积分 / 张）'
                      : aiModelForm.pricing_mode === 'per_minute'
                        ? '扣费（积分 / 分钟）'
                        : aiModelForm.pricing_mode === 'per_mchar'
                          ? '扣费（积分 / 100 字符）'
                        : aiModelForm.capability === 'embedding'
                          ? '扣费（积分 / 1M token）'
                          : '扣费（积分 / 1M 输出 token）'}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.0001"
                    value={
                      aiModelForm.pricing_mode === 'per_call'
                        ? aiModelForm.points_per_call
                        : aiModelForm.pricing_mode === 'per_minute'
                          ? aiModelForm.points_per_minute
                          : aiModelForm.pricing_mode === 'per_mchar'
                            ? aiModelForm.points_per_call
                          : aiModelForm.points_per_mtoken
                    }
                    onChange={(event) =>
                      setAiModelForm((prev) => (
                        prev.pricing_mode === 'per_call'
                          ? { ...prev, points_per_call: event.target.value }
                          : prev.pricing_mode === 'per_minute'
                            ? { ...prev, points_per_minute: event.target.value }
                            : prev.pricing_mode === 'per_mchar'
                              ? { ...prev, points_per_call: event.target.value }
                            : { ...prev, points_per_mtoken: event.target.value }
                      ))
                    }
                    placeholder={
                      aiModelForm.pricing_mode === 'per_call'
                        ? '例如 25'
                        : aiModelForm.pricing_mode === 'per_minute'
                          ? '例如 120'
                          : aiModelForm.pricing_mode === 'per_mchar'
                            ? '例如 0.5'
                          : '例如 400'
                    }
                  />
                </div>
              )}
              {aiModelForm.capability === 'image' && (
                <div className="form-group span-2">
                  <label>图片成本与积分售价</label>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>quality</th>
                          <th>resolution</th>
                          <th>成本（人民币 / 次）</th>
                          <th>积分售价（积分 / 张）</th>
                          <th>首选来源</th>
                        </tr>
                      </thead>
                      <tbody>
                        {IMAGE_QUALITY_OPTIONS.flatMap((quality) =>
                          IMAGE_RESOLUTION_OPTIONS.map((resolution) => {
                            const rate = aiModelForm.image_quality_resolution_rates[quality.key]?.[resolution.key] || {
                              cost_rmb_per_call: '0',
                              points_per_call: '0',
                              preferred_route_key: '',
                            };
                            const updateRate = (patch: Partial<ImageQualityResolutionRateForm>) => {
                              setAiModelForm((prev) => ({
                                ...prev,
                                image_quality_resolution_rates: {
                                  ...prev.image_quality_resolution_rates,
                                  [quality.key]: {
                                    ...(prev.image_quality_resolution_rates[quality.key] || {}),
                                    [resolution.key]: {
                                      ...(prev.image_quality_resolution_rates[quality.key]?.[resolution.key] || {
                                        cost_rmb_per_call: '0',
                                        points_per_call: '0',
                                        preferred_route_key: '',
                                      }),
                                      ...patch,
                                    },
                                  },
                                },
                              }));
                            };
                            return (
                              <tr key={`${quality.key}-${resolution.key}`}>
                                <td>{quality.label}</td>
                                <td>{resolution.label}</td>
                                <td>
                                  <input
                                    type="number"
                                    min={0}
                                    step="0.0001"
                                    value={rate.cost_rmb_per_call}
                                    onChange={(event) => updateRate({ cost_rmb_per_call: event.target.value })}
                                    placeholder="0.0000"
                                  />
                                </td>
                                <td>
                                  <input
                                    type="number"
                                    min={0}
                                    step="0.0001"
                                    value={rate.points_per_call}
                                    onChange={(event) => updateRate({ points_per_call: event.target.value })}
                                    placeholder="0"
                                  />
                                </td>
                                <td>
                                  <select
                                    value={rate.preferred_route_key}
                                    onChange={(event) => updateRate({ preferred_route_key: event.target.value })}
                                  >
                                    <option value="">默认</option>
                                    {activeModelSourceRouteOptions.map((item) => (
                                      <option key={`${quality.key}-${resolution.key}-${item.route_key}`} value={item.route_key}>
                                        {item.label}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                              </tr>
                            );
                          }),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {aiModelForm.capability === 'video' && (
                <div className="form-group span-2">
                  <label>视频成本与积分售价</label>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>分辨率</th>
                          <th>成本（人民币 / 秒）</th>
                          <th>积分售价（积分 / 秒）</th>
                          <th>首选来源</th>
                        </tr>
                      </thead>
                      <tbody>
                        {VIDEO_RESOLUTION_OPTIONS.map((option) => {
                          const rate = aiModelForm.video_resolution_rates[option.key] || {
                            cost_rmb_per_second: '0',
                            points_per_second: '0',
                            preferred_route_key: '',
                          };
                          const updateRate = (patch: Partial<VideoResolutionRateForm>) => {
                            setAiModelForm((prev) => ({
                              ...prev,
                              video_resolution_rates: {
                                ...prev.video_resolution_rates,
                                [option.key]: {
                                  ...(prev.video_resolution_rates[option.key] || {
                                    cost_rmb_per_second: '0',
                                    points_per_second: '0',
                                    preferred_route_key: '',
                                  }),
                                  ...patch,
                                },
                              },
                            }));
                          };
                          return (
                            <tr key={option.key}>
                              <td>{option.label}</td>
                              <td>
                                <input
                                  type="number"
                                  min={0}
                                  step="0.0001"
                                  value={rate.cost_rmb_per_second}
                                  onChange={(event) => updateRate({ cost_rmb_per_second: event.target.value })}
                                  placeholder="0.0000"
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  min={0}
                                  step="0.0001"
                                  value={rate.points_per_second}
                                  onChange={(event) => updateRate({ points_per_second: event.target.value })}
                                  placeholder="0"
                                />
                              </td>
                              <td>
                                <select
                                  value={rate.preferred_route_key}
                                  onChange={(event) => updateRate({ preferred_route_key: event.target.value })}
                                >
                                  <option value="">默认</option>
                                  {activeModelSourceRouteOptions.map((item) => (
                                    <option key={`${option.key}-${item.route_key}`} value={item.route_key}>
                                      {item.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="form-group span-2">
                <label>来源优先级</label>
                <select
                  value=""
                  onChange={(event) => {
                    addModelSourceRoute(event.target.value);
                    event.currentTarget.value = '';
                  }}
                >
                  <option value="">添加供应商</option>
                  {aiSources
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({PROVIDER_PRESET_MAP.get(item.provider_type)?.label || item.provider_type})
                      </option>
                    ))}
                </select>
                <div className="ai-source-route-list">
                  {aiModelForm.source_routes.length === 0 && (
                    <div className="empty-state compact">请选择至少一个供应商</div>
                  )}
                  {aiModelForm.source_routes.map((route, index) => {
                    const source = aiSourceMap.get(route.source_id);
                    const preset = PROVIDER_PRESET_MAP.get(source?.provider_type || '');
                    return (
                      <div key={route.route_key || index} className="ai-source-route-item">
                        <div className="ai-source-route-head">
                          <div>
                            <strong>{source?.name || '未选择供应商'}</strong>
                            <span>{preset?.label || source?.provider_type || '-'} · #{index + 1}</span>
                          </div>
                          <div className="button-row compact">
                            <button type="button" className="btn btn-secondary btn-xs" onClick={() => moveModelSourceRoute(index, -1)} disabled={index === 0}>上移</button>
                            <button type="button" className="btn btn-secondary btn-xs" onClick={() => moveModelSourceRoute(index, 1)} disabled={index >= aiModelForm.source_routes.length - 1}>下移</button>
                            <button type="button" className="btn btn-secondary btn-xs" onClick={() => removeModelSourceRoute(index)}>移除</button>
                          </div>
                        </div>
                        <label className="checkbox-inline">
                          <input
                            type="checkbox"
                            checked={route.is_active}
                            onChange={(event) => updateModelSourceRoute(index, { is_active: event.target.checked })}
                          />
                          启用
                        </label>
                        <div className="platform-form-grid compact">
                          <div className="form-group">
                            <label>上游模型名</label>
                            <input
                              value={route.upstream_model}
                              onChange={(event) => updateModelSourceRoute(index, { upstream_model: event.target.value })}
                              placeholder={aiModelForm.upstream_model || aiModelForm.model_key}
                            />
                          </div>
                          <div className="form-group">
                            <label>接口路径</label>
                            <input
                              value={route.endpoint_path}
                              onChange={(event) => updateModelSourceRoute(index, { endpoint_path: event.target.value })}
                              placeholder={aiModelForm.endpoint_path}
                            />
                          </div>
                          <div className="form-group">
                            <label>接口类型</label>
                            <input
                              value={route.api_type}
                              onChange={(event) => updateModelSourceRoute(index, { api_type: event.target.value })}
                              placeholder={aiModelForm.api_type}
                            />
                          </div>
                          <div className="form-group">
                            <label>覆盖参数</label>
                            <textarea
                              rows={3}
                              value={route.request_overrides_json}
                              onChange={(event) => updateModelSourceRoute(index, { request_overrides_json: event.target.value })}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {selectedModelProviderPreset && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    优先使用：{selectedModelProviderPreset.label}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label>上游模型名</label>
                <input
                  value={aiModelForm.upstream_model}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAiModelForm((prev) => ({
                      ...prev,
                      upstream_model: value,
                      endpoint_path: isModelFormRunningHub
                        ? buildRunningHubEndpointRoot(value)
                        : prev.endpoint_path,
                    }));
                  }}
                  placeholder={isModelFormRunningHub ? '例如 rhart-image-n-pro' : '默认同模型标识'}
                />
                {isModelFormRunningHub && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    填写 RunningHub 模型名即可；图片和视频会按输入自动选择对应接口。
                  </div>
                )}
              </div>

              {isModelFormMinimaxTts && (
                <div className="form-group platform-form-span-2">
                  <label>音频模板</label>
                  <div className="btn-group" style={{ flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => applyMinimaxAudioTemplate('speech')}
                    >
                      语音合成
                    </button>
                    {isModelFormVoiceCloneCapable && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => applyMinimaxAudioTemplate('voice_clone')}
                      >
                        声音复刻
                      </button>
                    )}
                  </div>
                </div>
              )}

              {isDashscopeOpenAiProviderType(selectedModelSource?.provider_type) && (
                <div className="form-group platform-form-span-2">
                  <label>DashScope 最新模型快捷填充</label>
                  <div className="btn-group" style={{ flexWrap: 'wrap' }}>
                    {DASHSCOPE_LATEST_MODEL_HINTS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => applyDashScopeModelHint(item)}
                      >
                        {item}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={applyDashscopeVideoRetalkTemplate}
                    >
                      VideoRetalk
                    </button>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label>Endpoint</label>
                <input
                  value={aiModelForm.endpoint_path}
                  onChange={(event) => setAiModelForm((prev) => ({ ...prev, endpoint_path: event.target.value }))}
                  placeholder={isModelFormRunningHub ? '/openapi/v2/rhart-image-n-pro' : '/chat/completions'}
                  readOnly={isModelFormRunningHub}
                />
                {isModelFormRunningHub ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    根据上游模型名自动生成基础路径。
                  </div>
                ) : (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    推荐：<code>{CAPABILITY_DEFAULT_ENDPOINT.get(aiModelForm.capability) || '/chat/completions'}</code>
                  </div>
                )}
              </div>
              <div className="form-group">
                <label>API 类型</label>
                <input
                  value={aiModelForm.api_type}
                  onChange={(event) => setAiModelForm((prev) => ({ ...prev, api_type: event.target.value }))}
                  placeholder={isModelFormRunningHub ? RUNNINGHUB_TASK_API_TYPE : 'openai-chat-completions'}
                  readOnly={isModelFormRunningHub}
                />
                {isModelFormRunningHub && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    RunningHub 源固定使用 <code>{RUNNINGHUB_TASK_API_TYPE}</code>
                  </div>
                )}
              </div>
              <div className="form-group platform-form-span-2">
                <label>请求覆盖参数（JSON）</label>
                <textarea
                  value={aiModelForm.request_overrides_json}
                  onChange={(event) =>
                    setAiModelForm((prev) => ({ ...prev, request_overrides_json: event.target.value }))
                  }
                  rows={4}
                />
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={isModelFormMinimaxVoiceClone ? false : aiModelForm.is_default}
                    disabled={isModelFormMinimaxVoiceClone}
                    onChange={(event) => setAiModelForm((prev) => ({ ...prev, is_default: event.target.checked }))}
                  />
                  设为默认
                </label>
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={aiModelForm.is_active}
                    onChange={(event) => setAiModelForm((prev) => ({ ...prev, is_active: event.target.checked }))}
                  />
                  启用
                </label>
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={aiModelForm.is_visible}
                    onChange={(event) => setAiModelForm((prev) => ({ ...prev, is_visible: event.target.checked }))}
                  />
                  列表可见（关闭后不在模型列表展示）
                </label>
              </div>
              {!isModelFormMinimaxVoiceClone && (
                <>
                  <div className="form-group">
                    <label>测试供应商</label>
                    <select
                      value={aiModelTestSourceId || aiModelForm.default_source_id}
                      onChange={(event) => setAiModelTestSourceId(event.target.value)}
                    >
                      <option value="">请选择供应商</option>
                      {aiSources.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({PROVIDER_PRESET_MAP.get(item.provider_type)?.label || item.provider_type})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>测试提示词</label>
                    <input
                      value={aiModelTestPrompt}
                      onChange={(event) => setAiModelTestPrompt(event.target.value)}
                      placeholder="ping"
                    />
                  </div>
                  {aiModelForm.capability === 'tts' && (
                    <>
                      <div className="form-group">
                        <label>TTS 测试音色 voice_id</label>
                        <input
                          value={aiModelTestVoiceId}
                          onChange={(event) => setAiModelTestVoiceId(event.target.value)}
                          placeholder="male-qn-qingse"
                        />
                      </div>
                      <div className="form-group">
                        <label>TTS 测试 language_boost</label>
                        <input
                          value={aiModelTestLanguageBoost}
                          onChange={(event) => setAiModelTestLanguageBoost(event.target.value)}
                          placeholder="English / Italian / Chinese"
                        />
                      </div>
                    </>
                  )}
                </>
              )}
              <div className="platform-form-actions platform-form-span-2">
                {isModelFormMinimaxVoiceClone ? null : isModelTestSourceMinimaxTts ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => runAiModelConnectivityTest(undefined, 'sync')}
                      disabled={aiModelTesting}
                    >
                      {aiModelTesting && aiModelTestMode === 'sync' ? '同步测试中...' : '测试同步'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => runAiModelConnectivityTest(undefined, 'async')}
                      disabled={aiModelTesting}
                    >
                      {aiModelTesting && aiModelTestMode === 'async' ? '异步测试中...' : '测试异步'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => runAiModelConnectivityTest()}
                    disabled={aiModelTesting}
                  >
                    {aiModelTesting ? '测试中...' : '测试模型'}
                  </button>
                )}
                <button className="btn" type="submit" disabled={aiModelSaving}>
                  {aiModelSaving ? '保存中...' : aiModelForm.editing_id ? '更新模型' : '创建模型'}
                </button>
              </div>
            </form>

            {aiModelTestResult && (
              <div className={`ai-hub-test-result ${aiModelTestResult.ok ? 'success' : 'error'}`}>
                <strong>{aiModelTestResult.ok ? '模型测试通过' : '模型测试失败'}</strong>
                <div>模型：{aiModelTestResult.model_key}</div>
                <div>供应商：{aiModelTestResult.source_name}</div>
                <div>消息：{aiModelTestResult.message}</div>
                <div>HTTP 状态：{aiModelTestResult.status_code ?? '无响应'}</div>
                <div>耗时：{aiModelTestResult.latency_ms} ms</div>
                <div>测试模式：{aiModelTestMode === 'sync' ? '同步' : aiModelTestMode === 'async' ? '异步' : '默认'}</div>
                {typeof aiModelTestResult.audio_detected === 'boolean' ? (
                  <div>音频有效性：{aiModelTestResult.audio_detected ? '已检测到可播放音频' : '未检测到可播放音频'}</div>
                ) : null}
                {aiModelTestResult.async_task_id ? <div>异步任务ID：{aiModelTestResult.async_task_id}</div> : null}
                <div>
                  测试地址：<code>{aiModelTestResult.endpoint_url}</code>
                </div>
                {aiModelTestResult.response_excerpt && (
                  <details>
                    <summary>响应片段</summary>
                    <pre>{aiModelTestResult.response_excerpt}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
