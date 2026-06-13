import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { OutboundHttpClientService } from '../outbound-proxy/outbound-http-client.service';
import {
  embed,
  generateImage,
  generateText,
  experimental_generateSpeech,
  experimental_transcribe,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Modality } from '@google/genai';
import {
  RUNNINGHUB_DEFAULT_QUERY_PATH,
  RUNNINGHUB_DEFAULT_UPLOAD_PATH,
  RUNNINGHUB_TASK_API_TYPE,
  RUNNINGHUB_VIDEO_POLL_TIMEOUT_MS,
  extractRunningHubResultUrls,
  extractRunningHubTaskErrorMessage,
  extractRunningHubTaskId,
  extractRunningHubTaskStatus,
  isRunningHubProviderType,
  isRunningHubSource,
  isRunningHubTaskApiType,
  isRunningHubTaskTerminalFailure,
  isRunningHubTaskTerminalSuccess,
  isRunningHubUploadSuccess,
  resolveRunningHubBaseUrl,
  resolveRunningHubModelRootPath,
  resolveRunningHubSchema,
  resolveRunningHubSubmitPathForInput,
} from './runninghub.utils';

export const AI_CAPABILITIES = ['chat', 'embedding', 'tts', 'stt', 'image', 'video'] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];
export type AiExecutionMode = 'sync' | 'async';
export type AiPricingMode = 'per_mtoken' | 'per_call' | 'per_minute' | 'per_mchar' | 'per_second';

export const AI_APP_DEFAULT_MODEL_SLOTS = [
  'reasoning',
  'visual_index',
  'visual_analysis',
  'tts',
  'embedding',
  'transcription',
  'image_generation',
  'video_text_to_video',
  'video_image_to_video',
  'video_reference_to_video',
] as const;
export type AiAppDefaultModelSlot = (typeof AI_APP_DEFAULT_MODEL_SLOTS)[number];

const AI_APP_DEFAULT_SLOT_CAPABILITIES: Record<AiAppDefaultModelSlot, readonly AiCapability[]> = {
  reasoning: ['chat'],
  visual_index: ['embedding', 'chat'],
  visual_analysis: ['chat'],
  tts: ['tts'],
  embedding: ['embedding'],
  transcription: ['stt'],
  image_generation: ['image'],
  video_text_to_video: ['video'],
  video_image_to_video: ['video'],
  video_reference_to_video: ['video'],
};

const AI_CAPABILITY_PRIMARY_SLOT: Partial<Record<AiCapability, AiAppDefaultModelSlot>> = {
  chat: 'reasoning',
  embedding: 'embedding',
  tts: 'tts',
  stt: 'transcription',
  image: 'image_generation',
  video: 'video_text_to_video',
};

type AiGlobalSourceRow = {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  custom_headers: unknown;
  credentials_json: unknown;
  outbound_proxy_id: string | null;
  outbound_proxy_name?: string | null;
  outbound_proxy_protocol?: string | null;
  outbound_proxy_status?: string | null;
  outbound_proxy_latency_ms?: number | null;
  outbound_proxy_detected_ip?: string | null;
  outbound_proxy_region?: string | null;
  is_active: boolean;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AiGlobalSourceApiKeyRow = {
  id: string;
  source_id: string;
  label: string;
  api_key: string;
  sort_order: number;
  is_active: boolean;
  last_used_at: Date | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AiGlobalModelRow = {
  id: string;
  model_key: string;
  display_name: string;
  capability: string;
  execution_mode: string;
  pricing_mode: unknown;
  rmb_per_mtoken: unknown;
  rmb_per_call: unknown;
  rmb_per_minute: unknown;
  input_rmb_per_mtoken: unknown;
  cached_input_rmb_per_mtoken: unknown;
  cache_write_5m_rmb_per_mtoken: unknown;
  cache_write_1h_rmb_per_mtoken: unknown;
  output_rmb_per_mtoken: unknown;
  points_per_mtoken: unknown;
  points_per_call: unknown;
  points_per_minute: unknown;
  points_input_per_mtoken: unknown;
  points_cached_input_per_mtoken: unknown;
  points_cache_write_5m_per_mtoken: unknown;
  points_cache_write_1h_per_mtoken: unknown;
  points_output_per_mtoken: unknown;
  default_source_id: string;
  upstream_model: string;
  endpoint_path: string;
  api_type: string;
  request_overrides: unknown;
  is_default: boolean;
  is_active: boolean;
  is_visible: boolean;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AiGlobalModelJoinedRow = AiGlobalModelRow & {
  default_source_name: string;
  default_source_provider_type: string;
  default_source_base_url: string;
  default_source_api_key: string;
  default_source_custom_headers: unknown;
  default_source_outbound_proxy_id: string | null;
  default_source_is_active: boolean;
};

type AiAppModelRouteRow = {
  id: string;
  app_id: string;
  global_model_id: string;
  source_id: string;
  is_active: boolean;
  request_overrides: unknown;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AiModelSourceRouteJoinedRow = {
  id: string;
  route_key: string | null;
  app_id: string | null;
  global_model_id: string;
  source_id: string;
  sort_order: number;
  is_active: boolean;
  upstream_model: string | null;
  endpoint_path: string | null;
  api_type: string | null;
  request_overrides: unknown;
  created_at: Date;
  updated_at: Date;
  source_name: string;
  source_provider_type: string;
  source_base_url: string;
  source_api_key: string;
  source_custom_headers: unknown;
  source_credentials_json: unknown;
  source_outbound_proxy_id: string | null;
  source_is_active: boolean;
};

type NormalizedAiModelSourceRouteInput = AiModelSourceRouteInput & {
  source_id: string;
  route_key: string;
};

type AiAppCapabilityDefaultRow = {
  id: string;
  app_id: string;
  capability: string;
  global_model_id: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AiAppCapabilityDefaultJoinedRow = AiAppCapabilityDefaultRow & {
  model_key: string;
  model_display_name: string;
  model_capability: string;
  model_is_active: boolean;
};

type AiAppDefaultModelSlotRow = {
  id: string;
  app_id: string;
  slot_key: string;
  primary_global_model_id: string | null;
  fallback_global_model_id: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AiAppDefaultModelSlotJoinedRow = AiAppDefaultModelSlotRow & {
  primary_model_key: string | null;
  primary_model_display_name: string | null;
  primary_model_capability: string | null;
  primary_model_is_active: boolean | null;
  fallback_model_key: string | null;
  fallback_model_display_name: string | null;
  fallback_model_capability: string | null;
  fallback_model_is_active: boolean | null;
};

type AiAppModelRouteJoinedRow = {
  model_id: string;
  model_key: string;
  model_display_name: string;
  model_capability: string;
  model_execution_mode: string;
  model_pricing_mode: unknown;
  model_rmb_per_mtoken: unknown;
  model_rmb_per_call: unknown;
  model_rmb_per_minute: unknown;
  model_input_rmb_per_mtoken: unknown;
  model_cached_input_rmb_per_mtoken: unknown;
  model_cache_write_5m_rmb_per_mtoken: unknown;
  model_cache_write_1h_rmb_per_mtoken: unknown;
  model_output_rmb_per_mtoken: unknown;
  model_points_per_mtoken: unknown;
  model_points_per_call: unknown;
  model_points_per_minute: unknown;
  model_points_input_per_mtoken: unknown;
  model_points_cached_input_per_mtoken: unknown;
  model_points_cache_write_5m_per_mtoken: unknown;
  model_points_cache_write_1h_per_mtoken: unknown;
  model_points_output_per_mtoken: unknown;
  model_upstream_model: string;
  model_endpoint_path: string;
  model_api_type: string;
  model_request_overrides: unknown;
  model_is_default: boolean;
  model_is_active: boolean;
  model_is_visible: boolean;
  default_source_id: string;
  default_source_name: string;
  default_source_provider_type: string;
  default_source_is_active: boolean;
  route_id: string | null;
  route_source_id: string | null;
  route_source_name: string | null;
  route_source_provider_type: string | null;
  route_source_is_active: boolean | null;
  route_is_active: boolean | null;
  route_request_overrides: unknown;
  route_updated_at: Date | null;
};

export interface AiSourceInput {
  name?: string;
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  api_keys?: AiSourceApiKeyInput[];
  custom_headers?: Record<string, string>;
  credentials?: Record<string, unknown>;
  outbound_proxy_id?: string | null;
  is_active?: boolean;
}

export interface AiSourceApiKeyInput {
  id?: string | null;
  label?: string | null;
  api_key?: string | null;
  sort_order?: number | string | null;
  is_active?: boolean;
}

export interface AiSourceConnectivityTestInput {
  source_id?: string;
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  custom_headers?: Record<string, string>;
  credentials?: Record<string, unknown>;
  outbound_proxy_id?: string | null;
  test_path?: string;
  timeout_ms?: number;
}

export interface AiModelInput {
  model_key?: string;
  display_name?: string;
  capability?: string;
  execution_mode?: string;
  pricing_mode?: string;
  rmb_per_mtoken?: number | string;
  rmb_per_call?: number | string;
  rmb_per_minute?: number | string;
  input_rmb_per_mtoken?: number | string;
  cached_input_rmb_per_mtoken?: number | string;
  cache_write_5m_rmb_per_mtoken?: number | string;
  cache_write_1h_rmb_per_mtoken?: number | string;
  output_rmb_per_mtoken?: number | string;
  points_per_mtoken?: number | string;
  points_per_call?: number | string;
  points_per_minute?: number | string;
  points_input_per_mtoken?: number | string;
  points_cached_input_per_mtoken?: number | string;
  points_cache_write_5m_per_mtoken?: number | string;
  points_cache_write_1h_per_mtoken?: number | string;
  points_output_per_mtoken?: number | string;
  default_source_id?: string;
  upstream_model?: string;
  endpoint_path?: string;
  api_type?: string;
  request_overrides?: Record<string, unknown>;
  source_routes?: AiModelSourceRouteInput[];
  is_default?: boolean;
  is_active?: boolean;
  is_visible?: boolean;
}

export interface AiModelSourceRouteInput {
  route_key?: string | null;
  source_id?: string;
  sort_order?: number | string;
  is_active?: boolean;
  upstream_model?: string | null;
  endpoint_path?: string | null;
  api_type?: string | null;
  request_overrides?: Record<string, unknown> | null;
}

export interface AiModelConnectivityTestInput {
  model_id?: string;
  app_id?: string;
  app_slug?: string;
  capability?: string;
  source_id?: string;
  upstream_model?: string;
  endpoint_path?: string;
  api_type?: string;
  request_overrides?: Record<string, unknown>;
  test_prompt?: string;
  timeout_ms?: number;
}

export interface AiAppModelRouteInput {
  source_id?: string;
  is_active?: boolean;
  request_overrides?: Record<string, unknown>;
}

export interface AiAppCapabilityDefaultInput {
  model_id?: string;
}

export interface AiAppDefaultModelSlotInput {
  primary_model_id?: string | null;
  fallback_model_id?: string | null;
}

export interface ResolvedAiRoute {
  app_id: string;
  app_slug: string;
  route_key: string;
  model_id: string;
  model_key: string;
  display_name: string;
  capability: AiCapability;
  execution_mode: AiExecutionMode;
  pricing_mode: AiPricingMode;
  rmb_per_mtoken: number;
  rmb_per_call: number;
  rmb_per_minute: number;
  input_rmb_per_mtoken: number;
  cached_input_rmb_per_mtoken: number;
  cache_write_5m_rmb_per_mtoken: number;
  cache_write_1h_rmb_per_mtoken: number;
  output_rmb_per_mtoken: number;
  points_per_mtoken: number;
  points_per_call: number;
  points_per_minute: number;
  points_input_per_mtoken: number;
  points_cached_input_per_mtoken: number;
  points_cache_write_5m_per_mtoken: number;
  points_cache_write_1h_per_mtoken: number;
  points_output_per_mtoken: number;
  upstream_model: string;
  endpoint_path: string;
  api_type: string;
  request_overrides: Record<string, unknown>;
  source: {
    id: string;
    name: string;
    provider_type: string;
    base_url: string;
    api_key: string;
    custom_headers: Record<string, string>;
    credentials: Record<string, unknown>;
    outbound_proxy_id: string | null;
    is_active: boolean;
  };
}

type ResolvedRouteCacheEntry = {
  value: ResolvedAiRoute;
  expiresAt: number;
};

export interface AiUsageLogInput {
  app_id: string;
  app_slug: string;
  user_id?: string | null;
  usage_reference_id?: string | null;
  global_model_id: string;
  model_key: string;
  upstream_model: string;
  capability: string;
  source_id: string;
  source_name: string;
  provider_type: string;
  endpoint_path: string;
  request_path?: string;
  request_id?: string;
  is_stream?: boolean;
  success: boolean;
  error_message?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  uncached_input_tokens?: number | null;
  cached_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation_5m_input_tokens?: number | null;
  cache_creation_1h_input_tokens?: number | null;
  billed_input_tokens?: number | null;
  billed_cached_input_tokens?: number | null;
  billed_cache_write_tokens?: number | null;
  billed_output_tokens?: number | null;
  unit_price_rmb_per_mtoken?: number;
  unit_price_rmb_per_call?: number;
  unit_price_rmb_per_minute?: number;
  unit_price_rmb_input_per_mtoken?: number;
  unit_price_rmb_cached_input_per_mtoken?: number;
  unit_price_rmb_cache_write_5m_per_mtoken?: number;
  unit_price_rmb_cache_write_1h_per_mtoken?: number;
  unit_price_rmb_output_per_mtoken?: number;
  unit_price_mode?: string;
  billed_units?: number | null;
  billed_unit_label?: string | null;
  billed_duration_seconds?: number | null;
  estimated_cost_rmb?: number;
  points_cost?: number | null;
  points_pricing_source?: string | null;
  latency_ms?: number | null;
}

export interface AiUsageSummaryQueryInput {
  days?: number | string;
  from?: string;
  to?: string;
  app_id?: string;
  capability?: string;
  model_id?: string;
  model_key?: string;
  source_id?: string;
  success?: boolean | string;
}

export interface AiUsageLogsQueryInput extends AiUsageSummaryQueryInput {
  page?: number | string;
  page_size?: number | string;
}

export interface AiSourceConnectivityTestResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  endpoint_url: string;
  provider_type: string;
  message: string;
  response_excerpt: string;
}

export interface AiModelConnectivityTestResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  endpoint_url: string;
  model_key: string;
  upstream_model: string;
  source_id: string;
  source_name: string;
  provider_type: string;
  message: string;
  response_excerpt: string;
  audio_detected?: boolean;
  async_task_id?: string | null;
}

const MINIMAX_TTS_SYNC_API_TYPE = 'minimax-tts-sync';
const MINIMAX_TTS_ASYNC_API_TYPE = 'minimax-tts-async';
const MINIMAX_TTS_API_TYPE = 'minimax-tts';
const MINIMAX_VOICE_CLONE_API_TYPE = 'minimax-voice-clone';
const ALIYUN_ICE_PROVIDER_TYPE = 'aliyun-ice';
const ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE = 'aliyun-ice-video-translation';
const DASHSCOPE_COSYVOICE_TTS_API_TYPE = 'dashscope-cosyvoice-tts';
const DASHSCOPE_COSYVOICE_VOICE_CLONE_API_TYPE = 'dashscope-cosyvoice-voice-clone';
const DASHSCOPE_NATIVE_IMAGE_API_TYPE = 'dashscope-native-image';
const DASHSCOPE_NATIVE_STT_API_TYPE = 'dashscope-native-stt';
const DASHSCOPE_NATIVE_VIDEO_API_TYPE = 'dashscope-native-video';
const DASHSCOPE_VIDEORETALK_API_TYPE = 'dashscope-videoretalk';
const DASHSCOPE_COSYVOICE_TTS_DEFAULT_ENDPOINT = '/services/audio/tts/SpeechSynthesizer';
const DASHSCOPE_COSYVOICE_VOICE_CLONE_DEFAULT_ENDPOINT = '/services/audio/tts/customization';
const DASHSCOPE_NATIVE_IMAGE_DEFAULT_ENDPOINT = '/api/v1/services/aigc/image-generation/generation';
const DASHSCOPE_NATIVE_IMAGE_MULTIMODAL_ENDPOINT = '/api/v1/services/aigc/multimodal-generation/generation';
const DASHSCOPE_NATIVE_STT_DEFAULT_ENDPOINT = '/api/v1/services/audio/asr/transcription';
const DASHSCOPE_NATIVE_VIDEO_DEFAULT_ENDPOINT = '/api/v1/services/aigc/video-generation/video-synthesis';
const DASHSCOPE_VIDEORETALK_DEFAULT_ENDPOINT = '/api/v1/services/aigc/image2video/video-synthesis';
const DASHSCOPE_NATIVE_VIDEO_TEST_IMAGE_URL =
  'https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/wpimhv/rap.png';
const DASHSCOPE_VIDEORETALK_TEST_VIDEO_URL =
  'https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250717/pvegot/input_video_01.mp4';
const DASHSCOPE_VIDEORETALK_TEST_AUDIO_URL =
  'https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250717/aumwir/stella2-%E6%9C%89%E5%A3%B0%E4%B9%A67.wav';
const OPENROUTER_PROVIDER_TYPE = 'openrouter-openai';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_CHAT_API_TYPE = 'openrouter-chat-completions';
const OPENROUTER_EMBEDDINGS_API_TYPE = 'openrouter-embeddings';
const OPENROUTER_AUDIO_SPEECH_API_TYPE = 'openrouter-audio-speech';
const OPENROUTER_AUDIO_TRANSCRIPTIONS_API_TYPE = 'openrouter-audio-transcriptions';
const OPENROUTER_VIDEO_API_TYPE = 'openrouter-video-generation';
const RESOLVED_ROUTE_CACHE_TTL_MS = 300_000;
const AI_USAGE_FACTS_REFRESH_INTERVAL_MS = 60_000;
const SOURCE_API_KEY_CACHE_TTL_MS = 60_000;

@Injectable()
export class AiRoutingService implements OnModuleInit {
  private readonly logger = new Logger(AiRoutingService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private readonly resolvedRouteCache = new Map<string, ResolvedRouteCacheEntry>();
  private readonly sourceApiKeyRotationCounters = new Map<string, number>();
  private readonly sourceApiKeyCache = new Map<string, { value: AiGlobalSourceApiKeyRow[]; expiresAt: number }>();
  private readonly sourceApiKeyLastUsedWriteAt = new Map<string, number>();
  private modelSourceRoutesTableAvailable: boolean | null = null;
  private usageFactsRefreshRunning = false;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly outboundHttp: OutboundHttpClientService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
      await this.refreshUsageFactsFromWatermark();
    } catch (error: any) {
      this.logger.warn(`ai routing startup warmup failed: ${error?.message || error}`);
    }
  }

  @Interval(AI_USAGE_FACTS_REFRESH_INTERVAL_MS)
  private async refreshUsageFactsInterval() {
    if (this.usageFactsRefreshRunning) {
      return;
    }
    this.usageFactsRefreshRunning = true;
    try {
      await this.refreshUsageFactsFromWatermark();
    } catch (error: any) {
      this.logger.warn(`ai usage facts refresh failed: ${error?.message || error}`);
    } finally {
      this.usageFactsRefreshRunning = false;
    }
  }

  async listGlobalSources() {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         s.*,
         p.name AS outbound_proxy_name,
         p.protocol AS outbound_proxy_protocol,
         p.status AS outbound_proxy_status,
         p.latency_ms AS outbound_proxy_latency_ms,
         p.detected_ip AS outbound_proxy_detected_ip,
         p.region AS outbound_proxy_region
       FROM ai_global_sources s
       LEFT JOIN outbound_proxies p ON p.id = s.outbound_proxy_id
       ORDER BY s.created_at DESC`,
    ) as Promise<AiGlobalSourceRow[]>);
    const keyMap = await this.listSourceApiKeysMap(rows.map((row) => row.id));
    return rows.map((row) => this.serializeGlobalSource(row, keyMap.get(row.id) || []));
  }

  listProviderTemplates() {
    return {
      items: [
        {
          provider_type: OPENROUTER_PROVIDER_TYPE,
          label: 'OpenRouter',
          base_url: OPENROUTER_BASE_URL,
          source_test_path: '/models',
          source_defaults: {
            provider_type: OPENROUTER_PROVIDER_TYPE,
            base_url: OPENROUTER_BASE_URL,
            custom_headers: {
              'HTTP-Referer': '',
              'X-OpenRouter-Title': '',
            },
          },
          capabilities: {
            chat: {
              endpoint_path: '/chat/completions',
              api_type: OPENROUTER_CHAT_API_TYPE,
              model_discovery: '/models',
            },
            embedding: {
              endpoint_path: '/embeddings',
              api_type: OPENROUTER_EMBEDDINGS_API_TYPE,
              model_discovery: '/models?output_modalities=embeddings',
            },
            image: {
              endpoint_path: '/chat/completions',
              api_type: OPENROUTER_CHAT_API_TYPE,
              request_overrides: {
                modalities: ['image', 'text'],
              },
              model_discovery: '/models?output_modalities=image',
            },
            tts: {
              endpoint_path: '/audio/speech',
              api_type: OPENROUTER_AUDIO_SPEECH_API_TYPE,
              request_overrides: {
                response_format: 'mp3',
                voice: 'alloy',
              },
              model_discovery: '/models?output_modalities=speech',
            },
            stt: {
              endpoint_path: '/audio/transcriptions',
              api_type: OPENROUTER_AUDIO_TRANSCRIPTIONS_API_TYPE,
              model_discovery: '/models?output_modalities=text',
            },
            video: {
              endpoint_path: '/videos',
              api_type: OPENROUTER_VIDEO_API_TYPE,
              execution_mode: 'async',
              request_overrides: {
                resolution: '720p',
                aspect_ratio: '16:9',
              },
              model_discovery: '/videos/models',
              query_endpoint_path: '/videos/{job_id}',
            },
          },
        },
      ],
    };
  }

  async createGlobalSource(actorUserId: string, payload: AiSourceInput) {
    await this.ensureSchema();

    const name = String(payload.name || '').trim();
    const providerType = String(payload.provider_type || 'openai-compatible').trim() || 'openai-compatible';
    const baseUrl = this.normalizeBaseUrl(payload.base_url, providerType);
    const credentials = this.normalizeSourceCredentialsInput(
      providerType,
      payload.credentials,
      undefined,
      true,
    );
    const apiKeyInputs = this.normalizeSourceApiKeyInputs(payload.api_keys);
    const firstApiKey = apiKeyInputs.find((item) => item.api_key)?.api_key || '';
    const apiKey = String(payload.api_key || firstApiKey || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!baseUrl) {
      throw new BadRequestException('base_url is required');
    }
    if (!apiKey && (!this.isVertexAiSource(providerType, baseUrl) || credentials.auth_mode === 'api_key')) {
      throw new BadRequestException('api_key is required');
    }

    const headers = this.normalizeStringObject(payload.custom_headers);
    const outboundProxyId = this.normalizeNullableUuid(payload.outbound_proxy_id);
    await this.ensureOutboundProxyExists(outboundProxyId);
    const isActive = payload.is_active !== false;

    const duplicated = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM ai_global_sources WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      name,
    ) as Promise<Array<{ id: string }>>);
    if (duplicated[0]) {
      throw new BadRequestException('source name already exists');
    }

    const inserted = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_global_sources (
         id, name, provider_type, base_url, api_key, custom_headers, credentials_json, outbound_proxy_id, is_active, created_by_user_id, updated_by_user_id
       )
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::uuid, $8, $9::uuid, $9::uuid)
       RETURNING *`,
      name,
      providerType,
      baseUrl,
      apiKey,
      JSON.stringify(headers),
      JSON.stringify(credentials),
      outboundProxyId,
      isActive,
      actorUserId,
    ) as Promise<AiGlobalSourceRow[]>);

    if (apiKey || payload.api_keys !== undefined) {
      await this.replaceSourceApiKeys(inserted[0].id, actorUserId, payload.api_keys, apiKey);
    }
    this.clearResolvedRouteCache();
    return this.getSerializedGlobalSourceById(inserted[0].id);
  }

  async updateGlobalSource(sourceId: string, actorUserId: string, payload: AiSourceInput) {
    await this.ensureSchema();

    const existing = await this.getGlobalSourceById(sourceId);
    if (!existing) {
      throw new NotFoundException('AI source not found');
    }

    const nextName = payload.name === undefined ? existing.name : String(payload.name).trim();
    const nextProviderType =
      payload.provider_type === undefined ? existing.provider_type : String(payload.provider_type).trim();
    const nextBaseUrl = this.normalizeBaseUrl(
      payload.base_url === undefined ? existing.base_url : payload.base_url,
      nextProviderType,
    );
    const nextCredentials = this.normalizeSourceCredentialsInput(
      nextProviderType,
      payload.credentials,
      existing.credentials_json,
      payload.credentials !== undefined,
    );
    const apiKeyInputs = this.normalizeSourceApiKeyInputs(payload.api_keys);
    const firstApiKey = apiKeyInputs.find((item) => item.api_key)?.api_key || '';
    const nextApiKey =
      payload.api_key === undefined
        ? (firstApiKey || existing.api_key)
        : String(payload.api_key || firstApiKey || '').trim();
    const nextHeaders =
      payload.custom_headers === undefined
        ? this.normalizeStringObject(existing.custom_headers)
        : this.normalizeStringObject(payload.custom_headers);
    const nextOutboundProxyId = payload.outbound_proxy_id === undefined
      ? existing.outbound_proxy_id
      : this.normalizeNullableUuid(payload.outbound_proxy_id);
    await this.ensureOutboundProxyExists(nextOutboundProxyId);
    const nextIsActive = payload.is_active === undefined ? existing.is_active : !!payload.is_active;

    if (!nextName) {
      throw new BadRequestException('name is required');
    }
    if (!nextBaseUrl) {
      throw new BadRequestException('base_url is required');
    }
    if (!nextApiKey && (!this.isVertexAiSource(nextProviderType, nextBaseUrl) || nextCredentials.auth_mode === 'api_key')) {
      throw new BadRequestException('api_key is required');
    }

    const duplicated = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM ai_global_sources WHERE LOWER(name) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
      nextName,
      sourceId,
    ) as Promise<Array<{ id: string }>>);
    if (duplicated[0]) {
      throw new BadRequestException('source name already exists');
    }

    const updated = await (this.prisma.$queryRawUnsafe(
      `UPDATE ai_global_sources
       SET name = $1,
           provider_type = $2,
           base_url = $3,
           api_key = $4,
           custom_headers = $5::jsonb,
           credentials_json = $6::jsonb,
           outbound_proxy_id = $7::uuid,
           is_active = $8,
           updated_by_user_id = $9::uuid,
           updated_at = now()
       WHERE id = $10::uuid
       RETURNING *`,
      nextName,
      nextProviderType,
      nextBaseUrl,
      nextApiKey,
      JSON.stringify(nextHeaders),
      JSON.stringify(nextCredentials),
      nextOutboundProxyId,
      nextIsActive,
      actorUserId,
      sourceId,
    ) as Promise<AiGlobalSourceRow[]>);

    if ((payload.api_keys !== undefined || payload.api_key !== undefined) && nextApiKey) {
      const rows = await this.replaceSourceApiKeys(sourceId, actorUserId, payload.api_keys, nextApiKey);
      const primaryKey = this.pickPrimarySourceApiKey(rows, nextApiKey);
      if (primaryKey !== nextApiKey) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_global_sources
           SET api_key = $1,
               updated_by_user_id = $2::uuid,
               updated_at = now()
           WHERE id = $3::uuid`,
          primaryKey,
          actorUserId,
          sourceId,
        );
      }
    }
    this.clearResolvedRouteCache();
    return this.getSerializedGlobalSourceById(sourceId);
  }

  async deleteGlobalSource(sourceId: string) {
    await this.ensureSchema();

    const usedByGlobalModels = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM ai_global_models WHERE default_source_id = $1::uuid`,
      sourceId,
    ) as Promise<Array<{ count: bigint }>>);
    if (Number(usedByGlobalModels[0]?.count || 0) > 0) {
      throw new BadRequestException('source is used as default source by global models');
    }

    const usedByAppRoutes = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM ai_app_model_routes WHERE source_id = $1::uuid`,
      sourceId,
    ) as Promise<Array<{ count: bigint }>>);
    if (Number(usedByAppRoutes[0]?.count || 0) > 0) {
      throw new BadRequestException('source is used by app model routes');
    }

    const deleted = await this.prisma.$executeRawUnsafe(
      `DELETE FROM ai_global_sources WHERE id = $1::uuid`,
      sourceId,
    );
    if (!deleted) {
      throw new NotFoundException('AI source not found');
    }
    this.sourceApiKeyCache.delete(sourceId);
    this.sourceApiKeyRotationCounters.delete(sourceId);
    this.clearResolvedRouteCache();
    return { deleted: true };
  }

  async testSourceConnectivity(payload: AiSourceConnectivityTestInput): Promise<AiSourceConnectivityTestResult> {
    await this.ensureSchema();

    const sourceId = String(payload.source_id || '').trim();
    const existing = sourceId ? await this.getGlobalSourceById(sourceId) : null;
    if (sourceId && !existing) {
      throw new NotFoundException('AI source not found');
    }

    const providerType =
      String(payload.provider_type || existing?.provider_type || 'openai-compatible').trim() || 'openai-compatible';
    const baseUrl = this.normalizeBaseUrl(
      payload.base_url === undefined ? existing?.base_url : payload.base_url,
      providerType,
    );
    const apiKey = String(payload.api_key || '').trim()
      || (existing ? await this.selectNextSourceApiKey(existing.id, existing.api_key) : '');
    const customHeaders =
      payload.custom_headers === undefined
        ? this.normalizeStringObject(existing?.custom_headers)
        : this.normalizeStringObject(payload.custom_headers);
    const credentials = this.normalizeSourceCredentialsInput(
      providerType,
      payload.credentials,
      existing?.credentials_json,
      payload.credentials !== undefined || this.isVertexAiSource(providerType, baseUrl),
    );
    const outboundProxyId = payload.outbound_proxy_id === undefined
      ? existing?.outbound_proxy_id || null
      : this.normalizeNullableUuid(payload.outbound_proxy_id);
    await this.ensureOutboundProxyExists(outboundProxyId);
    const rawEndpointPath = this.normalizeEndpointPath(payload.test_path || '/models');
    const endpointPath = this.normalizeMinimaxEndpointPathForBase(providerType, baseUrl, rawEndpointPath);
    let endpointUrl = this.joinUrl(baseUrl, endpointPath);

    if (!baseUrl) {
      throw new BadRequestException('base_url is required');
    }
    if (!apiKey && (!this.isVertexAiSource(providerType, baseUrl) || credentials.auth_mode === 'api_key')) {
      throw new BadRequestException('api_key is required for connectivity test');
    }

    const timeoutMsRaw = Number(payload.timeout_ms ?? 10000);
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.min(Math.max(Math.round(timeoutMsRaw), 2000), 30000)
      : 10000;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...customHeaders,
    };

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      if (isRunningHubProviderType(providerType)) {
        return this.outboundHttp.runWithProxy(outboundProxyId, () => this.testRunningHubSourceConnectivity({
          providerType,
          baseUrl,
          apiKey,
          customHeaders,
          timeoutMs,
        }));
      }
      if (this.isAliyunIceSource(providerType, baseUrl)) {
        return this.outboundHttp.runWithProxy(outboundProxyId, () => this.testAliyunIceSourceConnectivity({
          providerType,
          baseUrl,
          apiKey,
          customHeaders,
          timeoutMs,
        }));
      }
      if (this.isAnthropicSource(providerType, baseUrl)) {
        return this.outboundHttp.runWithProxy(outboundProxyId, () => this.testSourceConnectivityViaAnthropicSdk({
          providerType,
          baseUrl,
          apiKey,
          customHeaders,
          timeoutMs,
        }));
      }
      if (this.isVertexAiSource(providerType, baseUrl)) {
        return this.outboundHttp.runWithProxy(outboundProxyId, () => this.testSourceConnectivityViaGoogleGenAiSdk({
          source: {
            id: existing?.id || 'adhoc',
            name: existing?.name || 'Vertex AI',
            provider_type: providerType,
            base_url: baseUrl,
            api_key: apiKey,
            custom_headers: customHeaders,
            credentials_json: credentials,
            outbound_proxy_id: outboundProxyId,
            is_active: true,
            created_by_user_id: null,
            updated_by_user_id: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
          timeoutMs,
        }));
      }
      if (this.isGoogleSource(providerType, baseUrl)) {
        return this.outboundHttp.runWithProxy(outboundProxyId, () => this.testSourceConnectivityViaGoogleGenAiSdk({
          source: {
            id: existing?.id || 'adhoc',
            name: existing?.name || 'Google Gemini API',
            provider_type: providerType,
            base_url: baseUrl,
            api_key: apiKey,
            custom_headers: customHeaders,
            credentials_json: credentials,
            outbound_proxy_id: outboundProxyId,
            is_active: true,
            created_by_user_id: null,
            updated_by_user_id: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
          timeoutMs,
        }));
      }

      const probeRequest = this.resolveSourceProbeRequest(providerType, endpointPath);
      if (probeRequest.query) {
        const parsed = new URL(endpointUrl);
        Object.entries(probeRequest.query).forEach(([key, value]) => {
          if (!parsed.searchParams.has(key)) {
            parsed.searchParams.set(key, value);
          }
        });
        endpointUrl = parsed.toString();
      }

      const response = await this.outboundHttp.fetch(endpointUrl, {
        method: probeRequest.method,
        headers,
        body: probeRequest.method === 'POST' ? JSON.stringify(probeRequest.body || {}) : undefined,
        signal: controller.signal,
      }, {
        proxyId: outboundProxyId,
      });

      const latencyMs = Date.now() - startedAt;
      const raw = await response.text();
      const responseExcerpt = this.truncate(this.safeJsonPreview(raw), 500);

      return {
        ok: response.ok,
        status_code: response.status,
        latency_ms: latencyMs,
        endpoint_url: endpointUrl,
        provider_type: providerType,
        message: response.ok ? '连通性测试通过' : `上游返回 ${response.status}`,
        response_excerpt: responseExcerpt,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startedAt;
      const timedOut = error?.name === 'AbortError';
      return {
        ok: false,
        status_code: null,
        latency_ms: latencyMs,
        endpoint_url: endpointUrl,
        provider_type: providerType,
        message: timedOut ? `连接超时（>${timeoutMs}ms）` : `连接失败：${error?.message || 'unknown error'}`,
        response_excerpt: '',
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async testModelConnectivity(payload: AiModelConnectivityTestInput): Promise<AiModelConnectivityTestResult> {
    await this.ensureSchema();

    const modelId = String(payload.model_id || '').trim();
    const existingModel = modelId ? await this.getGlobalModelRowById(modelId) : null;
    if (modelId && !existingModel) {
      throw new NotFoundException('AI model not found');
    }

    const sourceId = String(payload.source_id || existingModel?.default_source_id || '').trim();
    if (!sourceId) {
      throw new BadRequestException('source_id is required');
    }
    const source = await this.getGlobalSourceById(sourceId);
    if (!source) {
      throw new NotFoundException('AI source not found');
    }
    source.api_key = await this.selectNextSourceApiKey(source.id, source.api_key);
    const sourceRoute = existingModel
      ? await this.findGlobalModelSourceRouteForSource(existingModel.id, sourceId)
      : null;

    const modelKey = String(existingModel?.model_key || payload.upstream_model || 'adhoc-model').trim();
    const capability = existingModel
      ? this.normalizeCapability(existingModel.capability)
      : this.normalizeCapability(payload.capability || 'chat');
    const upstreamModel = String(
      payload.upstream_model || sourceRoute?.upstream_model || existingModel?.upstream_model || modelKey,
    ).trim();
    if (!upstreamModel) {
      throw new BadRequestException('upstream_model is required');
    }

    const requestedApiType = String(
      payload.api_type
      || sourceRoute?.api_type
      || existingModel?.api_type
      || (isRunningHubProviderType(source.provider_type) ? RUNNINGHUB_TASK_API_TYPE : 'openai-chat-completions'),
    ).trim();
    const apiType = this.resolveApiTypeForSource(requestedApiType, capability, source.provider_type, source.base_url, upstreamModel);
    const rawEndpointPath = this.normalizeEndpointPath(
      payload.endpoint_path
      || sourceRoute?.endpoint_path
      || existingModel?.endpoint_path
      || this.defaultEndpointPathForApiType(apiType, capability),
    );
    const providerAdjustedEndpointPath = this.normalizeEndpointPathForProvider(apiType, capability, rawEndpointPath);
    const normalizedEndpointPath = this.normalizeMinimaxEndpointPathForBase(
      source.provider_type,
      source.base_url,
      providerAdjustedEndpointPath,
    );
    const requestOverrides = {
      ...this.normalizeObject(existingModel?.request_overrides),
      ...this.normalizeObject(sourceRoute?.request_overrides),
      ...this.normalizeObject(payload.request_overrides),
    };

    const useDashscopeNative = this.shouldUseDashscopeNativeForCapability(
      apiType,
      capability,
      source.provider_type,
      source.base_url,
    );
    const endpointPath = useDashscopeNative && capability === 'image'
      ? this.resolveDashscopeImageProbeEndpointPath(normalizedEndpointPath, upstreamModel)
      : normalizedEndpointPath;
    const isMinimaxTts = this.isMinimaxTtsApiType(apiType);
    const isDashscopeCosyVoiceTts = this.isDashscopeCosyVoiceTtsApiType(apiType, endpointPath);
    const useOpenRouterProbe = this.isOpenRouterSource(source.provider_type, source.base_url)
      || this.isOpenRouterApiType(apiType);
    const useOpenAiSttMultipartProbe = capability === 'stt' && !isMinimaxTts && !useDashscopeNative && !useOpenRouterProbe;
    let endpointUrl = useDashscopeNative
      ? this.joinDashscopeNativeUrl(source.base_url, endpointPath)
      : this.joinUrl(source.base_url, endpointPath);
    const timeoutMsRaw = Number(payload.timeout_ms ?? 12000);
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.min(Math.max(Math.round(timeoutMsRaw), 2000), 30000)
      : 12000;
    const testPrompt = String(payload.test_prompt || 'ok').trim() || 'ok';
    if (isRunningHubSource(source.provider_type, source.base_url) || isRunningHubTaskApiType(apiType)) {
      return this.testRunningHubModelConnectivity({
        source,
        modelKey,
        capability,
        upstreamModel,
        endpointPath: normalizedEndpointPath,
        requestOverrides,
        testPrompt,
        timeoutMs,
      });
    }
    if (this.isAliyunIceSource(source.provider_type, source.base_url)) {
      return this.testAliyunIceModelConnectivity({
        source,
        modelKey,
        upstreamModel,
        timeoutMs,
      });
    }
    const shouldUseAnthropicProbe = this.isAnthropicSource(source.provider_type, source.base_url);
    const shouldUseGoogleGenAiProbe =
      !shouldUseAnthropicProbe
      && this.isGoogleSource(source.provider_type, source.base_url)
      && capability !== 'stt'
      && capability !== 'video';
    if (shouldUseAnthropicProbe) {
      endpointUrl = this.buildAnthropicProbeEndpointUrl(source.base_url, 'messages');
    }
    if (shouldUseGoogleGenAiProbe) {
      endpointUrl = this.buildGoogleProbeEndpointUrl(source.base_url, upstreamModel, capability);
    }
    const shouldUseAiSdkProbe =
      !shouldUseAnthropicProbe
      && !shouldUseGoogleGenAiProbe
      && !useDashscopeNative
      && !isMinimaxTts
      && !isDashscopeCosyVoiceTts
      && capability !== 'video'
      && capability !== 'stt'
      && !useOpenRouterProbe;
    if (shouldUseAnthropicProbe) {
      return this.outboundHttp.runWithProxy(source.outbound_proxy_id, () => this.testModelConnectivityViaAnthropicSdk({
        endpointUrl,
        source,
        modelKey,
        capability,
        upstreamModel,
        testPrompt,
        timeoutMs,
      }));
    }
    if (shouldUseGoogleGenAiProbe) {
      return this.outboundHttp.runWithProxy(source.outbound_proxy_id, () => this.testModelConnectivityViaGoogleGenAiSdk({
        endpointUrl,
        source,
        modelKey,
        capability,
        upstreamModel,
        apiType,
        testPrompt,
        timeoutMs,
      }));
    }
    if (shouldUseAiSdkProbe) {
      return this.outboundHttp.runWithProxy(source.outbound_proxy_id, () => this.testModelConnectivityViaAiSdk({
        endpointUrl,
        source,
        modelKey,
        capability,
        upstreamModel,
        apiType,
        testPrompt,
        timeoutMs,
      }));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${source.api_key}`,
      ...this.normalizeStringObject(source.custom_headers),
    };
    if (!useOpenAiSttMultipartProbe) {
      headers['Content-Type'] = 'application/json';
    }
    if (useDashscopeNative && capability === 'stt') {
      headers['X-DashScope-Async'] = 'enable';
    }
    if (useDashscopeNative && capability === 'image' && !endpointPath.includes('/multimodal-generation/')) {
      headers['X-DashScope-Async'] = 'enable';
    }
    if (useDashscopeNative && capability === 'video') {
      headers['X-DashScope-Async'] = 'enable';
    }

    const normalizedApiType = String(apiType || '').trim().toLowerCase();
    const isModelListProbe = endpointPath.endsWith('/models') && !isMinimaxTts;
    const method: 'GET' | 'POST' = useOpenRouterProbe && isModelListProbe
      ? 'GET'
      : useDashscopeNative
      ? 'POST'
      : useOpenAiSttMultipartProbe
        ? 'POST'
      : isModelListProbe
        ? 'GET'
        : 'POST';
    const bodyPayload = useOpenRouterProbe
      ? this.buildOpenRouterProbePayload(capability, upstreamModel, testPrompt, requestOverrides)
      : useDashscopeNative
      ? this.buildDashscopeNativeProbePayload(capability, upstreamModel, testPrompt, requestOverrides, endpointPath)
      : useOpenAiSttMultipartProbe
        ? null
      : isMinimaxTts
        ? this.buildMinimaxTtsProbePayload(upstreamModel, testPrompt, requestOverrides)
        : isDashscopeCosyVoiceTts
          ? this.buildDashscopeCosyVoiceTtsProbePayload(upstreamModel, testPrompt, requestOverrides)
        : this.buildOpenAiCompatibleProbePayload(capability, upstreamModel, testPrompt, requestOverrides);
    const multipartProbeForm = useOpenAiSttMultipartProbe
      ? this.buildOpenAiSttProbeForm(upstreamModel, requestOverrides)
      : null;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.outboundHttp.fetch(endpointUrl, {
        method,
        headers,
        body: method === 'POST'
          ? (multipartProbeForm || JSON.stringify(bodyPayload || {}))
          : undefined,
        signal: controller.signal,
      }, {
        proxyId: source.outbound_proxy_id,
      });

      const latencyMs = Date.now() - startedAt;
      const raw = await response.text();
      const responseExcerpt = this.truncate(this.safeJsonPreview(raw), 500);
      const parsedBody = this.tryParseJsonObject(raw);
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const audioDetected = isMinimaxTts && normalizedApiType === MINIMAX_TTS_SYNC_API_TYPE
        ? this.minimaxTtsProbeHasPlayableAudio(parsedBody)
        : useOpenRouterProbe && capability === 'tts'
          ? (response.ok && (contentType.startsWith('audio/') || raw.length > 0))
          : undefined;
      const asyncTaskId = isMinimaxTts && normalizedApiType === MINIMAX_TTS_ASYNC_API_TYPE
        ? this.extractMinimaxAsyncTaskId(parsedBody)
        : useOpenRouterProbe && capability === 'video'
          ? (this.normalizeNullableString(parsedBody?.id, 128) || null)
          : null;
      let ok = response.ok;
      let message = response.ok ? '模型测试通过' : `上游返回 ${response.status} (${apiType})`;
      if (!response.ok && useOpenAiSttMultipartProbe && this.isNoSpeechFoundProbeResponse(raw)) {
        ok = true;
        message = '模型连通，测试音频未检测到语音';
      }
      if (isMinimaxTts && response.ok) {
        if (normalizedApiType === MINIMAX_TTS_SYNC_API_TYPE) {
          if (!audioDetected) {
            ok = false;
            message = '模型响应成功，但未检测到可播放音频（请检查 endpoint/output_format/voice_id）';
          } else {
            message = '模型测试通过（已检测到可播放音频）';
          }
        } else if (normalizedApiType === MINIMAX_TTS_ASYNC_API_TYPE) {
          if (!asyncTaskId) {
            ok = false;
            message = '异步任务创建失败：响应未返回 task_id';
          } else {
            message = `模型测试通过（异步任务已创建: ${asyncTaskId})`;
          }
        }
      }
      if (useOpenRouterProbe && response.ok) {
        if (capability === 'tts') {
          message = audioDetected ? '模型测试通过（已检测到音频响应）' : '模型响应成功，但未检测到音频内容';
          ok = !!audioDetected;
        } else if (capability === 'stt') {
          message = this.normalizeNullableString(parsedBody?.text, 256)
            ? '模型测试通过（已返回转写文本）'
            : '模型测试通过（测试音频未检测到语音）';
          ok = true;
        } else if (capability === 'video') {
          message = asyncTaskId ? `模型测试通过（异步任务已创建: ${asyncTaskId})` : '模型响应成功，但未返回视频任务 id';
          ok = !!asyncTaskId;
        }
      }

      return {
        ok,
        status_code: response.status,
        latency_ms: latencyMs,
        endpoint_url: endpointUrl,
        model_key: modelKey,
        upstream_model: upstreamModel,
        source_id: source.id,
        source_name: source.name,
        provider_type: source.provider_type,
        message,
        response_excerpt: responseExcerpt,
        audio_detected: audioDetected,
        async_task_id: asyncTaskId,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startedAt;
      const timedOut = error?.name === 'AbortError';
      return {
        ok: false,
        status_code: null,
        latency_ms: latencyMs,
        endpoint_url: endpointUrl,
        model_key: modelKey,
        upstream_model: upstreamModel,
        source_id: source.id,
        source_name: source.name,
        provider_type: source.provider_type,
        message: timedOut ? `连接超时（>${timeoutMs}ms）` : `连接失败：${error?.message || 'unknown error'}`,
        response_excerpt: '',
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async resolvePlaygroundRoute(payload: AiModelConnectivityTestInput): Promise<ResolvedAiRoute> {
    await this.ensureSchema();

    const appId = this.normalizeNullableUuid(payload.app_id);
    const appSlug = this.normalizeNullableString(payload.app_slug, 120);
    if (!appId || !appSlug) {
      throw new BadRequestException('app_id and app_slug are required for AI playground');
    }

    const modelId = String(payload.model_id || '').trim();
    const existingModel = modelId ? await this.getGlobalModelRowById(modelId) : null;
    if (modelId && !existingModel) {
      throw new NotFoundException('AI model not found');
    }

    const sourceId = String(payload.source_id || existingModel?.default_source_id || '').trim();
    if (!sourceId) {
      throw new BadRequestException('source_id is required');
    }
    const source = await this.getGlobalSourceById(sourceId);
    if (!source) {
      throw new NotFoundException('AI source not found');
    }
    const sourceRoute = existingModel
      ? await this.findGlobalModelSourceRouteForSource(existingModel.id, sourceId)
      : null;

    const modelKey = String(existingModel?.model_key || payload.upstream_model || 'adhoc-model').trim() || 'adhoc-model';
    const capability = existingModel
      ? this.normalizeCapability(existingModel.capability)
      : this.normalizeCapability(payload.capability || 'chat');
    const upstreamModel = String(
      payload.upstream_model || sourceRoute?.upstream_model || existingModel?.upstream_model || modelKey,
    ).trim();
    if (!upstreamModel) {
      throw new BadRequestException('upstream_model is required');
    }

    const requestedApiType = String(
      payload.api_type
      || sourceRoute?.api_type
      || existingModel?.api_type
      || (isRunningHubProviderType(source.provider_type) ? RUNNINGHUB_TASK_API_TYPE : 'openai-chat-completions'),
    ).trim();
    const apiType = this.resolveApiTypeForSource(requestedApiType, capability, source.provider_type, source.base_url, upstreamModel);
    const rawEndpointPath = this.normalizeEndpointPath(
      payload.endpoint_path
      || sourceRoute?.endpoint_path
      || existingModel?.endpoint_path
      || this.defaultEndpointPathForApiType(apiType, capability),
    );
    const providerAdjustedEndpointPath = this.normalizeEndpointPathForProvider(apiType, capability, rawEndpointPath);
    const normalizedEndpointPath = this.normalizeMinimaxEndpointPathForBase(
      source.provider_type,
      source.base_url,
      providerAdjustedEndpointPath,
    );
    const requestOverrides = {
      ...this.normalizeObject(existingModel?.request_overrides),
      ...this.normalizeObject(sourceRoute?.request_overrides),
      ...this.normalizeObject(payload.request_overrides),
    };

    return {
      app_id: appId,
      app_slug: appSlug,
      route_key: this.normalizeRouteKey(sourceRoute?.route_key || sourceRoute?.id || source.id),
      model_id: existingModel?.id || `adhoc:${modelKey}`,
      model_key: modelKey,
      display_name: String(existingModel?.display_name || modelKey),
      capability,
      execution_mode: this.normalizeExecutionMode(existingModel?.execution_mode),
      pricing_mode: this.normalizePricingMode(existingModel?.pricing_mode, capability),
      rmb_per_mtoken: this.normalizeRmbPerMToken(existingModel?.rmb_per_mtoken, 0),
      rmb_per_call: this.normalizeRmbPerCall(existingModel?.rmb_per_call, 0),
      rmb_per_minute: this.normalizeRmbPerMinute(existingModel?.rmb_per_minute, 0),
      input_rmb_per_mtoken: this.normalizeRmbPerMToken(existingModel?.input_rmb_per_mtoken, 0),
      cached_input_rmb_per_mtoken: this.normalizeRmbPerMToken(existingModel?.cached_input_rmb_per_mtoken, 0),
      cache_write_5m_rmb_per_mtoken: this.normalizeRmbPerMToken(existingModel?.cache_write_5m_rmb_per_mtoken, 0),
      cache_write_1h_rmb_per_mtoken: this.normalizeRmbPerMToken(existingModel?.cache_write_1h_rmb_per_mtoken, 0),
      output_rmb_per_mtoken: this.normalizeRmbPerMToken(existingModel?.output_rmb_per_mtoken, 0),
      points_per_mtoken: this.normalizePointsPerMToken(existingModel?.points_per_mtoken, 0),
      points_per_call: this.normalizePointsPerCall(existingModel?.points_per_call, 0),
      points_per_minute: this.normalizePointsPerMinute(existingModel?.points_per_minute, 0),
      points_input_per_mtoken: this.normalizePointsPerMToken(existingModel?.points_input_per_mtoken, 0),
      points_cached_input_per_mtoken: this.normalizePointsPerMToken(existingModel?.points_cached_input_per_mtoken, 0),
      points_cache_write_5m_per_mtoken: this.normalizePointsPerMToken(existingModel?.points_cache_write_5m_per_mtoken, 0),
      points_cache_write_1h_per_mtoken: this.normalizePointsPerMToken(existingModel?.points_cache_write_1h_per_mtoken, 0),
      points_output_per_mtoken: this.normalizePointsPerMToken(existingModel?.points_output_per_mtoken, 0),
      upstream_model: upstreamModel,
      endpoint_path: normalizedEndpointPath,
      api_type: apiType,
      request_overrides: requestOverrides,
      source: {
        id: source.id,
        name: source.name,
        provider_type: source.provider_type,
        base_url: source.base_url,
        api_key: source.api_key,
        custom_headers: this.normalizeStringObject(source.custom_headers),
        credentials: this.normalizeObject(source.credentials_json),
        outbound_proxy_id: source.outbound_proxy_id || null,
        is_active: source.is_active,
      },
    };
  }

  async listGlobalModels() {
    await this.ensureSchema();

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         m.*,
         s.name AS default_source_name,
         s.provider_type AS default_source_provider_type,
         s.base_url AS default_source_base_url,
         s.api_key AS default_source_api_key,
         s.custom_headers AS default_source_custom_headers,
         s.outbound_proxy_id AS default_source_outbound_proxy_id,
         s.is_active AS default_source_is_active
       FROM ai_global_models m
       JOIN ai_global_sources s ON s.id = m.default_source_id
       ORDER BY m.capability ASC, m.is_default DESC, m.created_at DESC`,
    ) as Promise<AiGlobalModelJoinedRow[]>);

    const sourceRouteMap = await this.listGlobalModelSourceRoutesMap(rows.map((row) => row.id));
    return rows.map((row) => this.serializeGlobalModel(row, sourceRouteMap.get(row.id) || []));
  }

  async createGlobalModel(actorUserId: string, payload: AiModelInput) {
    await this.ensureSchema();

    const modelKey = String(payload.model_key || '').trim();
    const capability = this.normalizeCapability(payload.capability);
    const executionMode = this.normalizeExecutionMode(payload.execution_mode);
    const pricingMode = this.normalizePricingMode(
      payload.pricing_mode,
      capability,
      payload.rmb_per_mtoken,
      payload.rmb_per_call,
      payload.rmb_per_minute,
    );
    const rmbPerMtoken = this.normalizeRmbPerMToken(payload.rmb_per_mtoken, 0);
    const rmbPerCall = this.normalizeRmbPerCall(payload.rmb_per_call, 0);
    const rmbPerMinute = this.normalizeRmbPerMinute(payload.rmb_per_minute, 0);
    const inputRmbPerMtoken = this.normalizeRmbPerMToken(payload.input_rmb_per_mtoken, 0);
    const cachedInputRmbPerMtoken = this.normalizeRmbPerMToken(payload.cached_input_rmb_per_mtoken, 0);
    const cacheWrite5mRmbPerMtoken = this.normalizeRmbPerMToken(payload.cache_write_5m_rmb_per_mtoken, 0);
    const cacheWrite1hRmbPerMtoken = this.normalizeRmbPerMToken(payload.cache_write_1h_rmb_per_mtoken, 0);
    const outputRmbPerMtoken = this.normalizeRmbPerMToken(payload.output_rmb_per_mtoken, 0);
    const pointsPerMtoken = this.normalizePointsPerMToken(payload.points_per_mtoken, 0);
    const pointsPerCall = this.normalizePointsPerCall(payload.points_per_call, 0);
    const pointsPerMinute = this.normalizePointsPerMinute(payload.points_per_minute, 0);
    const pointsInputPerMtoken = this.normalizePointsPerMToken(payload.points_input_per_mtoken, 0);
    const pointsCachedInputPerMtoken = this.normalizePointsPerMToken(payload.points_cached_input_per_mtoken, 0);
    const pointsCacheWrite5mPerMtoken = this.normalizePointsPerMToken(payload.points_cache_write_5m_per_mtoken, 0);
    const pointsCacheWrite1hPerMtoken = this.normalizePointsPerMToken(payload.points_cache_write_1h_per_mtoken, 0);
    const pointsOutputPerMtoken = this.normalizePointsPerMToken(payload.points_output_per_mtoken, 0);
    const sourceRouteInputs = this.normalizeModelSourceRouteInputs(payload.source_routes);
    const defaultSourceId = String(payload.default_source_id || sourceRouteInputs[0]?.source_id || '').trim();
    const displayName = String(payload.display_name || modelKey).trim();
    const upstreamModel = String(payload.upstream_model || modelKey).trim();
    const requestOverrides = this.normalizeObject(payload.request_overrides);
    const isDefault = !!payload.is_default;
    const isActive = payload.is_active !== false;
    const isVisible = payload.is_visible !== false;

    if (!modelKey) {
      throw new BadRequestException('model_key is required');
    }
    if (!displayName) {
      throw new BadRequestException('display_name is required');
    }
    if (!defaultSourceId) {
      throw new BadRequestException('default_source_id is required');
    }
    if (!upstreamModel) {
      throw new BadRequestException('upstream_model is required');
    }
    if (!this.isValidModelKey(modelKey)) {
      throw new BadRequestException('model_key contains invalid characters');
    }

    await this.ensureGlobalSourceExists(defaultSourceId);
    const defaultSource = await this.getGlobalSourceById(defaultSourceId);
    if (!defaultSource) {
      throw new NotFoundException('AI source not found');
    }
    for (const route of sourceRouteInputs) {
      await this.ensureGlobalSourceExists(route.source_id);
    }
    if (payload.source_routes !== undefined) {
      await this.ensureModelSourceRoutesTableReady();
    }

    const requestedApiType = String(
      payload.api_type || (isRunningHubProviderType(defaultSource.provider_type) ? RUNNINGHUB_TASK_API_TYPE : 'openai-chat-completions'),
    ).trim() || (isRunningHubProviderType(defaultSource.provider_type) ? RUNNINGHUB_TASK_API_TYPE : 'openai-chat-completions');
    const resolvedApiType = this.resolveApiTypeForSource(
      requestedApiType,
      capability,
      defaultSource.provider_type,
      defaultSource.base_url,
      upstreamModel,
    );
    if (isDefault && this.isVoiceCloneApiType(resolvedApiType)) {
      throw new BadRequestException('voice clone model cannot be the default TTS speech model');
    }
    const endpointPath = isRunningHubProviderType(defaultSource.provider_type)
      ? this.resolveRunningHubModelEndpointPath(payload.endpoint_path, upstreamModel)
      : this.normalizeEndpointPath(
          payload.endpoint_path || this.defaultEndpointPathForApiType(resolvedApiType, capability),
        );
    this.assertRunningHubEndpointPath(resolvedApiType, endpointPath, !!payload.endpoint_path);

    const duplicated = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM ai_global_models WHERE model_key = $1 LIMIT 1`,
      modelKey,
    ) as Promise<Array<{ id: string }>>);
    if (duplicated[0]) {
      throw new BadRequestException('model_key already exists');
    }

    if (isDefault) {
      await this.clearDefaultGlobalModels(undefined, capability);
    }

    const inserted = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_global_models (
         id, model_key, display_name, capability, execution_mode, pricing_mode,
         rmb_per_mtoken, rmb_per_call, rmb_per_minute,
         input_rmb_per_mtoken, cached_input_rmb_per_mtoken, cache_write_5m_rmb_per_mtoken, cache_write_1h_rmb_per_mtoken, output_rmb_per_mtoken,
         points_per_mtoken, points_per_call, points_per_minute,
         points_input_per_mtoken, points_cached_input_per_mtoken, points_cache_write_5m_per_mtoken, points_cache_write_1h_per_mtoken, points_output_per_mtoken,
         default_source_id, upstream_model, endpoint_path, api_type,
         request_overrides, is_default, is_active, is_visible, created_by_user_id, updated_by_user_id
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5,
         $6::numeric, $7::numeric, $8::numeric,
         $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric,
         $14::numeric, $15::numeric, $16::numeric,
         $17::numeric, $18::numeric, $19::numeric, $20::numeric, $21::numeric,
         $22::uuid, $23, $24, $25, $26::jsonb, $27, $28, $29, $30::uuid, $30::uuid
       )
       RETURNING *`,
      modelKey,
      displayName,
      capability,
      executionMode,
      pricingMode,
      rmbPerMtoken,
      rmbPerCall,
      rmbPerMinute,
      inputRmbPerMtoken,
      cachedInputRmbPerMtoken,
      cacheWrite5mRmbPerMtoken,
      cacheWrite1hRmbPerMtoken,
      outputRmbPerMtoken,
      pointsPerMtoken,
      pointsPerCall,
      pointsPerMinute,
      pointsInputPerMtoken,
      pointsCachedInputPerMtoken,
      pointsCacheWrite5mPerMtoken,
      pointsCacheWrite1hPerMtoken,
      pointsOutputPerMtoken,
      defaultSourceId,
      upstreamModel,
      endpointPath,
      resolvedApiType,
      JSON.stringify(requestOverrides),
      isDefault,
      isActive,
      isVisible,
      actorUserId,
    ) as Promise<AiGlobalModelRow[]>);

    await this.replaceGlobalModelSourceRoutesIfProvided(inserted[0].id, actorUserId, payload.source_routes, {
      default_source_id: defaultSourceId,
      upstream_model: upstreamModel,
      endpoint_path: endpointPath,
      api_type: resolvedApiType,
    });

    this.clearResolvedRouteCache();
    return this.getGlobalModelById(inserted[0].id);
  }

  async updateGlobalModel(modelId: string, actorUserId: string, payload: AiModelInput) {
    await this.ensureSchema();

    const existing = await this.getGlobalModelRowById(modelId);
    if (!existing) {
      throw new NotFoundException('AI model not found');
    }

    const nextModelKey = payload.model_key === undefined ? existing.model_key : String(payload.model_key).trim();
    const nextDisplayName = payload.display_name === undefined ? existing.display_name : String(payload.display_name).trim();
    const nextCapability = this.normalizeCapability(payload.capability ?? existing.capability);
    const nextExecutionMode = this.normalizeExecutionMode(payload.execution_mode ?? existing.execution_mode);
    const nextPricingMode = this.normalizePricingMode(
      payload.pricing_mode ?? existing.pricing_mode,
      nextCapability,
      payload.rmb_per_mtoken === undefined ? existing.rmb_per_mtoken : payload.rmb_per_mtoken,
      payload.rmb_per_call === undefined ? existing.rmb_per_call : payload.rmb_per_call,
      payload.rmb_per_minute === undefined ? existing.rmb_per_minute : payload.rmb_per_minute,
    );
    const nextRmbPerMtoken =
      payload.rmb_per_mtoken === undefined
        ? this.normalizeRmbPerMToken(existing.rmb_per_mtoken, 0)
        : this.normalizeRmbPerMToken(payload.rmb_per_mtoken, 0);
    const nextRmbPerCall =
      payload.rmb_per_call === undefined
        ? this.normalizeRmbPerCall(existing.rmb_per_call, 0)
        : this.normalizeRmbPerCall(payload.rmb_per_call, 0);
    const nextRmbPerMinute =
      payload.rmb_per_minute === undefined
        ? this.normalizeRmbPerMinute(existing.rmb_per_minute, 0)
        : this.normalizeRmbPerMinute(payload.rmb_per_minute, 0);
    const nextInputRmbPerMtoken =
      payload.input_rmb_per_mtoken === undefined
        ? this.normalizeRmbPerMToken(existing.input_rmb_per_mtoken, 0)
        : this.normalizeRmbPerMToken(payload.input_rmb_per_mtoken, 0);
    const nextCachedInputRmbPerMtoken =
      payload.cached_input_rmb_per_mtoken === undefined
        ? this.normalizeRmbPerMToken(existing.cached_input_rmb_per_mtoken, 0)
        : this.normalizeRmbPerMToken(payload.cached_input_rmb_per_mtoken, 0);
    const nextCacheWrite5mRmbPerMtoken =
      payload.cache_write_5m_rmb_per_mtoken === undefined
        ? this.normalizeRmbPerMToken(existing.cache_write_5m_rmb_per_mtoken, 0)
        : this.normalizeRmbPerMToken(payload.cache_write_5m_rmb_per_mtoken, 0);
    const nextCacheWrite1hRmbPerMtoken =
      payload.cache_write_1h_rmb_per_mtoken === undefined
        ? this.normalizeRmbPerMToken(existing.cache_write_1h_rmb_per_mtoken, 0)
        : this.normalizeRmbPerMToken(payload.cache_write_1h_rmb_per_mtoken, 0);
    const nextOutputRmbPerMtoken =
      payload.output_rmb_per_mtoken === undefined
        ? this.normalizeRmbPerMToken(existing.output_rmb_per_mtoken, 0)
        : this.normalizeRmbPerMToken(payload.output_rmb_per_mtoken, 0);
    const nextPointsPerMtoken =
      payload.points_per_mtoken === undefined
        ? this.normalizePointsPerMToken(existing.points_per_mtoken, 0)
        : this.normalizePointsPerMToken(payload.points_per_mtoken, 0);
    const nextPointsPerCall =
      payload.points_per_call === undefined
        ? this.normalizePointsPerCall(existing.points_per_call, 0)
        : this.normalizePointsPerCall(payload.points_per_call, 0);
    const nextPointsPerMinute =
      payload.points_per_minute === undefined
        ? this.normalizePointsPerMinute(existing.points_per_minute, 0)
        : this.normalizePointsPerMinute(payload.points_per_minute, 0);
    const nextPointsInputPerMtoken =
      payload.points_input_per_mtoken === undefined
        ? this.normalizePointsPerMToken(existing.points_input_per_mtoken, 0)
        : this.normalizePointsPerMToken(payload.points_input_per_mtoken, 0);
    const nextPointsCachedInputPerMtoken =
      payload.points_cached_input_per_mtoken === undefined
        ? this.normalizePointsPerMToken(existing.points_cached_input_per_mtoken, 0)
        : this.normalizePointsPerMToken(payload.points_cached_input_per_mtoken, 0);
    const nextPointsCacheWrite5mPerMtoken =
      payload.points_cache_write_5m_per_mtoken === undefined
        ? this.normalizePointsPerMToken(existing.points_cache_write_5m_per_mtoken, 0)
        : this.normalizePointsPerMToken(payload.points_cache_write_5m_per_mtoken, 0);
    const nextPointsCacheWrite1hPerMtoken =
      payload.points_cache_write_1h_per_mtoken === undefined
        ? this.normalizePointsPerMToken(existing.points_cache_write_1h_per_mtoken, 0)
        : this.normalizePointsPerMToken(payload.points_cache_write_1h_per_mtoken, 0);
    const nextPointsOutputPerMtoken =
      payload.points_output_per_mtoken === undefined
        ? this.normalizePointsPerMToken(existing.points_output_per_mtoken, 0)
        : this.normalizePointsPerMToken(payload.points_output_per_mtoken, 0);
    const sourceRouteInputs = this.normalizeModelSourceRouteInputs(payload.source_routes);
    const nextDefaultSourceId =
      payload.default_source_id === undefined
        ? (sourceRouteInputs[0]?.source_id || existing.default_source_id)
        : String(payload.default_source_id || sourceRouteInputs[0]?.source_id || '').trim();
    const nextUpstreamModel =
      payload.upstream_model === undefined ? existing.upstream_model : String(payload.upstream_model).trim();
    const nextApiType = payload.api_type === undefined ? existing.api_type : String(payload.api_type).trim();
    const defaultEndpoint = this.defaultEndpointPathForApiType(nextApiType, nextCapability);
    const existingCapability = this.normalizeCapability(existing.capability);
    const existingCapabilityDefaultEndpoint = this.defaultEndpointPathForCapability(existingCapability);
    const normalizedExistingEndpoint = this.normalizeEndpointPath(
      existing.endpoint_path || existingCapabilityDefaultEndpoint,
    );
    const shouldResetEndpointToApiTypeDefault =
      normalizedExistingEndpoint === existingCapabilityDefaultEndpoint || normalizedExistingEndpoint === '/audio/speech';
    const nextEndpointPath =
      payload.endpoint_path === undefined
        ? this.normalizeEndpointPath(
            shouldResetEndpointToApiTypeDefault ? defaultEndpoint : existing.endpoint_path || defaultEndpoint,
          )
        : this.normalizeEndpointPath(payload.endpoint_path || defaultEndpoint);
    const nextRequestOverrides =
      payload.request_overrides === undefined
        ? this.normalizeObject(existing.request_overrides)
        : this.normalizeObject(payload.request_overrides);
    const nextIsDefault = payload.is_default === undefined ? existing.is_default : !!payload.is_default;
    const nextIsActive = payload.is_active === undefined ? existing.is_active : !!payload.is_active;
    const nextIsVisible = payload.is_visible === undefined ? existing.is_visible : !!payload.is_visible;

    if (!nextModelKey) {
      throw new BadRequestException('model_key is required');
    }
    if (!nextDisplayName) {
      throw new BadRequestException('display_name is required');
    }
    if (!nextDefaultSourceId) {
      throw new BadRequestException('default_source_id is required');
    }
    if (!nextUpstreamModel) {
      throw new BadRequestException('upstream_model is required');
    }
    if (!this.isValidModelKey(nextModelKey)) {
      throw new BadRequestException('model_key contains invalid characters');
    }

    await this.ensureGlobalSourceExists(nextDefaultSourceId);
    const nextDefaultSource = await this.getGlobalSourceById(nextDefaultSourceId);
    if (!nextDefaultSource) {
      throw new NotFoundException('AI source not found');
    }
    for (const route of sourceRouteInputs) {
      await this.ensureGlobalSourceExists(route.source_id);
    }
    if (payload.source_routes !== undefined) {
      await this.ensureModelSourceRoutesTableReady();
    }

    const nextResolvedApiType = this.resolveApiTypeForSource(
      nextApiType || (isRunningHubProviderType(nextDefaultSource.provider_type) ? RUNNINGHUB_TASK_API_TYPE : 'openai-chat-completions'),
      nextCapability,
      nextDefaultSource.provider_type,
      nextDefaultSource.base_url,
      nextUpstreamModel,
    );
    if (nextIsDefault && this.isVoiceCloneApiType(nextResolvedApiType)) {
      throw new BadRequestException('voice clone model cannot be the default TTS speech model');
    }
    const normalizedNextEndpointPath = isRunningHubProviderType(nextDefaultSource.provider_type)
      ? this.resolveRunningHubModelEndpointPath(nextEndpointPath, nextUpstreamModel)
      : this.normalizeEndpointPath(nextEndpointPath);
    this.assertRunningHubEndpointPath(nextResolvedApiType, normalizedNextEndpointPath, payload.endpoint_path !== undefined);

    const duplicated = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM ai_global_models WHERE model_key = $1 AND id <> $2::uuid LIMIT 1`,
      nextModelKey,
      modelId,
    ) as Promise<Array<{ id: string }>>);
    if (duplicated[0]) {
      throw new BadRequestException('model_key already exists');
    }

    if (nextIsDefault) {
      await this.clearDefaultGlobalModels(modelId, nextCapability);
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_global_models
       SET model_key = $1,
           display_name = $2,
           capability = $3,
           execution_mode = $4,
           pricing_mode = $5,
           rmb_per_mtoken = $6::numeric,
           rmb_per_call = $7::numeric,
           rmb_per_minute = $8::numeric,
           input_rmb_per_mtoken = $9::numeric,
           cached_input_rmb_per_mtoken = $10::numeric,
           cache_write_5m_rmb_per_mtoken = $11::numeric,
           cache_write_1h_rmb_per_mtoken = $12::numeric,
           output_rmb_per_mtoken = $13::numeric,
           points_per_mtoken = $14::numeric,
           points_per_call = $15::numeric,
           points_per_minute = $16::numeric,
           points_input_per_mtoken = $17::numeric,
           points_cached_input_per_mtoken = $18::numeric,
           points_cache_write_5m_per_mtoken = $19::numeric,
           points_cache_write_1h_per_mtoken = $20::numeric,
           points_output_per_mtoken = $21::numeric,
           default_source_id = $22::uuid,
           upstream_model = $23,
           endpoint_path = $24,
           api_type = $25,
           request_overrides = $26::jsonb,
           is_default = $27,
           is_active = $28,
           is_visible = $29,
           updated_by_user_id = $30::uuid,
           updated_at = now()
       WHERE id = $31::uuid`,
      nextModelKey,
      nextDisplayName,
      nextCapability,
      nextExecutionMode,
      nextPricingMode,
      nextRmbPerMtoken,
      nextRmbPerCall,
      nextRmbPerMinute,
      nextInputRmbPerMtoken,
      nextCachedInputRmbPerMtoken,
      nextCacheWrite5mRmbPerMtoken,
      nextCacheWrite1hRmbPerMtoken,
      nextOutputRmbPerMtoken,
      nextPointsPerMtoken,
      nextPointsPerCall,
      nextPointsPerMinute,
      nextPointsInputPerMtoken,
      nextPointsCachedInputPerMtoken,
      nextPointsCacheWrite5mPerMtoken,
      nextPointsCacheWrite1hPerMtoken,
      nextPointsOutputPerMtoken,
      nextDefaultSourceId,
      nextUpstreamModel,
      normalizedNextEndpointPath,
      nextResolvedApiType,
      JSON.stringify(nextRequestOverrides),
      nextIsDefault,
      nextIsActive,
      nextIsVisible,
      actorUserId,
      modelId,
    );

    await this.replaceGlobalModelSourceRoutesIfProvided(modelId, actorUserId, payload.source_routes, {
      default_source_id: nextDefaultSourceId,
      upstream_model: nextUpstreamModel,
      endpoint_path: normalizedNextEndpointPath,
      api_type: nextResolvedApiType,
    });

    this.clearResolvedRouteCache();
    return this.getGlobalModelById(modelId);
  }

  async deleteGlobalModel(modelId: string) {
    await this.ensureSchema();

    const existing = await this.getGlobalModelRowById(modelId);
    if (!existing) {
      throw new NotFoundException('AI model not found');
    }

    const usageRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM ai_usage_logs WHERE global_model_id = $1::uuid`,
      modelId,
    ) as Promise<Array<{ count: bigint }>>);
    const usageCount = Number(usageRows[0]?.count || 0);

    await this.prisma.$executeRawUnsafe(`DELETE FROM ai_app_model_routes WHERE global_model_id = $1::uuid`, modelId);
    await this.prisma.$executeRawUnsafe(`DELETE FROM ai_app_capability_defaults WHERE global_model_id = $1::uuid`, modelId);

    if (usageCount > 0) {
      const archivedModelKey = this.buildArchivedModelKey(existing.model_key, modelId);
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_global_models
         SET model_key = $1,
             is_default = false,
             is_active = false,
             is_visible = false,
             updated_at = now()
         WHERE id = $2::uuid`,
        archivedModelKey,
        modelId,
      );
      this.clearResolvedRouteCache();
      return {
        deleted: true,
        archived: true,
        archived_reason: 'usage_logs_exist',
        usage_log_count: usageCount,
      };
    }

    const deleted = await this.prisma.$executeRawUnsafe(`DELETE FROM ai_global_models WHERE id = $1::uuid`, modelId);
    if (!deleted) {
      throw new NotFoundException('AI model not found');
    }
    this.clearResolvedRouteCache();
    return { deleted: true, archived: false };
  }

  async listGlobalModelSourceRoutes(modelId: string) {
    await this.ensureSchema();
    await this.ensureModelSourceRoutesTableReady();
    await this.ensureGlobalModelExists(modelId);
    return {
      items: this.serializeModelSourceRoutes(await this.listModelSourceRoutes(modelId, null, true)),
    };
  }

  async replaceGlobalModelSourceRoutes(modelId: string, actorUserId: string, payload: { items?: AiModelSourceRouteInput[] }) {
    await this.ensureSchema();
    await this.ensureModelSourceRoutesTableReady();
    const model = await this.getGlobalModelRowById(modelId);
    if (!model) {
      throw new NotFoundException('AI model not found');
    }
    const routes = await this.replaceModelSourceRoutes(modelId, null, actorUserId, payload?.items || [], {
      default_source_id: model.default_source_id,
      upstream_model: model.upstream_model,
      endpoint_path: model.endpoint_path,
      api_type: model.api_type,
    });
    const primarySourceId = routes.find((item) => item.is_active && item.source_is_active)?.source_id || routes[0]?.source_id;
    if (primarySourceId && primarySourceId !== model.default_source_id) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_global_models
         SET default_source_id = $1::uuid,
             updated_by_user_id = $2::uuid,
             updated_at = now()
         WHERE id = $3::uuid`,
        primarySourceId,
        actorUserId,
        modelId,
      );
    }
    this.clearResolvedRouteCache();
    return {
      items: this.serializeModelSourceRoutes(routes),
    };
  }

  async listAppModelRoutes(appId: string) {
    await this.ensureSchema();
    await this.ensureAppById(appId);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         m.id AS model_id,
         m.model_key,
         m.display_name AS model_display_name,
         m.capability AS model_capability,
         m.execution_mode AS model_execution_mode,
         m.pricing_mode AS model_pricing_mode,
         m.rmb_per_mtoken AS model_rmb_per_mtoken,
         m.rmb_per_call AS model_rmb_per_call,
         m.rmb_per_minute AS model_rmb_per_minute,
         m.input_rmb_per_mtoken AS model_input_rmb_per_mtoken,
         m.cached_input_rmb_per_mtoken AS model_cached_input_rmb_per_mtoken,
         m.cache_write_5m_rmb_per_mtoken AS model_cache_write_5m_rmb_per_mtoken,
         m.cache_write_1h_rmb_per_mtoken AS model_cache_write_1h_rmb_per_mtoken,
         m.output_rmb_per_mtoken AS model_output_rmb_per_mtoken,
         m.points_per_mtoken AS model_points_per_mtoken,
         m.points_per_call AS model_points_per_call,
         m.points_per_minute AS model_points_per_minute,
         m.points_input_per_mtoken AS model_points_input_per_mtoken,
         m.points_cached_input_per_mtoken AS model_points_cached_input_per_mtoken,
         m.points_cache_write_5m_per_mtoken AS model_points_cache_write_5m_per_mtoken,
         m.points_cache_write_1h_per_mtoken AS model_points_cache_write_1h_per_mtoken,
         m.points_output_per_mtoken AS model_points_output_per_mtoken,
         m.upstream_model AS model_upstream_model,
         m.endpoint_path AS model_endpoint_path,
         m.api_type AS model_api_type,
         m.request_overrides AS model_request_overrides,
         m.is_default AS model_is_default,
         m.is_active AS model_is_active,
         m.is_visible AS model_is_visible,
         ds.id AS default_source_id,
         ds.name AS default_source_name,
         ds.provider_type AS default_source_provider_type,
         ds.is_active AS default_source_is_active,
         r.id AS route_id,
         r.source_id AS route_source_id,
         rs.name AS route_source_name,
         rs.provider_type AS route_source_provider_type,
         rs.is_active AS route_source_is_active,
         r.is_active AS route_is_active,
         r.request_overrides AS route_request_overrides,
         r.updated_at AS route_updated_at
       FROM ai_global_models m
       JOIN ai_global_sources ds ON ds.id = m.default_source_id
       LEFT JOIN ai_app_model_routes r ON r.global_model_id = m.id AND r.app_id = $1::uuid
       LEFT JOIN ai_global_sources rs ON rs.id = r.source_id
      ORDER BY m.is_default DESC, m.model_key ASC`,
      appId,
    ) as Promise<AiAppModelRouteJoinedRow[]>);

    return {
      items: rows.map((row) => this.serializeAppModelRoute(row)),
    };
  }

  async listAppCapabilityDefaults(appId: string) {
    await this.ensureSchema();
    await this.ensureAppById(appId);

    const appOverrideRows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         d.*,
         m.model_key,
         m.display_name AS model_display_name,
         m.capability AS model_capability,
         m.is_active AS model_is_active
       FROM ai_app_capability_defaults d
       JOIN ai_global_models m ON m.id = d.global_model_id
       WHERE d.app_id = $1::uuid`,
      appId,
    ) as Promise<AiAppCapabilityDefaultJoinedRow[]>);

    const globalDefaultRows = await (this.prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (capability) *
       FROM ai_global_models
       WHERE is_active = true
       ORDER BY capability, is_default DESC, updated_at DESC`,
    ) as Promise<AiGlobalModelRow[]>);

    const appOverrideByCapability = new Map<string, AiAppCapabilityDefaultJoinedRow>();
    appOverrideRows.forEach((row) => {
      const capability = this.normalizeCapability(row.capability);
      appOverrideByCapability.set(capability, row);
    });

    const globalDefaultByCapability = new Map<string, AiGlobalModelRow>();
    globalDefaultRows.forEach((row) => {
      const capability = this.normalizeCapability(row.capability);
      globalDefaultByCapability.set(capability, row);
    });

    return {
      items: AI_CAPABILITIES.map((capability) => {
        const appOverride = appOverrideByCapability.get(capability);
        const validAppOverride =
          appOverride &&
          appOverride.model_is_active &&
          this.normalizeCapability(appOverride.model_capability) === capability
            ? appOverride
            : null;
        const globalDefault = globalDefaultByCapability.get(capability) || null;
        const effective = validAppOverride
          ? {
              model_id: validAppOverride.global_model_id,
              model_key: validAppOverride.model_key,
              display_name: validAppOverride.model_display_name,
            }
          : globalDefault
            ? {
                model_id: globalDefault.id,
                model_key: globalDefault.model_key,
                display_name: globalDefault.display_name,
              }
            : null;

        return {
          capability,
          effective_model: effective,
          source: validAppOverride ? 'app' : globalDefault ? 'global' : 'none',
          app_override: appOverride
            ? {
                model_id: appOverride.global_model_id,
                model_key: appOverride.model_key,
                display_name: appOverride.model_display_name,
                is_active: appOverride.model_is_active,
              }
            : null,
          global_default: globalDefault
            ? {
                model_id: globalDefault.id,
                model_key: globalDefault.model_key,
                display_name: globalDefault.display_name,
              }
            : null,
        };
      }),
    };
  }

  async listAppDefaultModelSlots(appId: string) {
    await this.ensureSchema();
    await this.ensureAppById(appId);
    return this.listAppDefaultModelSlotsForAppId(appId);
  }

  async listAppDefaultModelSlotsBySlug(appSlug: string) {
    await this.ensureSchema();
    const app = await this.ensureAppBySlug(appSlug);
    return this.listAppDefaultModelSlotsForAppId(app.id);
  }

  async upsertAppDefaultModelSlot(
    appId: string,
    slotInput: string,
    actorUserId: string,
    payload: AiAppDefaultModelSlotInput,
  ) {
    await this.ensureSchema();
    await this.ensureAppById(appId);
    const slotKey = this.normalizeAppDefaultModelSlot(slotInput);
    const primaryModelId = this.normalizeNullableModelId(payload.primary_model_id);
    const fallbackModelId = this.normalizeNullableModelId(payload.fallback_model_id);

    if (primaryModelId) {
      await this.ensureModelAllowedForDefaultSlot(primaryModelId, slotKey, 'primary_model_id');
    }
    if (fallbackModelId) {
      await this.ensureModelAllowedForDefaultSlot(fallbackModelId, slotKey, 'fallback_model_id');
    }
    if (primaryModelId && fallbackModelId && primaryModelId === fallbackModelId) {
      throw new BadRequestException('fallback_model_id must be different from primary_model_id');
    }

    if (!primaryModelId && !fallbackModelId) {
      await this.deleteAppDefaultModelSlot(appId, slotKey);
      return (await this.listAppDefaultModelSlotsForAppId(appId)).items.find((item: any) => item.slot_key === slotKey);
    }

    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_app_default_model_slots WHERE app_id = $1::uuid AND slot_key = $2 LIMIT 1`,
      appId,
      slotKey,
    ) as Promise<AiAppDefaultModelSlotRow[]>);

    if (existing[0]) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_app_default_model_slots
         SET primary_global_model_id = $1::uuid,
             fallback_global_model_id = $2::uuid,
             updated_by_user_id = $3::uuid,
             updated_at = now()
         WHERE id = $4::uuid`,
        primaryModelId,
        fallbackModelId,
        actorUserId,
        existing[0].id,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO ai_app_default_model_slots (
           id, app_id, slot_key, primary_global_model_id, fallback_global_model_id, created_by_user_id, updated_by_user_id
         )
         VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $5::uuid)`,
        appId,
        slotKey,
        primaryModelId,
        fallbackModelId,
        actorUserId,
      );
    }

    this.clearResolvedRouteCache();
    const slots = await this.listAppDefaultModelSlotsForAppId(appId);
    return slots.items.find((item: any) => item.slot_key === slotKey);
  }

  async deleteAppDefaultModelSlot(appId: string, slotInput: string) {
    await this.ensureSchema();
    await this.ensureAppById(appId);
    const slotKey = this.normalizeAppDefaultModelSlot(slotInput);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM ai_app_default_model_slots WHERE app_id = $1::uuid AND slot_key = $2`,
      appId,
      slotKey,
    );
    this.clearResolvedRouteCache();
    return { deleted: true };
  }

  async upsertAppModelRoute(appId: string, globalModelId: string, actorUserId: string, payload: AiAppModelRouteInput) {
    await this.ensureSchema();
    await this.ensureAppById(appId);

    const model = await this.getGlobalModelRowById(globalModelId);
    if (!model) {
      throw new NotFoundException('Global AI model not found');
    }

    const sourceId = String(payload.source_id || '').trim();
    if (!sourceId) {
      throw new BadRequestException('source_id is required');
    }
    await this.ensureGlobalSourceExists(sourceId);

    const isActive = payload.is_active !== false;
    const requestOverrides = this.normalizeObject(payload.request_overrides);

    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_app_model_routes WHERE app_id = $1::uuid AND global_model_id = $2::uuid LIMIT 1`,
      appId,
      globalModelId,
    ) as Promise<AiAppModelRouteRow[]>);

    if (existing[0]) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_app_model_routes
         SET source_id = $1::uuid,
             is_active = $2,
             request_overrides = $3::jsonb,
             updated_by_user_id = $4::uuid,
             updated_at = now()
         WHERE id = $5::uuid`,
        sourceId,
        isActive,
        JSON.stringify(requestOverrides),
        actorUserId,
        existing[0].id,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO ai_app_model_routes (
           id, app_id, global_model_id, source_id, is_active, request_overrides, created_by_user_id, updated_by_user_id
         )
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::uuid, $6::uuid)`,
        appId,
        globalModelId,
        sourceId,
        isActive,
        JSON.stringify(requestOverrides),
        actorUserId,
      );
    }

    const routes = await this.listAppModelRoutes(appId);
    this.clearResolvedRouteCache();
    const matched = routes.items.find((item: any) => item.model_id === globalModelId);
    if (!matched) {
      throw new NotFoundException('App model route not found after save');
    }
    return matched;
  }

  async deleteAppModelRoute(appId: string, globalModelId: string) {
    await this.ensureSchema();
    await this.ensureAppById(appId);

    const deleted = await this.prisma.$executeRawUnsafe(
      `DELETE FROM ai_app_model_routes WHERE app_id = $1::uuid AND global_model_id = $2::uuid`,
      appId,
      globalModelId,
    );
    if (!deleted) {
      throw new NotFoundException('App model route override not found');
    }
    this.clearResolvedRouteCache();
    return { deleted: true };
  }

  async upsertAppCapabilityDefault(
    appId: string,
    capabilityInput: string,
    actorUserId: string,
    payload: AiAppCapabilityDefaultInput,
  ) {
    await this.ensureSchema();
    await this.ensureAppById(appId);
    const capability = this.normalizeCapability(capabilityInput);
    const modelId = String(payload.model_id || '').trim();
    if (!modelId) {
      throw new BadRequestException('model_id is required');
    }

    const model = await this.getGlobalModelRowById(modelId);
    if (!model) {
      throw new NotFoundException('Global AI model not found');
    }
    if (!model.is_active) {
      throw new BadRequestException('model must be active');
    }
    if (this.normalizeCapability(model.capability) !== capability) {
      throw new BadRequestException(`model capability mismatch: expected ${capability}`);
    }

    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM ai_app_capability_defaults
       WHERE app_id = $1::uuid AND capability = $2
       LIMIT 1`,
      appId,
      capability,
    ) as Promise<AiAppCapabilityDefaultRow[]>);

    if (existing[0]) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_app_capability_defaults
         SET global_model_id = $1::uuid,
             updated_by_user_id = $2::uuid,
             updated_at = now()
         WHERE id = $3::uuid`,
        modelId,
        actorUserId,
        existing[0].id,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO ai_app_capability_defaults (
           id, app_id, capability, global_model_id, created_by_user_id, updated_by_user_id
         )
         VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $4::uuid)`,
        appId,
        capability,
        modelId,
        actorUserId,
      );
    }

    const defaults = await this.listAppCapabilityDefaults(appId);
    this.clearResolvedRouteCache();
    const matched = defaults.items.find((item: any) => item.capability === capability);
    if (!matched) {
      throw new NotFoundException('App capability default not found after save');
    }
    return matched;
  }

  async deleteAppCapabilityDefault(appId: string, capabilityInput: string) {
    await this.ensureSchema();
    await this.ensureAppById(appId);
    const capability = this.normalizeCapability(capabilityInput);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM ai_app_capability_defaults WHERE app_id = $1::uuid AND capability = $2`,
      appId,
      capability,
    );
    this.clearResolvedRouteCache();
    return { deleted: true };
  }

  async recordUsage(input: AiUsageLogInput) {
    await this.ensureSchema();

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_usage_logs (
         id, app_id, app_slug, user_id, global_model_id, model_key, upstream_model, capability,
         source_id, source_name, provider_type, endpoint_path, request_path, request_id, is_stream,
         success, error_message, prompt_tokens, completion_tokens, total_tokens,
         uncached_input_tokens, cached_input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
         cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
         unit_price_rmb_per_mtoken, unit_price_rmb_per_call, unit_price_rmb_per_minute, unit_price_mode,
         unit_price_rmb_input_per_mtoken, unit_price_rmb_cached_input_per_mtoken,
         unit_price_rmb_cache_write_5m_per_mtoken, unit_price_rmb_cache_write_1h_per_mtoken,
         unit_price_rmb_output_per_mtoken,
         billed_input_tokens, billed_cached_input_tokens, billed_cache_write_tokens, billed_output_tokens,
         billed_units, billed_unit_label, billed_duration_seconds, estimated_cost_rmb, points_cost, points_pricing_source,
         usage_reference_id, latency_ms, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7,
         $8::uuid, $9, $10, $11, $12, $13, $14,
         $15, $16, $17::bigint, $18::bigint, $19::bigint,
         $20::bigint, $21::bigint, $22::bigint, $23::bigint,
         $24::bigint, $25::bigint,
         $26::numeric, $27::numeric, $28::numeric, $29,
         $30::numeric, $31::numeric, $32::numeric, $33::numeric, $34::numeric,
         $35::bigint, $36::bigint, $37::bigint, $38::bigint,
         $39::numeric, $40, $41::bigint, $42::numeric, $43::numeric,
         $44, $45, $46::int, now()
       )`,
      input.app_id,
      String(input.app_slug || '').trim().toLowerCase(),
      this.normalizeNullableUuid(input.user_id),
      input.global_model_id,
      String(input.model_key || ''),
      String(input.upstream_model || ''),
      this.normalizeCapability(String(input.capability || 'chat')),
      input.source_id,
      String(input.source_name || ''),
      String(input.provider_type || ''),
      this.normalizeEndpointPath(String(input.endpoint_path || '/chat/completions')),
      this.normalizeNullableString(input.request_path),
      this.normalizeNullableString(input.request_id),
      input.is_stream === true,
      input.success === true,
      this.normalizeNullableString(input.error_message, 1024),
      this.normalizeNullableBigInt(input.prompt_tokens),
      this.normalizeNullableBigInt(input.completion_tokens),
      this.normalizeNullableBigInt(input.total_tokens),
      this.normalizeNullableBigInt(input.uncached_input_tokens),
      this.normalizeNullableBigInt(input.cached_input_tokens),
      this.normalizeNullableBigInt(input.cache_read_input_tokens),
      this.normalizeNullableBigInt(input.cache_creation_input_tokens),
      this.normalizeNullableBigInt(input.cache_creation_5m_input_tokens),
      this.normalizeNullableBigInt(input.cache_creation_1h_input_tokens),
      this.normalizeRmbPerMToken(input.unit_price_rmb_per_mtoken, 0),
      this.normalizeRmbPerCall(input.unit_price_rmb_per_call, 0),
      this.normalizeRmbPerMinute(input.unit_price_rmb_per_minute, 0),
      this.normalizePricingMode(input.unit_price_mode),
      this.normalizeRmbPerMToken(input.unit_price_rmb_input_per_mtoken, 0),
      this.normalizeRmbPerMToken(input.unit_price_rmb_cached_input_per_mtoken, 0),
      this.normalizeRmbPerMToken(input.unit_price_rmb_cache_write_5m_per_mtoken, 0),
      this.normalizeRmbPerMToken(input.unit_price_rmb_cache_write_1h_per_mtoken, 0),
      this.normalizeRmbPerMToken(input.unit_price_rmb_output_per_mtoken, 0),
      this.normalizeNullableBigInt(input.billed_input_tokens),
      this.normalizeNullableBigInt(input.billed_cached_input_tokens),
      this.normalizeNullableBigInt(input.billed_cache_write_tokens),
      this.normalizeNullableBigInt(input.billed_output_tokens),
      this.normalizeNullableDecimal(input.billed_units),
      this.normalizeNullableString(input.billed_unit_label, 32),
      this.normalizeNullableBigInt(input.billed_duration_seconds),
      this.normalizeCostRmb(input.estimated_cost_rmb, 0),
      this.normalizeNullableDecimal(input.points_cost),
      this.normalizeNullableString(input.points_pricing_source, 64),
      this.normalizeNullableString(input.usage_reference_id, 128),
      this.normalizeNullableInt(input.latency_ms),
    );
  }

  async updateUsagePointsSettlement(input: {
    usage_reference_id: string;
    points_cost: number;
    points_pricing_source?: string | null;
  }) {
    await this.ensureSchema();
    const usageReferenceId = this.normalizeNullableString(input.usage_reference_id, 128);
    if (!usageReferenceId) {
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_usage_logs
       SET
         points_cost = $2::numeric,
         points_pricing_source = $3,
         usage_reference_id = $1,
         created_at = created_at
       WHERE usage_reference_id = $1`,
      usageReferenceId,
      this.normalizeNullableDecimal(input.points_cost ?? 0) ?? 0,
      this.normalizeNullableString(input.points_pricing_source, 64),
    );
  }

  async hasUsageReference(usageReferenceIdInput: string): Promise<boolean> {
    await this.ensureSchema();
    const usageReferenceId = this.normalizeNullableString(usageReferenceIdInput, 128);
    if (!usageReferenceId) {
      return false;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM ai_usage_logs WHERE usage_reference_id = $1 LIMIT 1`,
      usageReferenceId,
    ) as Promise<Array<{ id: string }>>);
    return !!rows[0];
  }

  async getUsageSummary(query: AiUsageSummaryQueryInput = {}) {
    await this.ensureSchema();
    const { from, to } = this.resolveUsageRange(query);
    if (this.normalizeUsageSuccess(query.success) !== null) {
      return this.getUsageSummaryFromLogs(query, from, to);
    }
    await this.prepareUsageFactsForRead(from, to);
    return this.getUsageSummaryFromFacts(query, from, to);
  }

  async getUsageBreakdown(query: AiUsageSummaryQueryInput = {}) {
    await this.ensureSchema();
    const { from, to } = this.resolveUsageRange(query);
    if (this.normalizeUsageSuccess(query.success) !== null) {
      return this.getUsageBreakdownFromLogs(query, from, to);
    }
    await this.prepareUsageFactsForRead(from, to);
    return this.getUsageBreakdownFromFacts(query, from, to);
  }

  private async getUsageSummaryFromLogs(query: AiUsageSummaryQueryInput, from: Date, to: Date) {
    const { days } = this.resolveUsageRange(query);
    const where = this.buildUsageWhereClause(query, from, to);
    const whereL = this.buildUsageWhereClause(query, from, to, 'l');

    const overviewRows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::bigint AS requests_total,
         SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
         SUM(CASE WHEN l.success THEN 0 ELSE 1 END)::bigint AS error_total,
         COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
         COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
         COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
         COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
         COUNT(DISTINCT l.user_id) FILTER (WHERE l.user_id IS NOT NULL)::bigint AS active_users_total,
         COALESCE(AVG(l.latency_ms) FILTER (WHERE l.latency_ms IS NOT NULL), 0)::numeric AS avg_latency_ms,
         COUNT(*) FILTER (WHERE ${this.buildUsagePointsEstimatedSql('l')})::bigint AS estimated_points_requests
         FROM ai_usage_logs l
         ${this.buildUsageLedgerJoinSql('l')}
         ${whereL.clause}`,
      ...whereL.params,
    ) as Promise<Array<Record<string, unknown>>>);
    const dailyRows = await (this.prisma.$queryRawUnsafe(
      `WITH days AS (
           SELECT generate_series(
             date_trunc('day', $1::timestamptz),
             date_trunc('day', $2::timestamptz),
             interval '1 day'
           ) AS day_start
         ),
         daily_agg AS (
           SELECT
             date_trunc('day', l.created_at) AS day_start,
             COUNT(*)::bigint AS requests_total,
             SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
             COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
             COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
             COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
             COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
             COUNT(DISTINCT l.user_id) FILTER (WHERE l.user_id IS NOT NULL)::bigint AS active_users,
             COUNT(*) FILTER (WHERE ${this.buildUsagePointsEstimatedSql('l')})::bigint AS estimated_points_requests
           FROM ai_usage_logs l
           ${this.buildUsageLedgerJoinSql('l')}
           ${whereL.clause}
           GROUP BY 1
         )
         SELECT
           to_char(days.day_start, 'YYYY-MM-DD') AS day,
           COALESCE(daily_agg.requests_total, 0)::bigint AS requests_total,
           COALESCE(daily_agg.success_total, 0)::bigint AS success_total,
           COALESCE(daily_agg.total_tokens, 0)::bigint AS total_tokens,
           COALESCE(daily_agg.total_billed_units, 0)::numeric AS total_billed_units,
           COALESCE(daily_agg.total_cost_rmb, 0)::numeric AS total_cost_rmb,
           COALESCE(daily_agg.total_points_cost, 0)::numeric AS total_points_cost,
           COALESCE(daily_agg.active_users, 0)::bigint AS active_users,
           COALESCE(daily_agg.estimated_points_requests, 0)::bigint AS estimated_points_requests
         FROM days
         LEFT JOIN daily_agg ON daily_agg.day_start = days.day_start
         ORDER BY days.day_start ASC`,
      ...where.params,
    ) as Promise<Array<Record<string, unknown>>>);

    const overview = overviewRows[0] || {};
    const totalCost = this.toFiniteNumber(overview.total_cost_rmb, 0);
    const totalPoints = this.toFiniteNumber(overview.total_points_cost, 0);
    return {
      range: {
        days,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      overview: {
        requests_total: this.toFiniteInteger(overview.requests_total, 0),
        success_total: this.toFiniteInteger(overview.success_total, 0),
        error_total: this.toFiniteInteger(overview.error_total, 0),
        total_tokens: this.toFiniteInteger(overview.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(overview.total_billed_units, 0),
        total_cost_rmb: totalCost,
        total_points_cost: totalPoints,
        active_users_total: this.toFiniteInteger(overview.active_users_total, 0),
        avg_latency_ms: this.toFiniteNumber(overview.avg_latency_ms, 0),
        estimated_points_requests: this.toFiniteInteger(overview.estimated_points_requests, 0),
      },
      daily: dailyRows.map((row) => ({
        day: String(row.day || ''),
        requests_total: this.toFiniteInteger(row.requests_total, 0),
        success_total: this.toFiniteInteger(row.success_total, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber(row.total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
        active_users: this.toFiniteInteger(row.active_users, 0),
        estimated_points_requests: this.toFiniteInteger(row.estimated_points_requests, 0),
      })),
    };
  }

  private async getUsageBreakdownFromLogs(query: AiUsageSummaryQueryInput, from: Date, to: Date) {
    const { days } = this.resolveUsageRange(query);
    const whereL = this.buildUsageWhereClause(query, from, to, 'l');

    const capabilityRows = await (this.prisma.$queryRawUnsafe(
      `SELECT
           l.capability,
           COUNT(*)::bigint AS requests_total,
           SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
           SUM(CASE WHEN l.success THEN 0 ELSE 1 END)::bigint AS error_total,
           COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
           COUNT(DISTINCT l.user_id) FILTER (WHERE l.user_id IS NOT NULL)::bigint AS active_users_total,
           COALESCE(AVG(l.latency_ms) FILTER (WHERE l.latency_ms IS NOT NULL), 0)::numeric AS avg_latency_ms
         FROM ai_usage_logs l
         ${this.buildUsageLedgerJoinSql('l')}
         ${whereL.clause}
         GROUP BY l.capability
         ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC`,
      ...whereL.params,
    ) as Promise<Array<Record<string, unknown>>>);
    const modelRows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         l.global_model_id AS model_id,
         MAX(l.model_key) AS model_key,
         COALESCE(MAX(m.display_name), MAX(l.model_key)) AS display_name,
         MAX(l.capability) AS capability,
         COUNT(*)::bigint AS requests_total,
         SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
         SUM(CASE WHEN l.success THEN 0 ELSE 1 END)::bigint AS error_total,
         COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
         COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
         COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
         COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
         COUNT(DISTINCT l.user_id) FILTER (WHERE l.user_id IS NOT NULL)::bigint AS active_users_total,
         COALESCE(AVG(l.latency_ms) FILTER (WHERE l.latency_ms IS NOT NULL), 0)::numeric AS avg_latency_ms,
         COALESCE(MAX(l.unit_price_rmb_per_mtoken), 0)::numeric AS unit_price_rmb_per_mtoken,
         COALESCE(MAX(l.unit_price_rmb_per_call), 0)::numeric AS unit_price_rmb_per_call,
         COALESCE(MAX(l.unit_price_rmb_per_minute), 0)::numeric AS unit_price_rmb_per_minute,
         COALESCE(MAX(l.unit_price_mode), 'per_mtoken') AS unit_price_mode,
         COALESCE(MAX(l.billed_unit_label), 'token') AS billed_unit_label,
         MAX(l.created_at) AS last_called_at
       FROM ai_usage_logs l
       LEFT JOIN ai_global_models m ON m.id = l.global_model_id
       ${this.buildUsageLedgerJoinSql('l')}
       ${whereL.clause}
       GROUP BY l.global_model_id
       ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC
       LIMIT 200`,
      ...whereL.params,
    ) as Promise<Array<Record<string, unknown>>>);
    const totalCost = modelRows.reduce((sum, row) => sum + this.toFiniteNumber(row.total_cost_rmb, 0), 0);
    const sourceRows = await (this.prisma.$queryRawUnsafe(
      `SELECT
           l.source_id,
           MAX(l.source_name) AS source_name,
           MAX(l.provider_type) AS provider_type,
           COUNT(*)::bigint AS requests_total,
           SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
           SUM(CASE WHEN l.success THEN 0 ELSE 1 END)::bigint AS error_total,
           COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
           COUNT(DISTINCT l.user_id) FILTER (WHERE l.user_id IS NOT NULL)::bigint AS active_users_total,
           COALESCE(AVG(l.latency_ms) FILTER (WHERE l.latency_ms IS NOT NULL), 0)::numeric AS avg_latency_ms,
           MAX(l.created_at) AS last_called_at
         FROM ai_usage_logs l
         ${this.buildUsageLedgerJoinSql('l')}
         ${whereL.clause}
         GROUP BY l.source_id
         ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC`,
      ...whereL.params,
    ) as Promise<Array<Record<string, unknown>>>);
    const topUserRows = await (this.prisma.$queryRawUnsafe(
      `SELECT
           l.user_id,
           COALESCE(MAX(u.display_name), MAX(u.email), MAX(l.user_id::text)) AS user_display_name,
           MAX(u.email) AS user_email,
           COUNT(*)::bigint AS requests_total,
           SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
           COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
           MAX(l.created_at) AS last_called_at
         FROM ai_usage_logs l
         LEFT JOIN users u ON u.id = l.user_id
         ${this.buildUsageLedgerJoinSql('l')}
         ${whereL.clause}${whereL.clause ? ' AND' : ' WHERE'} l.user_id IS NOT NULL
         GROUP BY l.user_id
         ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC
         LIMIT 20`,
      ...whereL.params,
    ) as Promise<Array<Record<string, unknown>>>);
    return {
      range: {
        days,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      by_capability: capabilityRows.map((row) => ({
        capability: this.normalizeCapability(String(row.capability || 'chat')),
        requests_total: this.toFiniteInteger(row.requests_total, 0),
        success_total: this.toFiniteInteger(row.success_total, 0),
        error_total: this.toFiniteInteger(row.error_total, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber(row.total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
        active_users_total: this.toFiniteInteger(row.active_users_total, 0),
        avg_latency_ms: this.toFiniteNumber(row.avg_latency_ms, 0),
      })),
      by_model: modelRows.map((row) => {
        const modelCost = this.toFiniteNumber(row.total_cost_rmb, 0);
        const requestCount = this.toFiniteInteger(row.requests_total, 0);
        const tokens = this.toFiniteInteger(row.total_tokens, 0);
        return {
          model_id: String(row.model_id || ''),
          model_key: String(row.model_key || ''),
          display_name: String(row.display_name || row.model_key || ''),
          capability: this.normalizeCapability(String(row.capability || 'chat')),
          unit_price_rmb_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_per_mtoken, 0),
          unit_price_rmb_per_call: this.toFiniteNumber(row.unit_price_rmb_per_call, 0),
          unit_price_mode: this.normalizePricingMode(row.unit_price_mode),
          requests_total: requestCount,
          success_total: this.toFiniteInteger(row.success_total, 0),
          error_total: this.toFiniteInteger(row.error_total, 0),
          total_tokens: tokens,
          total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
          total_cost_rmb: modelCost,
          total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
          active_users_total: this.toFiniteInteger(row.active_users_total, 0),
          avg_latency_ms: this.toFiniteNumber(row.avg_latency_ms, 0),
          avg_tokens_per_request: requestCount > 0 ? tokens / requestCount : 0,
          unit_price_rmb_per_minute: this.toFiniteNumber(row.unit_price_rmb_per_minute, 0),
          cost_ratio: totalCost > 0 ? modelCost / totalCost : 0,
          billed_unit_label: this.normalizeBilledUnitLabel(row.billed_unit_label),
          last_called_at: row.last_called_at,
        };
      }),
      by_source: sourceRows.map((row) => ({
        source_id: String(row.source_id || ''),
        source_name: String(row.source_name || ''),
        provider_type: String(row.provider_type || ''),
        requests_total: this.toFiniteInteger(row.requests_total, 0),
        success_total: this.toFiniteInteger(row.success_total, 0),
        error_total: this.toFiniteInteger(row.error_total, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber(row.total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
        active_users_total: this.toFiniteInteger(row.active_users_total, 0),
        avg_latency_ms: this.toFiniteNumber(row.avg_latency_ms, 0),
        last_called_at: row.last_called_at,
      })),
      top_users: topUserRows.map((row) => ({
        user_id: String(row.user_id || ''),
        user_display_name: String(row.user_display_name || row.user_email || row.user_id || ''),
        user_email: this.normalizeNullableString(row.user_email, 255),
        requests_total: this.toFiniteInteger(row.requests_total, 0),
        success_total: this.toFiniteInteger(row.success_total, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber(row.total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
        last_called_at: row.last_called_at,
      })),
    };
  }

  private async getUsageSummaryFromFacts(query: AiUsageSummaryQueryInput, from: Date, to: Date) {
    const { days } = this.resolveUsageRange(query);
    const whereFacts = this.buildUsageFactsWhereClause(query, from, to, 'f');
    const whereUserFacts = this.buildUsageUserFactsWhereClause(query, from, to, 'uf');
    const [overviewRows, activeUserRows, dailyRows, dailyUserRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(SUM(f.requests_total), 0)::bigint AS requests_total,
           COALESCE(SUM(f.success_total), 0)::bigint AS success_total,
           COALESCE(SUM(f.error_total), 0)::bigint AS error_total,
           COALESCE(SUM(f.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(f.total_billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(f.total_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(f.total_points_cost), 0)::numeric AS total_points_cost,
           COALESCE(SUM(f.latency_sum_ms), 0)::numeric / NULLIF(COALESCE(SUM(f.latency_sample_count), 0), 0)::numeric AS avg_latency_ms,
           COALESCE(SUM(f.estimated_points_requests), 0)::bigint AS estimated_points_requests
         FROM ai_usage_daily_facts f
         ${whereFacts.clause}`,
        ...whereFacts.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(DISTINCT uf.user_id)::bigint AS active_users_total
         FROM ai_usage_user_daily_facts uf
         ${whereUserFacts.clause}`,
        ...whereUserFacts.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           to_char(f.fact_day, 'YYYY-MM-DD') AS day,
           COALESCE(SUM(f.requests_total), 0)::bigint AS requests_total,
           COALESCE(SUM(f.success_total), 0)::bigint AS success_total,
           COALESCE(SUM(f.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(f.total_billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(f.total_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(f.total_points_cost), 0)::numeric AS total_points_cost,
           COALESCE(SUM(f.estimated_points_requests), 0)::bigint AS estimated_points_requests
         FROM ai_usage_daily_facts f
         ${whereFacts.clause}
         GROUP BY f.fact_day
         ORDER BY f.fact_day ASC`,
        ...whereFacts.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           to_char(uf.fact_day, 'YYYY-MM-DD') AS day,
           COUNT(DISTINCT uf.user_id)::bigint AS active_users
         FROM ai_usage_user_daily_facts uf
         ${whereUserFacts.clause}
         GROUP BY uf.fact_day
         ORDER BY uf.fact_day ASC`,
        ...whereUserFacts.params,
      ) as Promise<Array<Record<string, unknown>>>),
    ]);

    const overview = overviewRows[0] || {};
    const activeUsersTotal = this.toFiniteInteger(activeUserRows[0]?.active_users_total, 0);
    const totalCost = this.toFiniteNumber(overview.total_cost_rmb, 0);
    const totalPoints = this.toFiniteNumber(overview.total_points_cost, 0);
    const dailyMap = new Map(
      dailyRows.map((row) => [String(row.day || ''), row]),
    );
    const activeUserMap = new Map(
      dailyUserRows.map((row) => [String(row.day || ''), this.toFiniteInteger(row.active_users, 0)]),
    );
    const daily: Array<Record<string, unknown>> = [];
    for (
      let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
      cursor <= new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
    ) {
      const day = cursor.toISOString().slice(0, 10);
      const row = dailyMap.get(day) || {};
      daily.push({
        day,
        requests_total: this.toFiniteInteger((row as any).requests_total, 0),
        success_total: this.toFiniteInteger((row as any).success_total, 0),
        total_tokens: this.toFiniteInteger((row as any).total_tokens, 0),
        total_billed_units: this.toFiniteNumber((row as any).total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber((row as any).total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber((row as any).total_points_cost, 0),
        active_users: activeUserMap.get(day) || 0,
        estimated_points_requests: this.toFiniteInteger((row as any).estimated_points_requests, 0),
      });
    }
    return {
      range: {
        days,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      overview: {
        requests_total: this.toFiniteInteger(overview.requests_total, 0),
        success_total: this.toFiniteInteger(overview.success_total, 0),
        error_total: this.toFiniteInteger(overview.error_total, 0),
        total_tokens: this.toFiniteInteger(overview.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(overview.total_billed_units, 0),
        total_cost_rmb: totalCost,
        total_points_cost: totalPoints,
        active_users_total: activeUsersTotal,
        avg_latency_ms: this.toFiniteNumber(overview.avg_latency_ms, 0),
        estimated_points_requests: this.toFiniteInteger(overview.estimated_points_requests, 0),
      },
      daily,
    };
  }

  private async getUsageBreakdownFromFacts(query: AiUsageSummaryQueryInput, from: Date, to: Date) {
    const { days } = this.resolveUsageRange(query);
    const factsWhere = this.buildUsageFactsWhereClause(query, from, to, 'f');
    const userWhere = this.buildUsageUserFactsWhereClause(query, from, to, 'uf');

    const [capabilityRows, capabilityActiveRows, modelRows, modelActiveRows, sourceRows, sourceActiveRows, topUserRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT
           f.capability,
           COALESCE(SUM(f.requests_total), 0)::bigint AS requests_total,
           COALESCE(SUM(f.success_total), 0)::bigint AS success_total,
           COALESCE(SUM(f.error_total), 0)::bigint AS error_total,
           COALESCE(SUM(f.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(f.total_billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(f.total_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(f.total_points_cost), 0)::numeric AS total_points_cost,
           COALESCE(SUM(f.latency_sum_ms), 0)::numeric / NULLIF(COALESCE(SUM(f.latency_sample_count), 0), 0)::numeric AS avg_latency_ms
         FROM ai_usage_daily_facts f
         ${factsWhere.clause}
         GROUP BY f.capability
         ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC`,
        ...factsWhere.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT uf.capability, COUNT(DISTINCT uf.user_id)::bigint AS active_users_total
         FROM ai_usage_user_daily_facts uf
         ${userWhere.clause}
         GROUP BY uf.capability`,
        ...userWhere.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           f.global_model_id AS model_id,
           MAX(f.model_key) AS model_key,
           COALESCE(MAX(m.display_name), MAX(f.model_key)) AS display_name,
           MAX(f.capability) AS capability,
           COALESCE(SUM(f.requests_total), 0)::bigint AS requests_total,
           COALESCE(SUM(f.success_total), 0)::bigint AS success_total,
           COALESCE(SUM(f.error_total), 0)::bigint AS error_total,
           COALESCE(SUM(f.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(f.total_billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(f.total_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(f.total_points_cost), 0)::numeric AS total_points_cost,
           COALESCE(SUM(f.latency_sum_ms), 0)::numeric / NULLIF(COALESCE(SUM(f.latency_sample_count), 0), 0)::numeric AS avg_latency_ms,
           COALESCE(MAX(f.unit_price_rmb_per_mtoken), 0)::numeric AS unit_price_rmb_per_mtoken,
           COALESCE(MAX(f.unit_price_rmb_per_call), 0)::numeric AS unit_price_rmb_per_call,
           COALESCE(MAX(f.unit_price_rmb_per_minute), 0)::numeric AS unit_price_rmb_per_minute,
           COALESCE(MAX(f.unit_price_mode), 'per_mtoken') AS unit_price_mode,
           COALESCE(MAX(f.billed_unit_label), 'token') AS billed_unit_label,
           MAX(f.last_called_at) AS last_called_at
         FROM ai_usage_daily_facts f
         LEFT JOIN ai_global_models m ON m.id = f.global_model_id
         ${factsWhere.clause}
         GROUP BY f.global_model_id
         ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC
         LIMIT 200`,
        ...factsWhere.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT uf.global_model_id AS model_id, COUNT(DISTINCT uf.user_id)::bigint AS active_users_total
         FROM ai_usage_user_daily_facts uf
         ${userWhere.clause}
         GROUP BY uf.global_model_id`,
        ...userWhere.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           f.source_id,
           MAX(f.source_name) AS source_name,
           MAX(f.provider_type) AS provider_type,
           COALESCE(SUM(f.requests_total), 0)::bigint AS requests_total,
           COALESCE(SUM(f.success_total), 0)::bigint AS success_total,
           COALESCE(SUM(f.error_total), 0)::bigint AS error_total,
           COALESCE(SUM(f.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(f.total_billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(f.total_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(f.total_points_cost), 0)::numeric AS total_points_cost,
           COALESCE(SUM(f.latency_sum_ms), 0)::numeric / NULLIF(COALESCE(SUM(f.latency_sample_count), 0), 0)::numeric AS avg_latency_ms,
           MAX(f.last_called_at) AS last_called_at
         FROM ai_usage_daily_facts f
         ${factsWhere.clause}
         GROUP BY f.source_id
         ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC`,
        ...factsWhere.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT uf.source_id, COUNT(DISTINCT uf.user_id)::bigint AS active_users_total
         FROM ai_usage_user_daily_facts uf
         ${userWhere.clause}
         GROUP BY uf.source_id`,
        ...userWhere.params,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           uf.user_id,
           COALESCE(MAX(u.display_name), MAX(u.email), MAX(uf.user_id::text)) AS user_display_name,
           MAX(u.email) AS user_email,
           COALESCE(SUM(uf.requests_total), 0)::bigint AS requests_total,
           COALESCE(SUM(uf.success_total), 0)::bigint AS success_total,
           COALESCE(SUM(uf.total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(uf.total_billed_units), 0)::numeric AS total_billed_units,
           COALESCE(SUM(uf.total_cost_rmb), 0)::numeric AS total_cost_rmb,
           COALESCE(SUM(uf.total_points_cost), 0)::numeric AS total_points_cost,
           MAX(uf.last_called_at) AS last_called_at
         FROM ai_usage_user_daily_facts uf
         LEFT JOIN users u ON u.id = uf.user_id
         ${userWhere.clause}${userWhere.clause ? ' AND' : ' WHERE'} uf.user_id IS NOT NULL
         GROUP BY uf.user_id
         ORDER BY total_points_cost DESC, total_cost_rmb DESC, requests_total DESC
         LIMIT 20`,
        ...userWhere.params,
      ) as Promise<Array<Record<string, unknown>>>),
    ]);

    const capabilityActiveMap = new Map(capabilityActiveRows.map((row) => [String(row.capability || ''), this.toFiniteInteger(row.active_users_total, 0)]));
    const modelActiveMap = new Map(modelActiveRows.map((row) => [String(row.model_id || ''), this.toFiniteInteger(row.active_users_total, 0)]));
    const sourceActiveMap = new Map(sourceActiveRows.map((row) => [String(row.source_id || ''), this.toFiniteInteger(row.active_users_total, 0)]));
    const totalCost = modelRows.reduce((sum, row) => sum + this.toFiniteNumber(row.total_cost_rmb, 0), 0);
    return {
      range: {
        days,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      by_capability: capabilityRows.map((row) => ({
        capability: this.normalizeCapability(String(row.capability || 'chat')),
        requests_total: this.toFiniteInteger(row.requests_total, 0),
        success_total: this.toFiniteInteger(row.success_total, 0),
        error_total: this.toFiniteInteger(row.error_total, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber(row.total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
        active_users_total: capabilityActiveMap.get(String(row.capability || '')) || 0,
        avg_latency_ms: this.toFiniteNumber(row.avg_latency_ms, 0),
      })),
      by_model: modelRows.map((row) => {
        const modelCost = this.toFiniteNumber(row.total_cost_rmb, 0);
        const requestCount = this.toFiniteInteger(row.requests_total, 0);
        const tokens = this.toFiniteInteger(row.total_tokens, 0);
        return {
          model_id: String(row.model_id || ''),
          model_key: String(row.model_key || ''),
          display_name: String(row.display_name || row.model_key || ''),
          capability: this.normalizeCapability(String(row.capability || 'chat')),
          unit_price_rmb_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_per_mtoken, 0),
          unit_price_rmb_per_call: this.toFiniteNumber(row.unit_price_rmb_per_call, 0),
          unit_price_mode: this.normalizePricingMode(row.unit_price_mode),
          requests_total: requestCount,
          success_total: this.toFiniteInteger(row.success_total, 0),
          error_total: this.toFiniteInteger(row.error_total, 0),
          total_tokens: tokens,
          total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
          total_cost_rmb: modelCost,
          total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
          active_users_total: modelActiveMap.get(String(row.model_id || '')) || 0,
          avg_latency_ms: this.toFiniteNumber(row.avg_latency_ms, 0),
          avg_tokens_per_request: requestCount > 0 ? tokens / requestCount : 0,
          unit_price_rmb_per_minute: this.toFiniteNumber(row.unit_price_rmb_per_minute, 0),
          cost_ratio: totalCost > 0 ? modelCost / totalCost : 0,
          billed_unit_label: this.normalizeBilledUnitLabel(row.billed_unit_label),
          last_called_at: row.last_called_at,
        };
      }),
      by_source: sourceRows.map((row) => ({
        source_id: String(row.source_id || ''),
        source_name: String(row.source_name || ''),
        provider_type: String(row.provider_type || ''),
        requests_total: this.toFiniteInteger(row.requests_total, 0),
        success_total: this.toFiniteInteger(row.success_total, 0),
        error_total: this.toFiniteInteger(row.error_total, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber(row.total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
        active_users_total: sourceActiveMap.get(String(row.source_id || '')) || 0,
        avg_latency_ms: this.toFiniteNumber(row.avg_latency_ms, 0),
        last_called_at: row.last_called_at,
      })),
      top_users: topUserRows.map((row) => ({
        user_id: String(row.user_id || ''),
        user_display_name: String(row.user_display_name || row.user_email || row.user_id || ''),
        user_email: this.normalizeNullableString(row.user_email, 255),
        requests_total: this.toFiniteInteger(row.requests_total, 0),
        success_total: this.toFiniteInteger(row.success_total, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        total_billed_units: this.toFiniteNumber(row.total_billed_units, 0),
        total_cost_rmb: this.toFiniteNumber(row.total_cost_rmb, 0),
        total_points_cost: this.toFiniteNumber(row.total_points_cost, 0),
        last_called_at: row.last_called_at,
      })),
    };
  }

  async listUsageLogs(query: AiUsageLogsQueryInput = {}) {
    await this.ensureSchema();

    const { from, to, days } = this.resolveUsageRange(query);
    const where = this.buildUsageWhereClause(query, from, to, 'l');
    const page = this.normalizePositiveInt(query.page, 1);
    const pageSize = Math.min(this.normalizePositiveInt(query.page_size, 30), 200);
    const offset = (page - 1) * pageSize;

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         l.id,
         l.app_id,
         l.app_slug,
         l.user_id,
         l.global_model_id AS model_id,
         l.model_key,
         COALESCE(m.display_name, l.model_key) AS display_name,
         l.upstream_model,
         l.capability,
         l.source_id,
         l.source_name,
         l.provider_type,
         l.endpoint_path,
         l.request_path,
         l.request_id,
         l.is_stream,
         l.success,
         l.error_message,
         l.prompt_tokens,
         l.completion_tokens,
         l.total_tokens,
         l.uncached_input_tokens,
         l.cached_input_tokens,
         l.cache_read_input_tokens,
         l.cache_creation_input_tokens,
         l.cache_creation_5m_input_tokens,
         l.cache_creation_1h_input_tokens,
         l.unit_price_rmb_per_mtoken,
         l.unit_price_rmb_per_call,
         l.unit_price_rmb_per_minute,
         l.unit_price_rmb_input_per_mtoken,
         l.unit_price_rmb_cached_input_per_mtoken,
         l.unit_price_rmb_cache_write_5m_per_mtoken,
         l.unit_price_rmb_cache_write_1h_per_mtoken,
         l.unit_price_rmb_output_per_mtoken,
         l.unit_price_mode,
         l.billed_input_tokens,
         l.billed_cached_input_tokens,
         l.billed_cache_write_tokens,
         l.billed_output_tokens,
         l.billed_units,
         l.billed_unit_label,
         l.billed_duration_seconds,
         l.estimated_cost_rmb,
         ${this.buildUsageEffectivePointsCostSql('l')} AS points_cost,
         ${this.buildUsagePointsPricingSourceSql('l')} AS points_pricing_source,
         ${this.buildUsagePointsEstimatedSql('l')} AS points_cost_is_estimated,
         l.usage_reference_id,
         u.display_name AS user_display_name,
         u.email AS user_email,
         l.latency_ms,
         l.created_at
       FROM ai_usage_logs l
       LEFT JOIN ai_global_models m ON m.id = l.global_model_id
       LEFT JOIN users u ON u.id = l.user_id
       ${this.buildUsageLedgerJoinSql('l')}
       ${where.clause}
       ORDER BY l.created_at DESC
       LIMIT $${where.params.length + 1}
       OFFSET $${where.params.length + 2}`,
      ...where.params,
      pageSize,
      offset,
    ) as Promise<Array<Record<string, unknown>>>);

    const countRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS total FROM ai_usage_logs l ${where.clause}`,
      ...where.params,
    ) as Promise<Array<Record<string, unknown>>>);
    const total = this.toFiniteInteger(countRows[0]?.total, 0);

    return {
      range: {
        days,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      page,
      page_size: pageSize,
      total,
      items: rows.map((row) => ({
        id: String(row.id || ''),
        app_id: String(row.app_id || ''),
        app_slug: String(row.app_slug || ''),
        user_id: this.normalizeNullableString(row.user_id),
        model_id: String(row.model_id || ''),
        model_key: String(row.model_key || ''),
        display_name: String(row.display_name || row.model_key || ''),
        upstream_model: String(row.upstream_model || ''),
        capability: this.normalizeCapability(String(row.capability || 'chat')),
        source_id: String(row.source_id || ''),
        source_name: String(row.source_name || ''),
        provider_type: String(row.provider_type || ''),
        endpoint_path: String(row.endpoint_path || ''),
        request_path: this.normalizeNullableString(row.request_path),
        request_id: this.normalizeNullableString(row.request_id),
        is_stream: row.is_stream === true,
        success: row.success === true,
        error_message: this.normalizeNullableString(row.error_message, 1024),
        prompt_tokens: this.toFiniteInteger(row.prompt_tokens, 0),
        completion_tokens: this.toFiniteInteger(row.completion_tokens, 0),
        total_tokens: this.toFiniteInteger(row.total_tokens, 0),
        uncached_input_tokens: this.toFiniteInteger(row.uncached_input_tokens, 0),
        cached_input_tokens: this.toFiniteInteger(row.cached_input_tokens, 0),
        cache_read_input_tokens: this.toFiniteInteger(row.cache_read_input_tokens, 0),
        cache_creation_input_tokens: this.toFiniteInteger(row.cache_creation_input_tokens, 0),
        cache_creation_5m_input_tokens: this.toFiniteInteger(row.cache_creation_5m_input_tokens, 0),
        cache_creation_1h_input_tokens: this.toFiniteInteger(row.cache_creation_1h_input_tokens, 0),
        unit_price_rmb_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_per_mtoken, 0),
        unit_price_rmb_per_call: this.toFiniteNumber(row.unit_price_rmb_per_call, 0),
        unit_price_rmb_per_minute: this.toFiniteNumber(row.unit_price_rmb_per_minute, 0),
        unit_price_rmb_input_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_input_per_mtoken, 0),
        unit_price_rmb_cached_input_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_cached_input_per_mtoken, 0),
        unit_price_rmb_cache_write_5m_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_cache_write_5m_per_mtoken, 0),
        unit_price_rmb_cache_write_1h_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_cache_write_1h_per_mtoken, 0),
        unit_price_rmb_output_per_mtoken: this.toFiniteNumber(row.unit_price_rmb_output_per_mtoken, 0),
        unit_price_mode: this.normalizePricingMode(row.unit_price_mode),
        billed_input_tokens: this.toFiniteInteger(row.billed_input_tokens, 0),
        billed_cached_input_tokens: this.toFiniteInteger(row.billed_cached_input_tokens, 0),
        billed_cache_write_tokens: this.toFiniteInteger(row.billed_cache_write_tokens, 0),
        billed_output_tokens: this.toFiniteInteger(row.billed_output_tokens, 0),
        billed_units: this.toFiniteNumber(row.billed_units, 0),
        billed_unit_label: this.normalizeBilledUnitLabel(row.billed_unit_label),
        billed_duration_seconds: this.toFiniteInteger(row.billed_duration_seconds, 0),
        estimated_cost_rmb: this.toFiniteNumber(row.estimated_cost_rmb, 0),
        points_cost: this.toFiniteNumber(row.points_cost, 0),
        points_pricing_source: this.normalizeNullableString(row.points_pricing_source, 64),
        points_cost_is_estimated: row.points_cost_is_estimated === true,
        usage_reference_id: this.normalizeNullableString(row.usage_reference_id, 128),
        user_display_name: this.normalizeNullableString(row.user_display_name, 255),
        user_email: this.normalizeNullableString(row.user_email, 255),
        latency_ms: this.toFiniteInteger(row.latency_ms, 0),
        created_at: row.created_at,
      })),
    };
  }

  async listActiveModelsBySlug(appSlug: string, capability?: AiCapability) {
    await this.ensureSchema();
    const app = await this.ensureAppBySlug(appSlug);
    const routes = await this.listAppModelRoutes(app.id);
    const appDefaults = await this.listAppCapabilityDefaults(app.id);
    const capabilityDefaultModelMap = new Map<string, string>();
    appDefaults.items.forEach((item: any) => {
      if (!item?.effective_model?.model_id) {
        return;
      }
      capabilityDefaultModelMap.set(String(item.capability), String(item.effective_model.model_id));
    });

    const models = routes.items
      .filter((item: any) => item.model.is_active && item.model.is_visible !== false && item.effective_source?.is_active)
      .filter((item: any) => !capability || item.model.capability === capability)
      .map((item: any) => ({
        model_key: item.model.model_key,
        display_name: item.model.display_name,
        capability: item.model.capability,
        execution_mode: item.model.execution_mode,
        pricing_mode: this.normalizePricingMode(item.model.pricing_mode, this.normalizeCapability(item.model.capability)),
        rmb_per_mtoken: this.normalizeRmbPerMToken(item.model.rmb_per_mtoken, 0),
        rmb_per_call: this.normalizeRmbPerCall(item.model.rmb_per_call, 0),
        rmb_per_minute: this.normalizeRmbPerMinute(item.model.rmb_per_minute, 0),
        input_rmb_per_mtoken: this.normalizeRmbPerMToken(item.model.input_rmb_per_mtoken, 0),
        cached_input_rmb_per_mtoken: this.normalizeRmbPerMToken(item.model.cached_input_rmb_per_mtoken, 0),
        cache_write_5m_rmb_per_mtoken: this.normalizeRmbPerMToken(item.model.cache_write_5m_rmb_per_mtoken, 0),
        cache_write_1h_rmb_per_mtoken: this.normalizeRmbPerMToken(item.model.cache_write_1h_rmb_per_mtoken, 0),
        output_rmb_per_mtoken: this.normalizeRmbPerMToken(item.model.output_rmb_per_mtoken, 0),
        points_per_mtoken: this.normalizePointsPerMToken(item.model.points_per_mtoken, 0),
        points_per_call: this.normalizePointsPerCall(item.model.points_per_call, 0),
        points_per_minute: this.normalizePointsPerMinute(item.model.points_per_minute, 0),
        points_input_per_mtoken: this.normalizePointsPerMToken(item.model.points_input_per_mtoken, 0),
        points_cached_input_per_mtoken: this.normalizePointsPerMToken(item.model.points_cached_input_per_mtoken, 0),
        points_cache_write_5m_per_mtoken: this.normalizePointsPerMToken(item.model.points_cache_write_5m_per_mtoken, 0),
        points_cache_write_1h_per_mtoken: this.normalizePointsPerMToken(item.model.points_cache_write_1h_per_mtoken, 0),
        points_output_per_mtoken: this.normalizePointsPerMToken(item.model.points_output_per_mtoken, 0),
        api_type: item.model.api_type,
        request_overrides: this.normalizeObject(item.effective_request_overrides || item.model.request_overrides),
        is_default: capabilityDefaultModelMap.get(item.model.capability) === item.model_id,
      }));

    return this.appendMinimaxTtsUpstreamModelOptions(models, routes.items, capability);
  }

  async resolveModelRoute(appSlug: string, requestedModel?: string): Promise<ResolvedAiRoute> {
    return this.resolveModelRouteByCapability(appSlug, 'chat', requestedModel);
  }

  async resolveModelRouteByCapability(
    appSlug: string,
    capability: AiCapability,
    requestedModel?: string,
  ): Promise<ResolvedAiRoute> {
    const cacheKey = this.buildResolvedRouteCacheKey(appSlug, capability, requestedModel);
    const now = Date.now();
    const cached = this.resolvedRouteCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return this.applyRotatedApiKeyToRoute(cached.value);
    }

    const candidates = await this.resolveModelRouteCandidatesByCapability(appSlug, capability, requestedModel);
    const resolvedRoute = candidates[0];
    if (!resolvedRoute) {
      throw new NotFoundException('No active source available for this model');
    }
    this.resolvedRouteCache.set(cacheKey, {
      value: this.cloneResolvedRoute(resolvedRoute),
      expiresAt: now + RESOLVED_ROUTE_CACHE_TTL_MS,
    });

    return resolvedRoute;
  }

  async resolveModelRouteCandidatesByCapability(
    appSlug: string,
    capability: AiCapability,
    requestedModel?: string,
  ): Promise<ResolvedAiRoute[]> {
    await this.ensureSchema();
    const app = await this.ensureAppBySlug(appSlug);

    if (!requestedModel) {
      const slotModels = await this.findAppDefaultSlotModelsForCapability(app.id, capability);
      for (const model of slotModels) {
        const resolved = await this.tryResolveModelRouteCandidates(app, model);
        if (resolved.length > 0) {
          return resolved;
        }
      }
    }

    let model = requestedModel
      ? await this.findRequestedActiveGlobalModel(requestedModel, capability)
      : (await this.findAppDefaultActiveModel(app.id, capability)) || (await this.findDefaultActiveGlobalModel(capability));

    if (!model && requestedModel && this.isSupportedMinimaxTtsUpstreamModel(requestedModel, capability)) {
      const fallbackModels = await this.findDefaultTtsRouteModels(app.id, capability);
      for (const fallbackModel of fallbackModels) {
        const resolved = await this.tryResolveModelRouteCandidates(app, fallbackModel);
        const minimaxRoutes = resolved.filter((route) => this.isMinimaxResolvedTtsRoute(route));
        if (minimaxRoutes.length > 0) {
          return minimaxRoutes;
        }
      }
    }

    if (!model) {
      if (requestedModel) {
        throw new NotFoundException(`AI model not found or inactive for capability=${capability}: ${requestedModel}`);
      }
      throw new NotFoundException(`No active AI model configured globally for capability=${capability}`);
    }

    const resolved = await this.tryResolveModelRouteCandidates(app, model);
    if (resolved.length === 0) {
      throw new NotFoundException('No active source available for this model');
    }
    return resolved;
  }

  async resolveModelRouteCandidatesByModelId(
    appSlug: string,
    capability: AiCapability,
    modelId: string,
  ): Promise<ResolvedAiRoute[]> {
    await this.ensureSchema();
    const app = await this.ensureAppBySlug(appSlug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM ai_global_models
       WHERE id = $1::uuid
         AND capability = $2
         AND is_active = true
       LIMIT 1`,
      modelId,
      capability,
    ) as Promise<AiGlobalModelRow[]>);
    const model = rows[0];
    if (!model) {
      throw new NotFoundException(`AI model not found or inactive for capability=${capability}`);
    }
    const resolved = await this.tryResolveModelRouteCandidates(app, model);
    if (resolved.length === 0) {
      throw new NotFoundException('No active source available for this model');
    }
    return resolved;
  }

  private async tryResolveModelRouteCandidates(
    app: { id: string; slug: string },
    model: AiGlobalModelRow,
  ): Promise<ResolvedAiRoute[]> {
    const sourceRouteSelection = await this.resolveModelSourceRouteSelection(app.id, model);
    if (sourceRouteSelection.hasConfiguredRoutes) {
      if (sourceRouteSelection.routes.length === 0) {
        return [];
      }
      return this.applyRotatedApiKeysToRoutes(
        sourceRouteSelection.routes.map((sourceRoute) => this.buildResolvedRouteFromSourceRoute(app, model, sourceRoute)),
      );
    }

    const appRoute = await this.findActiveAppRoute(app.id, model.id);
    const source = appRoute
      ? await this.getActiveGlobalSourceById(appRoute.source_id)
      : await this.getActiveGlobalSourceById(model.default_source_id);

    if (!source) {
      return [];
    }

    return this.applyRotatedApiKeysToRoutes([
      this.buildResolvedRouteFromSource(app, model, source, appRoute ? this.normalizeObject(appRoute.request_overrides) : {}),
    ]);
  }

  private buildResolvedRouteCacheKey(appSlug: string, capability: AiCapability, requestedModel?: string) {
    const normalizedSlug = String(appSlug || '').trim().toLowerCase();
    const normalizedCapability = this.normalizeCapability(capability);
    const normalizedModel = String(requestedModel || '').trim().toLowerCase() || '__default__';
    return `${normalizedSlug}:${normalizedCapability}:${normalizedModel}`;
  }

  private buildResolvedRouteFromSourceRoute(
    app: { id: string; slug: string },
    model: AiGlobalModelRow,
    sourceRoute: AiModelSourceRouteJoinedRow,
  ): ResolvedAiRoute {
    const source: AiGlobalSourceRow = {
      id: sourceRoute.source_id,
      name: sourceRoute.source_name,
      provider_type: sourceRoute.source_provider_type,
      base_url: sourceRoute.source_base_url,
      api_key: sourceRoute.source_api_key,
      custom_headers: sourceRoute.source_custom_headers,
      credentials_json: sourceRoute.source_credentials_json,
      outbound_proxy_id: sourceRoute.source_outbound_proxy_id || null,
      is_active: sourceRoute.source_is_active,
      created_by_user_id: null,
      updated_by_user_id: null,
      created_at: sourceRoute.created_at,
      updated_at: sourceRoute.updated_at,
    };
    return this.buildResolvedRouteFromSource(app, {
      ...model,
      upstream_model: sourceRoute.upstream_model || model.upstream_model,
      endpoint_path: sourceRoute.endpoint_path || model.endpoint_path,
      api_type: sourceRoute.api_type || model.api_type,
    }, source, this.normalizeObject(sourceRoute.request_overrides), sourceRoute.route_key || sourceRoute.id);
  }

  private buildResolvedRouteFromSource(
    app: { id: string; slug: string },
    model: AiGlobalModelRow,
    source: AiGlobalSourceRow,
    routeOverrides: Record<string, unknown> = {},
    routeKey?: string | null,
  ): ResolvedAiRoute {
    const mergedOverrides = {
      ...this.normalizeObject(model.request_overrides),
      ...routeOverrides,
    };
    const resolvedCapability = this.normalizeCapability(model.capability);
    const resolvedApiType = this.resolveApiTypeForSource(
      model.api_type,
      resolvedCapability,
      source.provider_type,
      source.base_url,
      model.upstream_model || model.model_key,
    );
    const rawEndpointPath = this.normalizeEndpointPath(
      model.endpoint_path || this.defaultEndpointPathForApiType(resolvedApiType, resolvedCapability),
    );
    const providerAdjustedEndpointPath = this.normalizeEndpointPathForProvider(
      resolvedApiType,
      resolvedCapability,
      rawEndpointPath,
    );
    const resolvedEndpointPath = this.normalizeMinimaxEndpointPathForBase(
      source.provider_type,
      source.base_url,
      providerAdjustedEndpointPath,
    );

    return {
      app_id: app.id,
      app_slug: app.slug,
      route_key: this.normalizeRouteKey(routeKey || source.id),
      model_id: model.id,
      model_key: model.model_key,
      display_name: model.display_name,
      capability: resolvedCapability,
      execution_mode: this.normalizeExecutionMode(model.execution_mode),
      pricing_mode: this.normalizePricingMode(model.pricing_mode, resolvedCapability),
      rmb_per_mtoken: this.normalizeRmbPerMToken(model.rmb_per_mtoken, 0),
      rmb_per_call: this.normalizeRmbPerCall(model.rmb_per_call, 0),
      rmb_per_minute: this.normalizeRmbPerMinute(model.rmb_per_minute, 0),
      input_rmb_per_mtoken: this.normalizeRmbPerMToken(model.input_rmb_per_mtoken, 0),
      cached_input_rmb_per_mtoken: this.normalizeRmbPerMToken(model.cached_input_rmb_per_mtoken, 0),
      cache_write_5m_rmb_per_mtoken: this.normalizeRmbPerMToken(model.cache_write_5m_rmb_per_mtoken, 0),
      cache_write_1h_rmb_per_mtoken: this.normalizeRmbPerMToken(model.cache_write_1h_rmb_per_mtoken, 0),
      output_rmb_per_mtoken: this.normalizeRmbPerMToken(model.output_rmb_per_mtoken, 0),
      points_per_mtoken: this.normalizePointsPerMToken(model.points_per_mtoken, 0),
      points_per_call: this.normalizePointsPerCall(model.points_per_call, 0),
      points_per_minute: this.normalizePointsPerMinute(model.points_per_minute, 0),
      points_input_per_mtoken: this.normalizePointsPerMToken(model.points_input_per_mtoken, 0),
      points_cached_input_per_mtoken: this.normalizePointsPerMToken(model.points_cached_input_per_mtoken, 0),
      points_cache_write_5m_per_mtoken: this.normalizePointsPerMToken(model.points_cache_write_5m_per_mtoken, 0),
      points_cache_write_1h_per_mtoken: this.normalizePointsPerMToken(model.points_cache_write_1h_per_mtoken, 0),
      points_output_per_mtoken: this.normalizePointsPerMToken(model.points_output_per_mtoken, 0),
      upstream_model: model.upstream_model,
      endpoint_path: resolvedEndpointPath,
      api_type: resolvedApiType,
      request_overrides: mergedOverrides,
      source: {
        id: source.id,
        name: source.name,
        provider_type: source.provider_type,
        base_url: source.base_url,
        api_key: source.api_key,
        custom_headers: this.normalizeStringObject(source.custom_headers),
        credentials: this.normalizeObject(source.credentials_json),
        outbound_proxy_id: source.outbound_proxy_id || null,
        is_active: source.is_active,
      },
    };
  }

  private appendMinimaxTtsUpstreamModelOptions<T extends Record<string, any>>(
    models: T[],
    routeItems: any[],
    capability?: AiCapability,
  ): T[] {
    if (capability && capability !== 'tts') {
      return models;
    }
    const baseRoute = routeItems.find((item: any) =>
      item?.model?.capability === 'tts'
      && item?.model?.is_active
      && item?.model?.is_visible !== false
      && !this.isVoiceCloneApiType(item?.api_type || item?.model?.api_type)
      && item?.effective_source?.is_active
      && this.isMinimaxTtsRouteCandidate(item),
    );
    if (!baseRoute) {
      return models;
    }

    const existing = new Set(models.map((item) => String(item.model_key || '').trim()).filter(Boolean));
    const baseModel = models.find((item) => String(item.model_key || '') === String(baseRoute.model?.model_key || '')) || {};
    const defaultModelKey = String(baseRoute.model?.upstream_model || '').trim();
    const upstreamOptions = ['speech-2.8-turbo', 'speech-2.6-turbo'];
    const additions = upstreamOptions
      .filter((modelKey) => !existing.has(modelKey))
      .map((modelKey) => ({
        ...baseModel,
        model_key: modelKey,
        display_name: modelKey === 'speech-2.8-turbo' ? 'MiniMax speech-2.8-turbo' : 'MiniMax speech-2.6-turbo',
        capability: 'tts',
        execution_mode: 'sync',
        api_type: baseRoute.model?.api_type || baseRoute.api_type || MINIMAX_TTS_API_TYPE,
        is_default: modelKey === defaultModelKey,
      })) as unknown as T[];
    return [...additions, ...models];
  }

  private async findDefaultTtsRouteModels(appId: string, capability: AiCapability): Promise<AiGlobalModelRow[]> {
    const fallbackModels: AiGlobalModelRow[] = [];
    const seen = new Set<string>();
    const push = (model: AiGlobalModelRow | null) => {
      if (!model || seen.has(model.id)) {
        return;
      }
      seen.add(model.id);
      fallbackModels.push(model);
    };

    if (capability === 'tts') {
      const slotModels = await this.findAppDefaultSlotModelsForCapability(appId, capability);
      slotModels.forEach(push);
    }
    push(await this.findAppDefaultActiveModel(appId, capability));
    push(await this.findDefaultActiveGlobalModel(capability));
    return fallbackModels;
  }

  private isSupportedMinimaxTtsUpstreamModel(modelKey: string, capability: AiCapability): boolean {
    if (capability !== 'tts') {
      return false;
    }
    const normalized = String(modelKey || '').trim().toLowerCase();
    return normalized === 'speech-2.8-turbo' || normalized === 'speech-2.6-turbo';
  }

  private isMinimaxTtsRouteCandidate(item: any): boolean {
    const apiType = String(item?.api_type || item?.model?.api_type || '').trim();
    const providerType = String(item?.effective_source?.provider_type || '').trim().toLowerCase();
    const baseUrl = String(item?.effective_source?.base_url || '').trim().toLowerCase();
    return !this.isVoiceCloneApiType(apiType)
      && (this.isMinimaxTtsApiType(apiType)
      || providerType.replace(/[^a-z0-9]/g, '').includes('minimax')
      || baseUrl.includes('minimax.io'));
  }

  private isMinimaxResolvedTtsRoute(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'tts') {
      return false;
    }
    const providerType = String(route.source?.provider_type || '').trim().toLowerCase();
    const baseUrl = String(route.source?.base_url || '').trim().toLowerCase();
    return !this.isVoiceCloneApiType(route.api_type)
      && (this.isMinimaxTtsApiType(route.api_type)
      || providerType.replace(/[^a-z0-9]/g, '').includes('minimax')
      || baseUrl.includes('minimax.io'));
  }

  private cloneResolvedRoute(route: ResolvedAiRoute): ResolvedAiRoute {
    return {
      ...route,
      request_overrides: { ...route.request_overrides },
      source: {
        ...route.source,
        custom_headers: { ...route.source.custom_headers },
        credentials: { ...route.source.credentials },
      },
    };
  }

  private clearResolvedRouteCache() {
    this.resolvedRouteCache.clear();
  }

  private async applyRotatedApiKeysToRoutes(routes: ResolvedAiRoute[]): Promise<ResolvedAiRoute[]> {
    const rotatedRoutes: ResolvedAiRoute[] = [];
    for (const route of routes) {
      rotatedRoutes.push(await this.applyRotatedApiKeyToRoute(route));
    }
    return rotatedRoutes;
  }

  private async applyRotatedApiKeyToRoute(route: ResolvedAiRoute): Promise<ResolvedAiRoute> {
    const cloned = this.cloneResolvedRoute(route);
    cloned.source.api_key = await this.selectNextSourceApiKey(cloned.source.id, cloned.source.api_key);
    return cloned;
  }

  private serializeGlobalSource(row: AiGlobalSourceRow, apiKeys: AiGlobalSourceApiKeyRow[] = []) {
    const sortedApiKeys = [...apiKeys].sort((left, right) => {
      if (left.sort_order !== right.sort_order) {
        return left.sort_order - right.sort_order;
      }
      return left.created_at.getTime() - right.created_at.getTime();
    });
    const activeApiKeyCount = sortedApiKeys.filter((item) => item.is_active).length;
    return {
      id: row.id,
      name: row.name,
      provider_type: row.provider_type,
      base_url: row.base_url,
      custom_headers: this.normalizeStringObject(row.custom_headers),
      credentials: this.serializeSourceCredentials(row.provider_type, row.credentials_json),
      outbound_proxy_id: row.outbound_proxy_id || null,
      outbound_proxy: row.outbound_proxy_id
        ? {
            id: row.outbound_proxy_id,
            name: row.outbound_proxy_name || '',
            protocol: row.outbound_proxy_protocol || '',
            status: row.outbound_proxy_status || '',
            latency_ms: row.outbound_proxy_latency_ms ?? null,
            detected_ip: row.outbound_proxy_detected_ip || null,
            region: row.outbound_proxy_region || null,
          }
        : null,
      is_active: row.is_active,
      has_api_key: !!row.api_key,
      api_key_masked: this.maskSecret(row.api_key),
      api_key_count: sortedApiKeys.length || (row.api_key ? 1 : 0),
      active_api_key_count: activeApiKeyCount || (row.api_key ? 1 : 0),
      api_keys: sortedApiKeys.map((item) => ({
        id: item.id,
        label: item.label,
        is_active: item.is_active,
        sort_order: item.sort_order,
        last_used_at: item.last_used_at,
        api_key_masked: this.maskSecret(item.api_key),
        created_at: item.created_at,
        updated_at: item.updated_at,
      })),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private async getSerializedGlobalSourceById(sourceId: string) {
    const row = await this.getGlobalSourceById(sourceId);
    if (!row) {
      throw new NotFoundException('AI source not found');
    }
    const apiKeys = await this.listSourceApiKeys(sourceId);
    return this.serializeGlobalSource(row, apiKeys);
  }

  private async listSourceApiKeysMap(sourceIds: string[]): Promise<Map<string, AiGlobalSourceApiKeyRow[]>> {
    const uniqueSourceIds = Array.from(new Set(sourceIds.filter(Boolean)));
    const result = new Map<string, AiGlobalSourceApiKeyRow[]>();
    if (!uniqueSourceIds.length) {
      return result;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM ai_global_source_api_keys
       WHERE source_id = ANY($1::uuid[])
       ORDER BY source_id ASC, sort_order ASC, created_at ASC`,
      uniqueSourceIds,
    ) as Promise<AiGlobalSourceApiKeyRow[]>);
    rows.forEach((row) => {
      const list = result.get(row.source_id) || [];
      list.push(row);
      result.set(row.source_id, list);
    });
    return result;
  }

  private async listSourceApiKeys(sourceId: string, onlyActive = false): Promise<AiGlobalSourceApiKeyRow[]> {
    return (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM ai_global_source_api_keys
       WHERE source_id = $1::uuid
         AND ($2::boolean = false OR is_active = true)
       ORDER BY sort_order ASC, created_at ASC`,
      sourceId,
      onlyActive,
    ) as Promise<AiGlobalSourceApiKeyRow[]>);
  }

  private normalizeSourceApiKeyInputs(inputs?: AiSourceApiKeyInput[] | null) {
    if (!Array.isArray(inputs)) {
      return [];
    }
    return inputs.map((input, index) => {
      const rawSortOrder = Number(input?.sort_order ?? index);
      return {
        id: String(input?.id || '').trim() || null,
        label: String(input?.label || '').trim(),
        api_key: String(input?.api_key || '').trim(),
        sort_order: Number.isFinite(rawSortOrder) ? Math.round(rawSortOrder) : index,
        is_active: input?.is_active !== false,
      };
    });
  }

  private normalizeSourceCredentialsInput(
    providerType: string,
    input: Record<string, unknown> | undefined,
    existing: unknown,
    requireValid: boolean,
  ): Record<string, unknown> {
    const existingCredentials = this.normalizeObject(existing);
    const provider = String(providerType || '').trim().toLowerCase();
    if (!this.isVertexAiSource(provider, '')) {
      return input === undefined ? existingCredentials : this.normalizeObject(input);
    }

    const raw = input === undefined ? existingCredentials : this.normalizeObject(input);
    const authMode = String(raw.auth_mode || existingCredentials.auth_mode || 'api_key').trim()
      || 'api_key';
    const projectId = String(raw.project_id || existingCredentials.project_id || '').trim();
    const location = String(raw.location || existingCredentials.location || '').trim() || 'global';
    const serviceAccountJson = this.normalizeVertexServiceAccountJson(raw.service_account_json)
      || this.normalizeVertexServiceAccountJson(existingCredentials.service_account_json);

    if (requireValid) {
      if (!projectId) {
        throw new BadRequestException('Vertex AI project_id is required');
      }
      if (!location) {
        throw new BadRequestException('Vertex AI location is required');
      }
      if (authMode === 'service_account_json' && !serviceAccountJson) {
        throw new BadRequestException('Vertex AI service_account_json is required');
      }
      if (authMode !== 'api_key' && authMode !== 'service_account_json' && authMode !== 'adc') {
        throw new BadRequestException('Vertex AI auth_mode must be api_key, service_account_json, or adc');
      }
    }

    return {
      auth_mode: authMode,
      project_id: projectId,
      location,
      ...(serviceAccountJson ? { service_account_json: serviceAccountJson } : {}),
    };
  }

  private normalizeVertexServiceAccountJson(value: unknown): Record<string, unknown> | null {
    if (!value) {
      return null;
    }
    if (typeof value === 'string') {
      const raw = value.trim();
      if (!raw) {
        return null;
      }
      try {
        return this.normalizeObject(JSON.parse(raw));
      } catch {
        throw new BadRequestException('Vertex AI service_account_json must be valid JSON');
      }
    }
    return this.normalizeObject(value);
  }

  private serializeSourceCredentials(providerType: string, value: unknown): Record<string, unknown> {
    const credentials = this.normalizeObject(value);
    if (!this.isVertexAiSource(providerType, '')) {
      return credentials;
    }
    const serviceAccountJson = this.normalizeObject(credentials.service_account_json);
    return {
      auth_mode: String(credentials.auth_mode || 'api_key'),
      project_id: String(credentials.project_id || ''),
      location: String(credentials.location || ''),
      has_service_account_json: Object.keys(serviceAccountJson).length > 0,
      service_account_email: String(serviceAccountJson.client_email || ''),
    };
  }

  private async replaceSourceApiKeys(
    sourceId: string,
    actorUserId: string,
    inputs: AiSourceApiKeyInput[] | undefined,
    fallbackApiKey: string,
  ): Promise<AiGlobalSourceApiKeyRow[]> {
    const existingRows = await this.listSourceApiKeys(sourceId);
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    const normalizedInputs = inputs === undefined
      ? [{
          id: existingRows[0]?.id || null,
          label: existingRows[0]?.label || 'Default',
          api_key: fallbackApiKey,
          sort_order: 0,
          is_active: true,
        }]
      : this.normalizeSourceApiKeyInputs(inputs);

    const rowsToStore = normalizedInputs.map((input, index) => {
      const existing = input.id ? existingById.get(input.id) : null;
      const apiKey = input.api_key || existing?.api_key || '';
      return {
        id: existing?.id || input.id || null,
        label: input.label || existing?.label || `Key ${index + 1}`,
        api_key: apiKey,
        sort_order: input.sort_order,
        is_active: input.is_active,
      };
    }).filter((item) => item.api_key);

    if (!rowsToStore.length) {
      throw new BadRequestException('api_keys must include at least one API Key');
    }
    if (!rowsToStore.some((item) => item.is_active)) {
      throw new BadRequestException('api_keys must include at least one active API Key');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM ai_global_source_api_keys WHERE source_id = $1::uuid`,
        sourceId,
      );
      for (let index = 0; index < rowsToStore.length; index += 1) {
        const item = rowsToStore[index];
        await tx.$executeRawUnsafe(
          `INSERT INTO ai_global_source_api_keys (
             id, source_id, label, api_key, sort_order, is_active, created_by_user_id, updated_by_user_id
           )
           VALUES (
             COALESCE(NULLIF($1, '')::uuid, gen_random_uuid()),
             $2::uuid,
             $3,
             $4,
             $5,
             $6,
             $7::uuid,
             $7::uuid
           )`,
          item.id || '',
          sourceId,
          item.label,
          item.api_key,
          Number.isFinite(item.sort_order) ? item.sort_order : index,
          item.is_active,
          actorUserId,
        );
      }
    });

    this.sourceApiKeyCache.delete(sourceId);
    this.sourceApiKeyRotationCounters.delete(sourceId);
    return this.listSourceApiKeys(sourceId);
  }

  private pickPrimarySourceApiKey(rows: AiGlobalSourceApiKeyRow[], fallbackApiKey: string) {
    const primary = rows.find((row) => row.is_active) || rows[0];
    return primary?.api_key || fallbackApiKey;
  }

  private async selectNextSourceApiKey(sourceId: string, fallbackApiKey: string): Promise<string> {
    const activeKeys = await this.listActiveSourceApiKeysForRotation(sourceId);
    if (!activeKeys.length) {
      return fallbackApiKey;
    }
    const current = this.sourceApiKeyRotationCounters.get(sourceId) || 0;
    const selected = activeKeys[current % activeKeys.length];
    this.sourceApiKeyRotationCounters.set(sourceId, (current + 1) % activeKeys.length);
    this.touchSourceApiKeyLastUsed(selected.id);
    return selected.api_key || fallbackApiKey;
  }

  private async listActiveSourceApiKeysForRotation(sourceId: string): Promise<AiGlobalSourceApiKeyRow[]> {
    const now = Date.now();
    const cached = this.sourceApiKeyCache.get(sourceId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const keys = await this.listSourceApiKeys(sourceId, true);
    this.sourceApiKeyCache.set(sourceId, {
      value: keys,
      expiresAt: now + SOURCE_API_KEY_CACHE_TTL_MS,
    });
    return keys;
  }

  private touchSourceApiKeyLastUsed(keyId: string) {
    const now = Date.now();
    const lastWriteAt = this.sourceApiKeyLastUsedWriteAt.get(keyId) || 0;
    if (now - lastWriteAt < SOURCE_API_KEY_CACHE_TTL_MS) {
      return;
    }
    this.sourceApiKeyLastUsedWriteAt.set(keyId, now);
    void this.prisma.$executeRawUnsafe(
      `UPDATE ai_global_source_api_keys
       SET last_used_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      keyId,
    ).catch((error: any) => {
      this.logger.warn(`failed to update AI source API key last_used_at: ${error?.message || error}`);
    });
  }

  private serializeGlobalModel(row: AiGlobalModelJoinedRow, sourceRoutes: AiModelSourceRouteJoinedRow[] = []) {
    const serializedSourceRoutes = this.serializeModelSourceRoutes(sourceRoutes);
    return {
      id: row.id,
      model_key: row.model_key,
      display_name: row.display_name,
      capability: this.normalizeCapability(row.capability),
      execution_mode: this.normalizeExecutionMode(row.execution_mode),
      pricing_mode: this.normalizePricingMode(row.pricing_mode, this.normalizeCapability(row.capability)),
      rmb_per_mtoken: this.normalizeRmbPerMToken(row.rmb_per_mtoken, 0),
      rmb_per_call: this.normalizeRmbPerCall(row.rmb_per_call, 0),
      rmb_per_minute: this.normalizeRmbPerMinute(row.rmb_per_minute, 0),
      input_rmb_per_mtoken: this.normalizeRmbPerMToken(row.input_rmb_per_mtoken, 0),
      cached_input_rmb_per_mtoken: this.normalizeRmbPerMToken(row.cached_input_rmb_per_mtoken, 0),
      cache_write_5m_rmb_per_mtoken: this.normalizeRmbPerMToken(row.cache_write_5m_rmb_per_mtoken, 0),
      cache_write_1h_rmb_per_mtoken: this.normalizeRmbPerMToken(row.cache_write_1h_rmb_per_mtoken, 0),
      output_rmb_per_mtoken: this.normalizeRmbPerMToken(row.output_rmb_per_mtoken, 0),
      points_per_mtoken: this.normalizePointsPerMToken(row.points_per_mtoken, 0),
      points_per_call: this.normalizePointsPerCall(row.points_per_call, 0),
      points_per_minute: this.normalizePointsPerMinute(row.points_per_minute, 0),
      points_input_per_mtoken: this.normalizePointsPerMToken(row.points_input_per_mtoken, 0),
      points_cached_input_per_mtoken: this.normalizePointsPerMToken(row.points_cached_input_per_mtoken, 0),
      points_cache_write_5m_per_mtoken: this.normalizePointsPerMToken(row.points_cache_write_5m_per_mtoken, 0),
      points_cache_write_1h_per_mtoken: this.normalizePointsPerMToken(row.points_cache_write_1h_per_mtoken, 0),
      points_output_per_mtoken: this.normalizePointsPerMToken(row.points_output_per_mtoken, 0),
      default_source_id: row.default_source_id,
      default_source_name: row.default_source_name,
      default_source_provider_type: row.default_source_provider_type,
      default_source_is_active: row.default_source_is_active,
      source_routes: serializedSourceRoutes.length > 0
        ? serializedSourceRoutes
        : [{
            id: null,
            route_key: row.default_source_id,
            source_id: row.default_source_id,
            source_name: row.default_source_name,
            source_provider_type: row.default_source_provider_type,
            source_is_active: row.default_source_is_active,
            sort_order: 0,
            is_active: row.default_source_is_active,
            upstream_model: row.upstream_model,
            endpoint_path: row.endpoint_path,
            api_type: row.api_type,
            request_overrides: {},
          }],
      upstream_model: row.upstream_model,
      endpoint_path: row.endpoint_path,
      api_type: row.api_type,
      request_overrides: this.normalizeObject(row.request_overrides),
      is_default: row.is_default,
      is_active: row.is_active,
      is_visible: row.is_visible,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeAppModelRoute(row: AiAppModelRouteJoinedRow) {
    const hasRoute = !!row.route_id;
    const overrideActive = hasRoute && !!row.route_is_active;
    const overrideSourceActive = hasRoute && !!row.route_source_is_active;

    const effectiveSource = overrideActive && overrideSourceActive
      ? {
          id: row.route_source_id,
          name: row.route_source_name,
          provider_type: row.route_source_provider_type,
          is_active: !!row.route_source_is_active,
          from_override: true,
        }
      : {
          id: row.default_source_id,
          name: row.default_source_name,
          provider_type: row.default_source_provider_type,
          is_active: !!row.default_source_is_active,
          from_override: false,
        };

    return {
      model_id: row.model_id,
      model: {
        model_key: row.model_key,
        display_name: row.model_display_name,
        capability: row.model_capability,
        execution_mode: row.model_execution_mode,
        pricing_mode: this.normalizePricingMode(row.model_pricing_mode, this.normalizeCapability(row.model_capability)),
        rmb_per_mtoken: this.normalizeRmbPerMToken(row.model_rmb_per_mtoken, 0),
        rmb_per_call: this.normalizeRmbPerCall(row.model_rmb_per_call, 0),
        rmb_per_minute: this.normalizeRmbPerMinute(row.model_rmb_per_minute, 0),
        input_rmb_per_mtoken: this.normalizeRmbPerMToken(row.model_input_rmb_per_mtoken, 0),
        cached_input_rmb_per_mtoken: this.normalizeRmbPerMToken(row.model_cached_input_rmb_per_mtoken, 0),
        cache_write_5m_rmb_per_mtoken: this.normalizeRmbPerMToken(row.model_cache_write_5m_rmb_per_mtoken, 0),
        cache_write_1h_rmb_per_mtoken: this.normalizeRmbPerMToken(row.model_cache_write_1h_rmb_per_mtoken, 0),
        output_rmb_per_mtoken: this.normalizeRmbPerMToken(row.model_output_rmb_per_mtoken, 0),
        points_per_mtoken: this.normalizePointsPerMToken(row.model_points_per_mtoken, 0),
        points_per_call: this.normalizePointsPerCall(row.model_points_per_call, 0),
        points_per_minute: this.normalizePointsPerMinute(row.model_points_per_minute, 0),
        points_input_per_mtoken: this.normalizePointsPerMToken(row.model_points_input_per_mtoken, 0),
        points_cached_input_per_mtoken: this.normalizePointsPerMToken(row.model_points_cached_input_per_mtoken, 0),
        points_cache_write_5m_per_mtoken: this.normalizePointsPerMToken(row.model_points_cache_write_5m_per_mtoken, 0),
        points_cache_write_1h_per_mtoken: this.normalizePointsPerMToken(row.model_points_cache_write_1h_per_mtoken, 0),
        points_output_per_mtoken: this.normalizePointsPerMToken(row.model_points_output_per_mtoken, 0),
        upstream_model: row.model_upstream_model,
        endpoint_path: row.model_endpoint_path,
        api_type: row.model_api_type,
        request_overrides: this.normalizeObject(row.model_request_overrides),
        is_default: row.model_is_default,
        is_active: row.model_is_active,
        is_visible: row.model_is_visible,
      },
      default_source: {
        id: row.default_source_id,
        name: row.default_source_name,
        provider_type: row.default_source_provider_type,
        is_active: row.default_source_is_active,
      },
      override: hasRoute
        ? {
            route_id: row.route_id,
            source_id: row.route_source_id,
            source_name: row.route_source_name,
            source_provider_type: row.route_source_provider_type,
            source_is_active: !!row.route_source_is_active,
            is_active: !!row.route_is_active,
            request_overrides: this.normalizeObject(row.route_request_overrides),
            updated_at: row.route_updated_at,
          }
        : null,
      effective_source: effectiveSource,
      effective_request_overrides: {
        ...this.normalizeObject(row.model_request_overrides),
        ...(hasRoute ? this.normalizeObject(row.route_request_overrides) : {}),
      },
    };
  }

  private serializeAppDefaultModelSlot(row: AiAppDefaultModelSlotJoinedRow | null, slotKey: AiAppDefaultModelSlot) {
    const serializeModel = (
      modelId: string | null | undefined,
      modelKey: string | null | undefined,
      displayName: string | null | undefined,
      capability: string | null | undefined,
      isActive: boolean | null | undefined,
    ) => {
      if (!modelId || !modelKey || !capability) {
        return null;
      }
      return {
        model_id: modelId,
        model_key: modelKey,
        display_name: displayName || modelKey,
        capability: this.normalizeCapability(capability),
        is_active: isActive === true,
      };
    };

    const primary = serializeModel(
      row?.primary_global_model_id,
      row?.primary_model_key,
      row?.primary_model_display_name,
      row?.primary_model_capability,
      row?.primary_model_is_active,
    );
    const fallback = serializeModel(
      row?.fallback_global_model_id,
      row?.fallback_model_key,
      row?.fallback_model_display_name,
      row?.fallback_model_capability,
      row?.fallback_model_is_active,
    );

    return {
      slot_key: slotKey,
      allowed_capabilities: AI_APP_DEFAULT_SLOT_CAPABILITIES[slotKey],
      primary_model: primary,
      fallback_model: fallback,
      effective_model: primary?.is_active ? primary : fallback?.is_active ? fallback : null,
      updated_at: row?.updated_at || null,
    };
  }

  private serializeModelSourceRoutes(rows: AiModelSourceRouteJoinedRow[]) {
    return rows.map((row) => ({
      id: row.id,
      route_key: row.route_key || row.id,
      app_id: row.app_id,
      global_model_id: row.global_model_id,
      source_id: row.source_id,
      source_name: row.source_name,
      source_provider_type: row.source_provider_type,
      source_is_active: row.source_is_active,
      sort_order: Number(row.sort_order || 0),
      is_active: row.is_active,
      upstream_model: row.upstream_model || '',
      endpoint_path: row.endpoint_path || '',
      api_type: row.api_type || '',
      request_overrides: this.normalizeObject(row.request_overrides),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  private async isModelSourceRoutesTableAvailable(): Promise<boolean> {
    if (this.modelSourceRoutesTableAvailable !== null) {
      return this.modelSourceRoutesTableAvailable;
    }
    try {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT to_regclass('public.ai_model_source_routes') IS NOT NULL AS exists`,
      ) as Promise<Array<{ exists: boolean }>>);
      this.modelSourceRoutesTableAvailable = rows[0]?.exists === true;
    } catch {
      this.modelSourceRoutesTableAvailable = false;
    }
    return this.modelSourceRoutesTableAvailable;
  }

  private async ensureModelSourceRoutesTableReady(): Promise<void> {
    if (!(await this.isModelSourceRoutesTableAvailable())) {
      throw new BadRequestException('ai_model_source_routes schema is not ready; run the database migration first');
    }
  }

  private async listGlobalModelSourceRoutesMap(modelIds: string[]): Promise<Map<string, AiModelSourceRouteJoinedRow[]>> {
    const output = new Map<string, AiModelSourceRouteJoinedRow[]>();
    if (modelIds.length === 0 || !(await this.isModelSourceRoutesTableAvailable())) {
      return output;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         r.*,
         s.name AS source_name,
         s.provider_type AS source_provider_type,
         s.base_url AS source_base_url,
         s.api_key AS source_api_key,
         s.custom_headers AS source_custom_headers,
         s.credentials_json AS source_credentials_json,
         s.outbound_proxy_id AS source_outbound_proxy_id,
         s.is_active AS source_is_active
       FROM ai_model_source_routes r
       JOIN ai_global_sources s ON s.id = r.source_id
       WHERE r.app_id IS NULL
         AND r.global_model_id = ANY($1::uuid[])
       ORDER BY r.global_model_id, r.sort_order ASC, r.created_at ASC`,
      modelIds,
    ) as Promise<AiModelSourceRouteJoinedRow[]>);
    rows.forEach((row) => {
      const list = output.get(row.global_model_id) || [];
      list.push(row);
      output.set(row.global_model_id, list);
    });
    return output;
  }

  private async listModelSourceRoutes(
    modelId: string,
    appId: string | null,
    requireTable: boolean,
  ): Promise<AiModelSourceRouteJoinedRow[]> {
    if (!(await this.isModelSourceRoutesTableAvailable())) {
      if (requireTable) {
        await this.ensureModelSourceRoutesTableReady();
      }
      return [];
    }
    const appIdValue = appId ? this.normalizeNullableUuid(appId) : null;
    return (this.prisma.$queryRawUnsafe(
      `SELECT
         r.*,
         s.name AS source_name,
         s.provider_type AS source_provider_type,
         s.base_url AS source_base_url,
         s.api_key AS source_api_key,
         s.custom_headers AS source_custom_headers,
         s.credentials_json AS source_credentials_json,
         s.outbound_proxy_id AS source_outbound_proxy_id,
         s.is_active AS source_is_active
       FROM ai_model_source_routes r
       JOIN ai_global_sources s ON s.id = r.source_id
       WHERE r.global_model_id = $1::uuid
         AND (
           ($2::uuid IS NULL AND r.app_id IS NULL)
           OR ($2::uuid IS NOT NULL AND r.app_id = $2::uuid)
         )
       ORDER BY r.sort_order ASC, r.created_at ASC`,
      modelId,
      appIdValue,
    ) as Promise<AiModelSourceRouteJoinedRow[]>);
  }

  private async findGlobalModelSourceRouteForSource(
    modelId: string,
    sourceId: string,
  ): Promise<AiModelSourceRouteJoinedRow | null> {
    const routes = await this.listModelSourceRoutes(modelId, null, false);
    return routes.find((row) => row.source_id === sourceId && row.is_active)
      || routes.find((row) => row.source_id === sourceId)
      || null;
  }

  private async resolveModelSourceRouteSelection(
    appId: string,
    model: AiGlobalModelRow,
  ): Promise<{ routes: AiModelSourceRouteJoinedRow[]; hasConfiguredRoutes: boolean }> {
    const appRoutes = await this.listModelSourceRoutes(model.id, appId, false);
    const activeAppRoutes = appRoutes.filter((row) => row.is_active && row.source_is_active);
    if (appRoutes.length > 0) {
      return {
        routes: activeAppRoutes,
        hasConfiguredRoutes: true,
      };
    }
    const globalRoutes = await this.listModelSourceRoutes(model.id, null, false);
    return {
      routes: globalRoutes.filter((row) => row.is_active && row.source_is_active),
      hasConfiguredRoutes: globalRoutes.length > 0,
    };
  }

  private normalizeModelSourceRouteInputs(input: unknown): NormalizedAiModelSourceRouteInput[] {
    if (!Array.isArray(input)) {
      return [];
    }
    const seenRouteKeys = new Set<string>();
    const output: NormalizedAiModelSourceRouteInput[] = [];
    input.forEach((item, index) => {
      const row = this.normalizeObject(item);
      const sourceId = this.normalizeNullableUuid(row.source_id);
      if (!sourceId) {
        return;
      }
      const routeKey = this.normalizeRouteKey(row.route_key || row.id || `${sourceId}-${index}`);
      const uniqueRouteKey = seenRouteKeys.has(routeKey) ? this.normalizeRouteKey(`${routeKey}-${index}`) : routeKey;
      seenRouteKeys.add(uniqueRouteKey);
      output.push({
        route_key: uniqueRouteKey,
        source_id: sourceId,
        sort_order: this.normalizeNullableInt(row.sort_order) ?? index,
        is_active: row.is_active !== false,
        upstream_model: this.normalizeNullableString(row.upstream_model, 256),
        endpoint_path: this.normalizeNullableString(row.endpoint_path, 255),
        api_type: this.normalizeNullableString(row.api_type, 64),
        request_overrides: this.normalizeObject(row.request_overrides),
      });
    });
    return output;
  }

  private normalizeRouteKey(value: unknown): string {
    const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
    return normalized || randomUUID();
  }

  private async replaceGlobalModelSourceRoutesIfProvided(
    modelId: string,
    actorUserId: string,
    sourceRoutes: AiModelSourceRouteInput[] | undefined,
    defaults: {
      default_source_id: string;
      upstream_model: string;
      endpoint_path: string;
      api_type: string;
    },
  ): Promise<void> {
    if (sourceRoutes === undefined) {
      if (await this.isModelSourceRoutesTableAvailable()) {
        const existingRoutes = await this.listModelSourceRoutes(modelId, null, false);
        if (existingRoutes.length === 0) {
          await this.replaceModelSourceRoutes(modelId, null, actorUserId, [{ source_id: defaults.default_source_id }], defaults);
        }
      }
      return;
    }
    await this.ensureModelSourceRoutesTableReady();
    await this.replaceModelSourceRoutes(modelId, null, actorUserId, sourceRoutes, defaults);
  }

  private async replaceModelSourceRoutes(
    modelId: string,
    appId: string | null,
    actorUserId: string,
    sourceRoutes: AiModelSourceRouteInput[],
    defaults: {
      default_source_id: string;
      upstream_model: string;
      endpoint_path: string;
      api_type: string;
    },
  ): Promise<AiModelSourceRouteJoinedRow[]> {
    const normalized = this.normalizeModelSourceRouteInputs(sourceRoutes);
    if (normalized.length === 0) {
      normalized.push({
        route_key: this.normalizeRouteKey(defaults.default_source_id),
        source_id: defaults.default_source_id,
        sort_order: 0,
        is_active: true,
      });
    }
    for (const route of normalized) {
      await this.ensureGlobalSourceExists(String(route.source_id));
    }
    const appIdValue = appId ? this.normalizeNullableUuid(appId) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM ai_model_source_routes
         WHERE global_model_id = $1::uuid
           AND (
             ($2::uuid IS NULL AND app_id IS NULL)
             OR ($2::uuid IS NOT NULL AND app_id = $2::uuid)
           )`,
        modelId,
        appIdValue,
      );
      for (let index = 0; index < normalized.length; index += 1) {
        const route = normalized[index];
        await tx.$executeRawUnsafe(
          `INSERT INTO ai_model_source_routes (
             id, route_key, app_id, global_model_id, source_id, sort_order, is_active,
             upstream_model, endpoint_path, api_type, request_overrides,
             created_by_user_id, updated_by_user_id
           )
           VALUES (
             gen_random_uuid(), $1, $2::uuid, $3::uuid, $4::uuid, $5, $6,
             $7, $8, $9, $10::jsonb,
             $11::uuid, $11::uuid
           )`,
          route.route_key,
          appIdValue,
          modelId,
          String(route.source_id),
          this.normalizeNullableInt(route.sort_order) ?? index,
          route.is_active !== false,
          this.normalizeNullableString(route.upstream_model, 256),
          this.normalizeNullableString(route.endpoint_path, 255),
          this.normalizeNullableString(route.api_type, 64),
          JSON.stringify(this.normalizeObject(route.request_overrides)),
          actorUserId,
        );
      }
    });
    return this.listModelSourceRoutes(modelId, appId, true);
  }

  private async getGlobalModelById(modelId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         m.*,
         s.name AS default_source_name,
         s.provider_type AS default_source_provider_type,
         s.base_url AS default_source_base_url,
         s.api_key AS default_source_api_key,
         s.custom_headers AS default_source_custom_headers,
         s.outbound_proxy_id AS default_source_outbound_proxy_id,
         s.is_active AS default_source_is_active
       FROM ai_global_models m
       JOIN ai_global_sources s ON s.id = m.default_source_id
       WHERE m.id = $1::uuid
       LIMIT 1`,
      modelId,
    ) as Promise<AiGlobalModelJoinedRow[]>);
    if (!rows[0]) {
      throw new NotFoundException('AI model not found');
    }
    const sourceRoutes = await this.listModelSourceRoutes(modelId, null, false);
    return this.serializeGlobalModel(rows[0], sourceRoutes);
  }

  private async getGlobalModelRowById(modelId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_global_models WHERE id = $1::uuid LIMIT 1`,
      modelId,
    ) as Promise<AiGlobalModelRow[]>);
    return rows[0] || null;
  }

  private async listAppDefaultModelSlotsForAppId(appId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         d.*,
         pm.model_key AS primary_model_key,
         pm.display_name AS primary_model_display_name,
         pm.capability AS primary_model_capability,
         pm.is_active AS primary_model_is_active,
         fm.model_key AS fallback_model_key,
         fm.display_name AS fallback_model_display_name,
         fm.capability AS fallback_model_capability,
         fm.is_active AS fallback_model_is_active
       FROM ai_app_default_model_slots d
       LEFT JOIN ai_global_models pm ON pm.id = d.primary_global_model_id
       LEFT JOIN ai_global_models fm ON fm.id = d.fallback_global_model_id
       WHERE d.app_id = $1::uuid`,
      appId,
    ) as Promise<AiAppDefaultModelSlotJoinedRow[]>);
    const bySlot = new Map<string, AiAppDefaultModelSlotJoinedRow>();
    rows.forEach((row) => bySlot.set(this.normalizeAppDefaultModelSlot(row.slot_key), row));
    return {
      items: AI_APP_DEFAULT_MODEL_SLOTS.map((slotKey) =>
        this.serializeAppDefaultModelSlot(bySlot.get(slotKey) || null, slotKey),
      ),
    };
  }

  private async ensureModelAllowedForDefaultSlot(
    modelId: string,
    slotKey: AiAppDefaultModelSlot,
    fieldName: 'primary_model_id' | 'fallback_model_id',
  ) {
    const model = await this.getGlobalModelRowById(modelId);
    if (!model) {
      throw new NotFoundException(`${fieldName} model not found`);
    }
    if (!model.is_active) {
      throw new BadRequestException(`${fieldName} model must be active`);
    }
    const capability = this.normalizeCapability(model.capability);
    if (!AI_APP_DEFAULT_SLOT_CAPABILITIES[slotKey].includes(capability)) {
      throw new BadRequestException(`${fieldName} capability mismatch for slot ${slotKey}`);
    }
    if (slotKey === 'tts' && this.isVoiceCloneApiType(model.api_type)) {
      throw new BadRequestException(`${fieldName} cannot use a voice clone model for slot ${slotKey}`);
    }
  }

  private async getGlobalSourceById(sourceId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         s.*,
         p.name AS outbound_proxy_name,
         p.protocol AS outbound_proxy_protocol,
         p.status AS outbound_proxy_status,
         p.latency_ms AS outbound_proxy_latency_ms,
         p.detected_ip AS outbound_proxy_detected_ip,
         p.region AS outbound_proxy_region
       FROM ai_global_sources s
       LEFT JOIN outbound_proxies p ON p.id = s.outbound_proxy_id
       WHERE s.id = $1::uuid
       LIMIT 1`,
      sourceId,
    ) as Promise<AiGlobalSourceRow[]>);
    return rows[0] || null;
  }

  private async getActiveGlobalSourceById(sourceId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         s.*,
         p.name AS outbound_proxy_name,
         p.protocol AS outbound_proxy_protocol,
         p.status AS outbound_proxy_status,
         p.latency_ms AS outbound_proxy_latency_ms,
         p.detected_ip AS outbound_proxy_detected_ip,
         p.region AS outbound_proxy_region
       FROM ai_global_sources s
       LEFT JOIN outbound_proxies p ON p.id = s.outbound_proxy_id
       WHERE s.id = $1::uuid AND s.is_active = true
       LIMIT 1`,
      sourceId,
    ) as Promise<AiGlobalSourceRow[]>);
    return rows[0] || null;
  }

  private async ensureOutboundProxyExists(proxyId: string | null): Promise<void> {
    if (!proxyId) {
      return;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM outbound_proxies WHERE id = $1::uuid LIMIT 1`,
      proxyId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new BadRequestException('outbound_proxy_id does not exist');
    }
  }

  private async findRequestedActiveGlobalModel(modelKey: string, capability?: AiCapability) {
    const rows = capability
      ? await (this.prisma.$queryRawUnsafe(
          `SELECT *
           FROM ai_global_models
           WHERE model_key = $1 AND is_active = true AND capability = $2
           LIMIT 1`,
          modelKey,
          capability,
        ) as Promise<AiGlobalModelRow[]>)
      : await (this.prisma.$queryRawUnsafe(
          `SELECT * FROM ai_global_models WHERE model_key = $1 AND is_active = true LIMIT 1`,
          modelKey,
        ) as Promise<AiGlobalModelRow[]>);
    return rows[0] || null;
  }

  private async findDefaultActiveGlobalModel(capability?: AiCapability) {
    const rows = capability
      ? await (this.prisma.$queryRawUnsafe(
          `SELECT *
           FROM ai_global_models
           WHERE is_active = true AND capability = $1
             AND ($1 <> 'tts' OR (api_type NOT ILIKE '%voice-clone%' AND api_type NOT ILIKE '%voice_clone%'))
           ORDER BY is_default DESC, updated_at DESC
           LIMIT 1`,
          capability,
        ) as Promise<AiGlobalModelRow[]>)
      : await (this.prisma.$queryRawUnsafe(
          `SELECT *
           FROM ai_global_models
           WHERE is_active = true
           ORDER BY is_default DESC, updated_at DESC
           LIMIT 1`,
        ) as Promise<AiGlobalModelRow[]>);
    return rows[0] || null;
  }

  private async findActiveAppRoute(appId: string, globalModelId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM ai_app_model_routes
       WHERE app_id = $1::uuid AND global_model_id = $2::uuid AND is_active = true
       LIMIT 1`,
      appId,
      globalModelId,
    ) as Promise<AiAppModelRouteRow[]>);
    return rows[0] || null;
  }

  private async findAppDefaultActiveModel(appId: string, capability: AiCapability) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT m.*
       FROM ai_app_capability_defaults d
       JOIN ai_global_models m ON m.id = d.global_model_id
       WHERE d.app_id = $1::uuid
         AND d.capability = $2
         AND m.is_active = true
         AND m.capability = $2
         AND ($2 <> 'tts' OR (m.api_type NOT ILIKE '%voice-clone%' AND m.api_type NOT ILIKE '%voice_clone%'))
       LIMIT 1`,
      appId,
      capability,
    ) as Promise<AiGlobalModelRow[]>);
    return rows[0] || null;
  }

  private async findAppDefaultSlotModelsForCapability(appId: string, capability: AiCapability) {
    const slotKey = AI_CAPABILITY_PRIMARY_SLOT[capability];
    if (!slotKey) {
      return [];
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT m.*
       FROM ai_app_default_model_slots d
       JOIN LATERAL (
         VALUES (1, d.primary_global_model_id), (2, d.fallback_global_model_id)
       ) selected(sort_order, model_id) ON selected.model_id IS NOT NULL
       JOIN ai_global_models m ON m.id = selected.model_id
       WHERE d.app_id = $1::uuid
         AND d.slot_key = $2
         AND m.is_active = true
         AND m.capability = $3
         AND ($3 <> 'tts' OR (m.api_type NOT ILIKE '%voice-clone%' AND m.api_type NOT ILIKE '%voice_clone%'))
       ORDER BY selected.sort_order ASC`,
      appId,
      slotKey,
      capability,
    ) as Promise<AiGlobalModelRow[]>);
    return rows;
  }

  private async ensureGlobalSourceExists(sourceId: string) {
    const row = await this.getGlobalSourceById(sourceId);
    if (!row) {
      throw new NotFoundException('AI source not found');
    }
  }

  private async ensureGlobalModelExists(modelId: string) {
    const row = await this.getGlobalModelRowById(modelId);
    if (!row) {
      throw new NotFoundException('AI model not found');
    }
  }

  private async clearDefaultGlobalModels(exceptModelId?: string, capability?: AiCapability) {
    if (exceptModelId) {
      if (capability) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_global_models
           SET is_default = false, updated_at = now()
           WHERE id <> $1::uuid AND capability = $2 AND is_default = true`,
          exceptModelId,
          capability,
        );
      } else {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_global_models
           SET is_default = false, updated_at = now()
           WHERE id <> $1::uuid AND is_default = true`,
          exceptModelId,
        );
      }
      return;
    }

    if (capability) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_global_models
         SET is_default = false, updated_at = now()
         WHERE capability = $1 AND is_default = true`,
        capability,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_global_models SET is_default = false, updated_at = now() WHERE is_default = true`,
      );
    }
  }

  private async ensureAppById(appId: string) {
    const app = await this.prisma.app.findUnique({ where: { id: appId } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private async ensureAppBySlug(appSlug: string) {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('app slug is required');
    }
    const app = await this.prisma.app.findUnique({ where: { slug } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private normalizeBaseUrl(value: unknown, providerType?: string): string {
    const fixedBaseUrl = resolveRunningHubBaseUrl(providerType, String(value || ''));
    const raw = String(fixedBaseUrl || '').trim().replace(/\/+$/, '');
    const normalized = this.isAnthropicSource(String(providerType || ''), raw)
      ? this.normalizeAnthropicBaseUrl(raw)
      : raw;
    if (!normalized) {
      return '';
    }
    if (!/^https?:\/\//i.test(normalized)) {
      throw new BadRequestException('base_url must start with http:// or https://');
    }
    return normalized;
  }

  private resolveRunningHubModelEndpointPath(endpointPath: unknown, upstreamModel: string): string {
    const rootPath = resolveRunningHubModelRootPath(
      typeof endpointPath === 'string' ? endpointPath : String(endpointPath || ''),
      upstreamModel,
    );
    if (!rootPath) {
      throw new BadRequestException('RunningHub 模型缺少上游模型名，无法自动生成模型路径');
    }
    return rootPath;
  }

  private normalizeEndpointPath(value: unknown): string {
    const raw = String(value || '/chat/completions').trim();
    if (!raw) {
      return '/chat/completions';
    }
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  private normalizeCapability(value: unknown): AiCapability {
    const raw = String(value || 'chat').trim().toLowerCase();
    if ((AI_CAPABILITIES as readonly string[]).includes(raw)) {
      return raw as AiCapability;
    }
    throw new BadRequestException(`invalid capability: ${raw}`);
  }

  private normalizeAppDefaultModelSlot(value: unknown): AiAppDefaultModelSlot {
    const raw = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    if ((AI_APP_DEFAULT_MODEL_SLOTS as readonly string[]).includes(raw)) {
      return raw as AiAppDefaultModelSlot;
    }
    throw new BadRequestException(`invalid default model slot: ${raw}`);
  }

  private normalizeNullableModelId(value: unknown): string | null {
    const raw = String(value || '').trim();
    return raw || null;
  }

  private normalizeExecutionMode(value: unknown): AiExecutionMode {
    const raw = String(value || 'sync').trim().toLowerCase();
    if (raw === 'sync' || raw === 'async') {
      return raw;
    }
    throw new BadRequestException(`invalid execution_mode: ${raw}`);
  }

  private normalizePricingMode(
    value: unknown,
    capability?: AiCapability,
    legacyPerMtoken?: unknown,
    perCall?: unknown,
    perMinute?: unknown,
  ): AiPricingMode {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'per_mtoken' || raw === 'per_call' || raw === 'per_minute' || raw === 'per_second') {
      return raw;
    }
    if (
      raw === 'per_mchar'
      || raw === 'per_million_char'
      || raw === 'per_million_chars'
      || raw === 'per_million_character'
      || raw === 'per_million_characters'
    ) {
      return 'per_mchar';
    }

    const perMinuteValue = this.toFiniteNumber(perMinute, 0);
    if (perMinuteValue > 0) {
      return 'per_minute';
    }

    const perCallValue = this.toFiniteNumber(perCall, 0);
    if (perCallValue > 0) {
      return 'per_call';
    }

    const perMtokenValue = this.toFiniteNumber(legacyPerMtoken, 0);
    if (perMtokenValue > 0) {
      return 'per_mtoken';
    }

    return capability ? this.defaultPricingModeForCapability(capability) : 'per_mtoken';
  }

  private defaultPricingModeForCapability(capability: AiCapability): AiPricingMode {
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

  private defaultEndpointPathForCapability(capability: AiCapability): string {
    switch (capability) {
      case 'embedding':
        return '/embeddings';
      case 'tts':
        return '/audio/speech';
      case 'stt':
        return '/audio/transcriptions';
      case 'image':
        return '/images/generations';
      case 'video':
        return '/videos/generations';
      case 'chat':
      default:
        return '/chat/completions';
    }
  }

  private defaultEndpointPathForApiType(apiType: string, capability: AiCapability): string {
    const normalizedApiType = String(apiType || '').trim().toLowerCase();
    if (normalizedApiType === OPENROUTER_VIDEO_API_TYPE) {
      return '/videos';
    }
    if (normalizedApiType === OPENROUTER_AUDIO_SPEECH_API_TYPE) {
      return '/audio/speech';
    }
    if (normalizedApiType === OPENROUTER_AUDIO_TRANSCRIPTIONS_API_TYPE) {
      return '/audio/transcriptions';
    }
    if (normalizedApiType === OPENROUTER_EMBEDDINGS_API_TYPE) {
      return '/embeddings';
    }
    if (normalizedApiType === OPENROUTER_CHAT_API_TYPE) {
      return '/chat/completions';
    }
    if (normalizedApiType === RUNNINGHUB_TASK_API_TYPE) {
      return RUNNINGHUB_DEFAULT_QUERY_PATH;
    }
    if (normalizedApiType === ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE) {
      return '/SubmitVideoTranslationJob';
    }
    if (normalizedApiType === DASHSCOPE_NATIVE_IMAGE_API_TYPE) {
      return DASHSCOPE_NATIVE_IMAGE_DEFAULT_ENDPOINT;
    }
    if (normalizedApiType === DASHSCOPE_NATIVE_STT_API_TYPE) {
      return DASHSCOPE_NATIVE_STT_DEFAULT_ENDPOINT;
    }
    if (normalizedApiType === DASHSCOPE_NATIVE_VIDEO_API_TYPE) {
      return DASHSCOPE_NATIVE_VIDEO_DEFAULT_ENDPOINT;
    }
    if (normalizedApiType === DASHSCOPE_VIDEORETALK_API_TYPE) {
      return DASHSCOPE_VIDEORETALK_DEFAULT_ENDPOINT;
    }
    if (normalizedApiType === DASHSCOPE_COSYVOICE_TTS_API_TYPE) {
      return DASHSCOPE_COSYVOICE_TTS_DEFAULT_ENDPOINT;
    }
    if (normalizedApiType === DASHSCOPE_COSYVOICE_VOICE_CLONE_API_TYPE) {
      return DASHSCOPE_COSYVOICE_VOICE_CLONE_DEFAULT_ENDPOINT;
    }
    if (normalizedApiType === MINIMAX_TTS_API_TYPE) {
      return '/audio/speech';
    }
    if (normalizedApiType === MINIMAX_TTS_SYNC_API_TYPE) {
      return '/t2a_v2';
    }
    if (normalizedApiType === MINIMAX_TTS_ASYNC_API_TYPE) {
      return '/t2a_async_v2';
    }
    if (normalizedApiType === MINIMAX_VOICE_CLONE_API_TYPE || normalizedApiType === 'minimax_voice_clone') {
      return '/voice_clone';
    }
    return this.defaultEndpointPathForCapability(capability);
  }

  private isMinimaxTtsApiType(apiType: string): boolean {
    const normalized = String(apiType || '').trim().toLowerCase();
    return normalized === MINIMAX_TTS_SYNC_API_TYPE
      || normalized === MINIMAX_TTS_ASYNC_API_TYPE
      || normalized === MINIMAX_TTS_API_TYPE;
  }

  private isDashscopeCosyVoiceTtsApiType(apiType: string, endpointPath?: string | null): boolean {
    const normalized = String(apiType || '').trim().toLowerCase();
    const endpoint = String(endpointPath || '').trim().toLowerCase();
    return normalized === DASHSCOPE_COSYVOICE_TTS_API_TYPE
      || normalized.includes('cosyvoice')
      || endpoint.includes('/services/audio/tts/speechsynthesizer');
  }

  private isVoiceCloneApiType(apiType: unknown): boolean {
    const normalized = String(apiType || '').trim().toLowerCase();
    return normalized === MINIMAX_VOICE_CLONE_API_TYPE
      || normalized.includes('voice-clone')
      || normalized.includes('voice_clone');
  }

  private isOpenRouterApiType(apiType: unknown): boolean {
    const normalized = String(apiType || '').trim().toLowerCase();
    return normalized === OPENROUTER_CHAT_API_TYPE
      || normalized === OPENROUTER_EMBEDDINGS_API_TYPE
      || normalized === OPENROUTER_AUDIO_SPEECH_API_TYPE
      || normalized === OPENROUTER_AUDIO_TRANSCRIPTIONS_API_TYPE
      || normalized === OPENROUTER_VIDEO_API_TYPE;
  }

  private isOpenRouterSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('openrouter') || url.includes('openrouter.ai');
  }

  private resolveApiTypeForSource(
    apiType: string,
    capability: AiCapability,
    providerType: string,
    baseUrl: string,
    upstreamModel?: string,
  ): string {
    const normalizedApiType = String(apiType || '').trim().toLowerCase();
    if (isRunningHubSource(providerType, baseUrl)) {
      return RUNNINGHUB_TASK_API_TYPE;
    }
    if (this.isAliyunIceSource(providerType, baseUrl)) {
      return normalizedApiType === ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE
        ? ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE
        : (String(apiType || '').trim() || ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE);
    }
    if (this.isOpenRouterSource(providerType, baseUrl)) {
      if (this.isOpenRouterApiType(normalizedApiType)) {
        return normalizedApiType;
      }
      if (capability === 'embedding') {
        return OPENROUTER_EMBEDDINGS_API_TYPE;
      }
      if (capability === 'tts') {
        return OPENROUTER_AUDIO_SPEECH_API_TYPE;
      }
      if (capability === 'stt') {
        return OPENROUTER_AUDIO_TRANSCRIPTIONS_API_TYPE;
      }
      if (capability === 'video') {
        return OPENROUTER_VIDEO_API_TYPE;
      }
      return OPENROUTER_CHAT_API_TYPE;
    }
    const sanitizedApiType = normalizedApiType === RUNNINGHUB_TASK_API_TYPE
      ? 'openai-chat-completions'
      : (String(apiType || '').trim() || 'openai-chat-completions');
    const normalizedSanitizedApiType = sanitizedApiType.toLowerCase();
    if (this.isDashscopeNativeApiType(normalizedSanitizedApiType)) {
      return normalizedSanitizedApiType;
    }
    if (!this.shouldUseDashscopeNativeForCapability(normalizedSanitizedApiType, capability, providerType, baseUrl)) {
      return sanitizedApiType;
    }
    if (capability === 'stt') {
      return DASHSCOPE_NATIVE_STT_API_TYPE;
    }
    if (capability === 'image') {
      return DASHSCOPE_NATIVE_IMAGE_API_TYPE;
    }
    if (capability === 'video') {
      if (this.isDashscopeVideoRetalkModel(upstreamModel) || normalizedSanitizedApiType === DASHSCOPE_VIDEORETALK_API_TYPE) {
        return DASHSCOPE_VIDEORETALK_API_TYPE;
      }
      return DASHSCOPE_NATIVE_VIDEO_API_TYPE;
    }
    return sanitizedApiType;
  }

  private normalizeEndpointPathForProvider(apiType: string, capability: AiCapability, endpointPath: string): string {
    const normalizedPath = this.normalizeEndpointPath(endpointPath);
    if (isRunningHubTaskApiType(apiType)) {
      return normalizedPath;
    }
    if (this.isOpenRouterApiType(apiType)) {
      if (capability === 'image') {
        return '/chat/completions';
      }
      return this.defaultEndpointPathForApiType(apiType, capability);
    }
    if (!this.isDashscopeNativeApiType(apiType)) {
      return normalizedPath;
    }
    if (capability === 'stt' && (normalizedPath === '/audio/transcriptions' || normalizedPath === '/v1/audio/transcriptions')) {
      return DASHSCOPE_NATIVE_STT_DEFAULT_ENDPOINT;
    }
    if (capability === 'image' && (normalizedPath === '/images/generations' || normalizedPath === '/v1/images/generations')) {
      return DASHSCOPE_NATIVE_IMAGE_DEFAULT_ENDPOINT;
    }
    if (apiType === DASHSCOPE_VIDEORETALK_API_TYPE) {
      return DASHSCOPE_VIDEORETALK_DEFAULT_ENDPOINT;
    }
    if (capability === 'video' && (normalizedPath === '/videos/generations' || normalizedPath === '/v1/videos/generations')) {
      return DASHSCOPE_NATIVE_VIDEO_DEFAULT_ENDPOINT;
    }
    return normalizedPath;
  }

  private shouldUseDashscopeNativeForCapability(
    apiType: string,
    capability: AiCapability,
    providerType: string,
    baseUrl: string,
  ): boolean {
    if (capability !== 'image' && capability !== 'stt' && capability !== 'video') {
      return false;
    }
    if (this.isAliyunIceSource(providerType, baseUrl)) {
      return false;
    }
    if (this.isDashscopeNativeApiType(apiType)) {
      return true;
    }
    if (!this.isDashscopeSource(providerType, baseUrl)) {
      return false;
    }
    return true;
  }

  private isDashscopeNativeApiType(apiType: string): boolean {
    const normalized = String(apiType || '').trim().toLowerCase();
    return normalized === DASHSCOPE_NATIVE_IMAGE_API_TYPE
      || normalized === DASHSCOPE_NATIVE_STT_API_TYPE
      || normalized === DASHSCOPE_NATIVE_VIDEO_API_TYPE
      || normalized === DASHSCOPE_VIDEORETALK_API_TYPE
      || normalized.startsWith('dashscope-native')
      || normalized.startsWith('aliyun-native');
  }

  private isDashscopeVideoRetalkModel(value: unknown): boolean {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') === 'videoretalk';
  }

  private isDashscopeSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    if (this.isAliyunIceSource(provider, url)) {
      return false;
    }
    return provider.includes('dashscope')
      || provider.includes('aliyun')
      || url.includes('dashscope.aliyuncs.com')
      || url.includes('dashscope-intl.aliyuncs.com')
      || url.includes('dashscope-us.aliyuncs.com');
  }

  private isAliyunIceSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider === ALIYUN_ICE_PROVIDER_TYPE
      || provider.includes('aliyun-ice')
      || (url.includes('ice.') && url.includes('aliyuncs.com'));
  }

  private async testAliyunIceSourceConnectivity(input: {
    providerType: string;
    baseUrl: string;
    apiKey: string;
    customHeaders: Record<string, string>;
    timeoutMs: number;
  }): Promise<AiSourceConnectivityTestResult> {
    const startedAt = Date.now();
    const endpoint = this.normalizeAliyunIceEndpoint(input.customHeaders.endpoint || input.baseUrl);
    const testJobId = String(input.customHeaders.test_job_id || input.customHeaders.testJobId || '').trim();
    try {
      if (!this.resolveAliyunIceAccessKeySecret(input.customHeaders)) {
        return {
          ok: false,
          status_code: null,
          latency_ms: Date.now() - startedAt,
          endpoint_url: endpoint,
          provider_type: input.providerType,
          message: '请在自定义请求头中填写 access_key_secret',
          response_excerpt: '',
        };
      }
      if (!testJobId) {
        return {
          ok: true,
          status_code: null,
          latency_ms: Date.now() - startedAt,
          endpoint_url: endpoint,
          provider_type: input.providerType,
          message: '凭据格式已通过；填写 test_job_id 后可查询验证',
          response_excerpt: '',
        };
      }
      const sdk = await import('@alicloud/ice20201109');
      const client = this.createAliyunIceProbeClient(input.apiKey, input.baseUrl, input.customHeaders, sdk);
      const request = new (sdk as any).GetSmartHandleJobRequest({ jobId: testJobId });
      const response = await Promise.race([
        client.getSmartHandleJob(request),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`连接超时（>${input.timeoutMs}ms）`)), input.timeoutMs)),
      ]);
      const body = this.normalizeAliyunIceProbeResponse(response);
      return {
        ok: true,
        status_code: 200,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpoint,
        provider_type: input.providerType,
        message: '连通性测试通过',
        response_excerpt: this.truncate(JSON.stringify(body), 500),
      };
    } catch (error: any) {
      return {
        ok: false,
        status_code: null,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpoint,
        provider_type: input.providerType,
        message: `连接失败：${error?.message || 'unknown error'}`,
        response_excerpt: '',
      };
    }
  }

  private async testAliyunIceModelConnectivity(input: {
    source: AiGlobalSourceRow;
    modelKey: string;
    upstreamModel: string;
    timeoutMs: number;
  }): Promise<AiModelConnectivityTestResult> {
    const startedAt = Date.now();
    const customHeaders = this.normalizeStringObject(input.source.custom_headers);
    const endpoint = this.normalizeAliyunIceEndpoint(customHeaders.endpoint || input.source.base_url);
    const testJobId = String(customHeaders.test_job_id || customHeaders.testJobId || '').trim();
    try {
      if (!this.resolveAliyunIceAccessKeySecret(customHeaders)) {
        return {
          ok: false,
          status_code: null,
          latency_ms: Date.now() - startedAt,
          endpoint_url: endpoint,
          model_key: input.modelKey,
          upstream_model: input.upstreamModel,
          source_id: input.source.id,
          source_name: input.source.name,
          provider_type: input.source.provider_type,
          message: '请在供应商自定义请求头中填写 access_key_secret',
          response_excerpt: '',
        };
      }
      if (!testJobId) {
        return {
          ok: true,
          status_code: null,
          latency_ms: Date.now() - startedAt,
          endpoint_url: endpoint,
          model_key: input.modelKey,
          upstream_model: input.upstreamModel,
          source_id: input.source.id,
          source_name: input.source.name,
          provider_type: input.source.provider_type,
          message: '模型配置已通过；填写 test_job_id 后可查询验证',
          response_excerpt: '',
        };
      }
      const sdk = await import('@alicloud/ice20201109');
      const client = this.createAliyunIceProbeClient(input.source.api_key, input.source.base_url, customHeaders, sdk);
      const request = new (sdk as any).GetSmartHandleJobRequest({ jobId: testJobId });
      const response = await Promise.race([
        client.getSmartHandleJob(request),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`连接超时（>${input.timeoutMs}ms）`)), input.timeoutMs)),
      ]);
      const body = this.normalizeAliyunIceProbeResponse(response);
      return {
        ok: true,
        status_code: 200,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpoint,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: '模型测试通过',
        response_excerpt: this.truncate(JSON.stringify(body), 500),
      };
    } catch (error: any) {
      return {
        ok: false,
        status_code: null,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpoint,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: `连接失败：${error?.message || 'unknown error'}`,
        response_excerpt: '',
      };
    }
  }

  private createAliyunIceProbeClient(
    accessKeyId: string,
    baseUrl: string,
    customHeaders: Record<string, string>,
    sdk: any,
  ): any {
    const accessKeySecret = this.resolveAliyunIceAccessKeySecret(customHeaders);
    if (!accessKeyId || !accessKeySecret) {
      throw new BadRequestException('Aliyun ICE source requires api_key and access_key_secret');
    }
    const Client = sdk.default || sdk.Client || sdk;
    return new Client({
      accessKeyId,
      accessKeySecret,
      regionId: customHeaders.region_id || customHeaders.regionId || this.extractAliyunRegionFromEndpoint(baseUrl) || 'cn-shanghai',
      endpoint: this.normalizeAliyunIceEndpoint(customHeaders.endpoint || baseUrl),
      protocol: 'HTTPS',
      readTimeout: 30_000,
      connectTimeout: 10_000,
    });
  }

  private resolveAliyunIceAccessKeySecret(customHeaders: Record<string, string>): string {
    return String(
      customHeaders.access_key_secret
      || customHeaders.accessKeySecret
      || customHeaders.secret
      || customHeaders.secret_key
      || customHeaders.access_key
      || '',
    ).trim();
  }

  private normalizeAliyunIceEndpoint(value: string): string {
    return String(value || 'ice.cn-shanghai.aliyuncs.com')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '') || 'ice.cn-shanghai.aliyuncs.com';
  }

  private extractAliyunRegionFromEndpoint(value: string): string | null {
    const endpoint = String(value || '').trim().toLowerCase();
    const match = endpoint.match(/(?:^|\.)(cn-[a-z0-9-]+|ap-[a-z0-9-]+|us-[a-z0-9-]+|eu-[a-z0-9-]+)\.aliyuncs\.com/);
    return match?.[1] || null;
  }

  private normalizeAliyunIceProbeResponse(response: any): Record<string, unknown> {
    const rawBody = response?.body;
    return this.normalizeObject(typeof rawBody?.toMap === 'function' ? rawBody.toMap() : rawBody);
  }

  private normalizeDashscopeNativeBaseUrl(baseUrl: string): string {
    try {
      const parsed = new URL(baseUrl);
      parsed.hash = '';
      parsed.search = '';
      let pathname = parsed.pathname.replace(/\/+$/, '');
      pathname = pathname.replace(/\/compatible-mode(?:\/v1)?$/i, '');
      parsed.pathname = pathname || '';
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return baseUrl.replace(/\/+$/, '');
    }
  }

  private joinDashscopeNativeUrl(baseUrl: string, endpointPath: string): string {
    const normalizedBase = this.normalizeDashscopeNativeBaseUrl(baseUrl);
    let normalizedPath = this.normalizeEndpointPath(endpointPath);
    if (
      normalizedBase.toLowerCase().endsWith('/api/v1')
      && normalizedPath.toLowerCase().startsWith('/api/v1/')
    ) {
      normalizedPath = normalizedPath.slice('/api/v1'.length);
    }
    return this.joinUrl(normalizedBase, normalizedPath);
  }

  private normalizeDashscopeImageSize(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) {
      return '1024*1024';
    }
    if (/^[12]k$/i.test(raw)) {
      return raw.toUpperCase();
    }
    const matched = raw.match(/^(\d{2,5})\s*[xX*]\s*(\d{2,5})$/);
    if (matched) {
      return `${matched[1]}*${matched[2]}`;
    }
    return raw.replace(/x/gi, '*');
  }

  private isDashscopeQwenImageModel(upstreamModel: string): boolean {
    const compact = String(upstreamModel || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return compact.includes('qwenimage');
  }

  private resolveDashscopeWan27VideoMode(upstreamModel: string): 't2v' | 'i2v' | 'r2v' | null {
    const compact = String(upstreamModel || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (compact.includes('wan27t2v')) {
      return 't2v';
    }
    if (compact.includes('wan27r2v')) {
      return 'r2v';
    }
    if (compact.includes('wan27i2v')) {
      return 'i2v';
    }
    return null;
  }

  private resolveDashscopeImageProbeEndpointPath(endpointPath: string, upstreamModel: string): string {
    if (this.isDashscopeQwenImageModel(upstreamModel)) {
      return DASHSCOPE_NATIVE_IMAGE_MULTIMODAL_ENDPOINT;
    }
    return endpointPath;
  }

  private buildDashscopeNativeProbePayload(
    capability: AiCapability,
    upstreamModel: string,
    testPrompt: string,
    requestOverrides: Record<string, unknown>,
    endpointPath: string,
  ): Record<string, unknown> {
    if (capability === 'stt') {
      const parameters = {
        ...this.normalizeObject(requestOverrides.parameters),
      };
      if (requestOverrides.language_hints !== undefined && parameters.language_hints === undefined) {
        parameters.language_hints = requestOverrides.language_hints;
      }
      return {
        ...requestOverrides,
        model: upstreamModel,
        input: {
          file_urls: ['https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3'],
        },
        parameters,
      };
    }

    if (capability === 'image') {
      const parameters = {
        ...this.normalizeObject(requestOverrides.parameters),
      };
      if (parameters.n === undefined) {
        parameters.n = 1;
      }
      if (parameters.size === undefined) {
        parameters.size = this.normalizeDashscopeImageSize(requestOverrides.size || '1024x1024');
      }
      const useMultimodalPayload = endpointPath.includes('/multimodal-generation/')
        || this.isDashscopeQwenImageModel(upstreamModel);
      if (useMultimodalPayload) {
        return {
          ...requestOverrides,
          model: upstreamModel,
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    text: testPrompt || 'test image',
                  },
                ],
              },
            ],
          },
          parameters,
        };
      }
      return {
        ...requestOverrides,
        model: upstreamModel,
        input: {
          prompt: testPrompt || 'test image',
        },
        parameters,
      };
    }

    if (capability === 'video') {
      const parameters = {
        ...this.normalizeObject(requestOverrides.parameters),
      };
      if (parameters.resolution === undefined) {
        parameters.resolution = '720P';
      }
      if (parameters.duration === undefined) {
        parameters.duration = 5;
      }
      if (parameters.prompt_extend === undefined) {
        parameters.prompt_extend = true;
      }
      if (parameters.watermark === undefined) {
        parameters.watermark = false;
      }
      if (this.isDashscopeVideoRetalkModel(upstreamModel)) {
        delete parameters.resolution;
        delete parameters.duration;
        delete parameters.prompt_extend;
        delete parameters.watermark;
        return {
          ...requestOverrides,
          model: upstreamModel,
          input: {
            video_url: DASHSCOPE_VIDEORETALK_TEST_VIDEO_URL,
            audio_url: DASHSCOPE_VIDEORETALK_TEST_AUDIO_URL,
          },
          parameters: {
            ...parameters,
            video_extension: parameters.video_extension ?? false,
          },
        };
      }
      const wan27Mode = this.resolveDashscopeWan27VideoMode(upstreamModel);
      if (wan27Mode === 't2v') {
        return {
          ...requestOverrides,
          model: upstreamModel,
          input: {
            prompt: testPrompt || '一只小猫在草地上奔跑',
          },
          parameters: {
            ...parameters,
            ratio: parameters.ratio || '16:9',
          },
        };
      }
      if (wan27Mode === 'r2v') {
        return {
          ...requestOverrides,
          model: upstreamModel,
          input: {
            prompt: testPrompt || '图片 1 走进咖啡厅，微笑着看向镜头',
            media: [
              {
                type: 'reference_image',
                url: DASHSCOPE_NATIVE_VIDEO_TEST_IMAGE_URL,
              },
            ],
          },
          parameters: {
            ...parameters,
            ratio: parameters.ratio || '16:9',
          },
        };
      }
      if (wan27Mode === 'i2v') {
        return {
          ...requestOverrides,
          model: upstreamModel,
          input: {
            prompt: testPrompt || '一只小猫在草地上奔跑',
            media: [
              {
                type: 'first_frame',
                url: DASHSCOPE_NATIVE_VIDEO_TEST_IMAGE_URL,
              },
            ],
          },
          parameters,
        };
      }
      return {
        ...requestOverrides,
        model: upstreamModel,
        input: {
          prompt: testPrompt || '一只小猫在草地上奔跑',
          img_url: DASHSCOPE_NATIVE_VIDEO_TEST_IMAGE_URL,
        },
        parameters,
      };
    }

    return {
      ...requestOverrides,
      model: upstreamModel,
      messages: [{ role: 'user', content: testPrompt || 'ping' }],
      temperature: 0,
      max_tokens: 1,
      stream: false,
    };
  }

  private isGoogleSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('google')
      || provider.includes('vertex')
      || provider.includes('gemini')
      || url.includes('generativelanguage.googleapis.com')
      || url.includes('aiplatform.googleapis.com')
      || url.includes('/models/gemini');
  }

  private isVertexAiSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('vertex')
      || provider.includes('google-vertex')
      || url.includes('aiplatform.googleapis.com');
  }

  private isAnthropicSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('anthropic')
      || url.includes('api.anthropic.com')
      || url.includes('/anthropic');
  }

  private normalizeAnthropicBaseUrl(rawBaseUrl: string): string {
    const baseUrl = String(rawBaseUrl || '').trim();
    if (!baseUrl) {
      return '';
    }

    try {
      const parsed = new URL(baseUrl);
      parsed.pathname = parsed.pathname
        .replace(/\/+(messages|models)$/i, '')
        .replace(/\/+$/, '')
        .replace(/\/v1$/i, '');
      parsed.hash = '';
      parsed.search = '';
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return baseUrl
        .replace(/\/+(messages|models)$/i, '')
        .replace(/\/+$/, '')
        .replace(/\/v1$/i, '');
    }
  }

  private shouldUseAnthropicBearerAuth(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const normalizedBase = this.normalizeAnthropicBaseUrl(baseUrl).toLowerCase();
    if (provider.includes('official') || normalizedBase.includes('api.anthropic.com')) {
      return false;
    }
    return provider.includes('compatible');
  }

  private normalizeAnthropicHeaders(value: unknown): Record<string, string> {
    const headers = this.normalizeStringObject(value);
    Object.keys(headers).forEach((key) => {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'authorization' || normalizedKey === 'x-api-key') {
        delete headers[key];
      }
    });
    return headers;
  }

  private createAnthropicClient(source: {
    provider_type: string;
    base_url: string;
    api_key: string;
    custom_headers: unknown;
  }): Anthropic {
    const baseURL = this.normalizeAnthropicBaseUrl(source.base_url);
    const defaultHeaders = this.normalizeAnthropicHeaders(source.custom_headers);
    const useBearerAuth = this.shouldUseAnthropicBearerAuth(source.provider_type, baseURL);
    return new Anthropic({
      baseURL,
      ...(useBearerAuth ? { authToken: source.api_key } : { apiKey: source.api_key }),
      ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
      maxRetries: 0,
    });
  }

  private buildAnthropicProbeEndpointUrl(baseUrl: string, resource: 'models' | 'messages'): string {
    return this.joinUrl(this.normalizeAnthropicBaseUrl(baseUrl), `/v1/${resource}`);
  }

  private resolveGoogleGenAiBase(rawBaseUrl: string): { baseUrl?: string; apiVersion?: string } {
    const baseUrl = String(rawBaseUrl || '').trim();
    if (!baseUrl) {
      return {};
    }

    try {
      const parsed = new URL(baseUrl);
      const segments = parsed.pathname.split('/').filter((item) => !!item);
      const versionIndex = segments.findIndex((item) => /^v\d+(?:alpha|beta)?$/i.test(item));
      let apiVersion: string | undefined;
      if (versionIndex >= 0) {
        apiVersion = segments[versionIndex];
        const pathname = segments.slice(0, versionIndex).join('/');
        parsed.pathname = pathname ? `/${pathname}` : '';
      } else {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      }
      parsed.hash = '';
      parsed.search = '';
      return {
        baseUrl: parsed.toString().replace(/\/+$/, ''),
        apiVersion,
      };
    } catch {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ''),
      };
    }
  }

  private createGoogleGenAiClient(source: AiGlobalSourceRow): GoogleGenAI {
    const resolved = this.resolveGoogleGenAiBase(source.base_url);
    const headers = this.normalizeStringObject(source.custom_headers);
    const credentials = this.normalizeObject(source.credentials_json);
    const httpOptions: Record<string, unknown> = {};
    if (resolved.baseUrl) {
      httpOptions.baseUrl = resolved.baseUrl;
    }
    if (resolved.apiVersion) {
      httpOptions.apiVersion = resolved.apiVersion;
    }
    if (Object.keys(headers).length > 0) {
      httpOptions.headers = headers;
    }
    if (this.isVertexAiSource(source.provider_type, source.base_url)) {
      const authMode = String(credentials.auth_mode || 'api_key');
      if (authMode === 'api_key') {
        return new GoogleGenAI({
          vertexai: true,
          apiKey: source.api_key,
          project: String(credentials.project_id || ''),
          location: String(credentials.location || 'global'),
          ...(resolved.apiVersion ? { apiVersion: resolved.apiVersion } : {}),
          ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
        });
      }
      const serviceAccountJson = this.normalizeObject(credentials.service_account_json);
      const googleAuthOptions: Record<string, unknown> = {
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      };
      if (authMode === 'service_account_json' && Object.keys(serviceAccountJson).length > 0) {
        googleAuthOptions.credentials = serviceAccountJson;
      }
      return new GoogleGenAI({
        vertexai: true,
        project: String(credentials.project_id || ''),
        location: String(credentials.location || 'global'),
        googleAuthOptions,
        ...(resolved.apiVersion ? { apiVersion: resolved.apiVersion } : {}),
        ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
      });
    }
    return new GoogleGenAI({
      apiKey: source.api_key,
      ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
    });
  }

  private buildGoogleProbeEndpointUrl(baseUrl: string, upstreamModel: string, capability: AiCapability): string {
    const resolved = this.resolveGoogleGenAiBase(baseUrl);
    const root = String(resolved.baseUrl || baseUrl || '').replace(/\/+$/, '');
    const version = resolved.apiVersion || 'v1beta';
    const model = String(upstreamModel || '').trim();
    const action = capability === 'embedding' ? 'embedContent' : 'generateContent';
    return `${root}/${version}/models/${model}:${action}`;
  }

  private async testSourceConnectivityViaAnthropicSdk(input: {
    providerType: string;
    baseUrl: string;
    apiKey: string;
    customHeaders: Record<string, string>;
    timeoutMs: number;
  }): Promise<AiSourceConnectivityTestResult> {
    const startedAt = Date.now();
    const endpointUrl = this.buildAnthropicProbeEndpointUrl(input.baseUrl, 'models');
    const client = this.createAnthropicClient({
      provider_type: input.providerType,
      base_url: input.baseUrl,
      api_key: input.apiKey,
      custom_headers: input.customHeaders,
    });

    try {
      const page = await this.awaitWithTimeout(client.models.list({ limit: 1 }), input.timeoutMs);
      const firstModel = Array.isArray(page.data) && page.data.length > 0 ? page.data[0] : null;
      return {
        ok: true,
        status_code: 200,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpointUrl,
        provider_type: input.providerType,
        message: '连通性测试通过',
        response_excerpt: firstModel?.id ? `model=${firstModel.id}` : 'models=ok',
      };
    } catch (error: any) {
      const statusCodeRaw = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
      const statusCode = Number.isFinite(statusCodeRaw) ? statusCodeRaw : null;
      const message = this.resolveAiSdkErrorMessage(error);
      const timedOut = /timed out/i.test(String(message || ''));
      return {
        ok: false,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpointUrl,
        provider_type: input.providerType,
        message: timedOut
          ? `连接超时（>${input.timeoutMs}ms）`
          : statusCode
            ? `上游返回 ${statusCode} (anthropic)`
            : `连接失败：${message}`,
        response_excerpt: this.truncate(message, 500),
      };
    }
  }

  private async testModelConnectivityViaAnthropicSdk(input: {
    endpointUrl: string;
    source: AiGlobalSourceRow;
    modelKey: string;
    capability: AiCapability;
    upstreamModel: string;
    testPrompt: string;
    timeoutMs: number;
  }): Promise<AiModelConnectivityTestResult> {
    const startedAt = Date.now();
    if (input.capability !== 'chat') {
      return {
        ok: false,
        status_code: null,
        latency_ms: 0,
        endpoint_url: input.endpointUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: 'Anthropic 源当前只支持 Chat 模型测试',
        response_excerpt: '',
      };
    }

    const client = this.createAnthropicClient(input.source);
    try {
      const message = await this.awaitWithTimeout(
        client.messages.create({
          model: input.upstreamModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: input.testPrompt || 'ping' }],
        } as any),
        input.timeoutMs,
      );
      const text = Array.isArray(message.content)
        ? message.content
          .filter((item: any) => item?.type === 'text' && typeof item?.text === 'string')
          .map((item: any) => item.text)
          .join('\n')
        : '';
      return {
        ok: true,
        status_code: 200,
        latency_ms: Date.now() - startedAt,
        endpoint_url: input.endpointUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: '模型测试通过',
        response_excerpt: this.truncate(text || `stop_reason=${String(message.stop_reason || 'end_turn')}`, 500),
      };
    } catch (error: any) {
      const statusCodeRaw = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
      const statusCode = Number.isFinite(statusCodeRaw) ? statusCodeRaw : null;
      const message = this.resolveAiSdkErrorMessage(error);
      const timedOut = /timed out/i.test(String(message || ''));
      return {
        ok: false,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
        endpoint_url: input.endpointUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: timedOut
          ? `连接超时（>${input.timeoutMs}ms）`
          : statusCode
            ? `上游返回 ${statusCode} (anthropic)`
            : `连接失败：${message}`,
        response_excerpt: this.truncate(message, 500),
      };
    }
  }

  private async testSourceConnectivityViaGoogleGenAiSdk(input: {
    source: AiGlobalSourceRow;
    timeoutMs: number;
  }): Promise<AiSourceConnectivityTestResult> {
    const startedAt = Date.now();
    const client = this.createGoogleGenAiClient(input.source);
    const credentials = this.normalizeObject(input.source.credentials_json);
    const isVertexSource = this.isVertexAiSource(input.source.provider_type, input.source.base_url);
    const probeModel = 'gemini-2.5-flash';
    const endpointUrl = isVertexSource
      ? `vertex://${String(credentials.project_id || '')}/${String(credentials.location || '')}/models`
      : this.buildGoogleProbeEndpointUrl(input.source.base_url, probeModel, 'chat');

    try {
      if (isVertexSource) {
        const pager = await this.awaitWithTimeout(client.models.list({ config: { pageSize: 1 } }), input.timeoutMs);
        const firstModel = pager.page?.[0] as any;
        return {
          ok: true,
          status_code: 200,
          latency_ms: Date.now() - startedAt,
          endpoint_url: endpointUrl,
          provider_type: input.source.provider_type,
          message: '连通性测试通过',
          response_excerpt: firstModel?.name || firstModel?.displayName || 'models=ok',
        };
      }

      const response = await this.awaitWithTimeout(client.models.generateContent({
        model: probeModel,
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        config: {
          maxOutputTokens: 1,
          temperature: 0,
        },
      } as any), input.timeoutMs);
      return {
        ok: true,
        status_code: 200,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpointUrl,
        provider_type: input.source.provider_type,
        message: '连通性测试通过',
        response_excerpt: this.truncate(response.text || response.responseId || 'generateContent=ok', 500),
      };
    } catch (error: any) {
      const statusCodeRaw = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
      const statusCode = Number.isFinite(statusCodeRaw) ? statusCodeRaw : null;
      const message = this.resolveAiSdkErrorMessage(error);
      const timedOut = /timed out/i.test(String(message || ''));
      return {
        ok: false,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
        endpoint_url: endpointUrl,
        provider_type: input.source.provider_type,
        message: timedOut
          ? `连接超时（>${input.timeoutMs}ms）`
          : statusCode
            ? `上游返回 ${statusCode} (google-genai)`
            : `连接失败：${message}`,
        response_excerpt: this.truncate(message, 500),
      };
    }
  }

  private async testModelConnectivityViaGoogleGenAiSdk(input: {
    endpointUrl: string;
    source: AiGlobalSourceRow;
    modelKey: string;
    capability: AiCapability;
    upstreamModel: string;
    apiType: string;
    testPrompt: string;
    timeoutMs: number;
  }): Promise<AiModelConnectivityTestResult> {
    const startedAt = Date.now();
    const client = this.createGoogleGenAiClient(input.source);

    try {
      let excerpt = '';
      switch (input.capability) {
        case 'embedding': {
          const result = await this.awaitWithTimeout(
            client.models.embedContent({
              model: input.upstreamModel,
              contents: [input.testPrompt || 'ping'],
            }),
            input.timeoutMs,
          );
          excerpt = `embedding_length=${result.embeddings?.[0]?.values?.length || 0}`;
          break;
        }
        case 'image': {
          const result = await this.awaitWithTimeout(
            client.models.generateContent({
              model: input.upstreamModel,
              contents: input.testPrompt || 'test image',
              config: {
                responseModalities: [Modality.IMAGE],
                imageConfig: {
                  aspectRatio: '1:1',
                  imageSize: '1K',
                },
              },
            }),
            input.timeoutMs,
          );
          const imageCount = (result.candidates || []).reduce((count, candidate) => {
            const parts = Array.isArray(candidate?.content?.parts) ? candidate.content?.parts || [] : [];
            return count + parts.filter((part) => !!part?.inlineData?.data).length;
          }, 0);
          excerpt = `images=${imageCount}`;
          break;
        }
        case 'tts': {
          const result = await this.awaitWithTimeout(
            client.models.generateContent({
              model: input.upstreamModel,
              contents: [{ role: 'user', parts: [{ text: input.testPrompt || 'Say hello.' }] }],
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: 'Kore',
                    },
                  },
                },
              },
            } as any),
            input.timeoutMs,
          );
          const audioCount = (result.candidates || []).reduce((count, candidate) => {
            const parts = Array.isArray(candidate?.content?.parts) ? candidate.content?.parts || [] : [];
            return count + parts.filter((part) => {
              const mimeType = String(part?.inlineData?.mimeType || '').toLowerCase();
              return !!part?.inlineData?.data && mimeType.startsWith('audio/');
            }).length;
          }, 0);
          excerpt = `audio_parts=${audioCount}`;
          break;
        }
        case 'chat':
        default: {
          const result = await this.awaitWithTimeout(
            client.models.generateContent({
              model: input.upstreamModel,
              contents: input.testPrompt || 'ping',
              config: {
                temperature: 0,
                maxOutputTokens: 1,
              },
            }),
            input.timeoutMs,
          );
          excerpt = this.truncate(String(result.text || ''), 500);
          break;
        }
      }

      return {
        ok: true,
        status_code: 200,
        latency_ms: Date.now() - startedAt,
        endpoint_url: input.endpointUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: '模型测试通过',
        response_excerpt: excerpt,
      };
    } catch (error: any) {
      const statusCodeRaw = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
      const statusCode = Number.isFinite(statusCodeRaw) ? statusCodeRaw : null;
      const message = this.resolveAiSdkErrorMessage(error);
      const timedOut = /timed out/i.test(String(message || ''));
      return {
        ok: false,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
        endpoint_url: input.endpointUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: timedOut
          ? `连接超时（>${input.timeoutMs}ms）`
          : statusCode
            ? `上游返回 ${statusCode} (google-genai)`
            : `连接失败：${message}`,
        response_excerpt: this.truncate(message, 500),
      };
    }
  }

  private async testModelConnectivityViaAiSdk(input: {
    endpointUrl: string;
    source: AiGlobalSourceRow;
    modelKey: string;
    capability: AiCapability;
    upstreamModel: string;
    apiType: string;
    testPrompt: string;
    timeoutMs: number;
  }): Promise<AiModelConnectivityTestResult> {
    const startedAt = Date.now();
    const provider = createOpenAI({
      baseURL: input.source.base_url,
      apiKey: input.source.api_key,
      headers: this.normalizeStringObject(input.source.custom_headers),
    });

    try {
      let excerpt = '';
      switch (input.capability) {
        case 'embedding': {
          const result = await this.awaitWithTimeout(
            embed({
              model: provider.embedding(input.upstreamModel),
              value: input.testPrompt || 'ping',
            }),
            input.timeoutMs,
          );
          excerpt = `embedding_length=${result.embedding.length}`;
          break;
        }
        case 'image': {
          const result = await this.awaitWithTimeout(
            generateImage({
              model: provider.image(input.upstreamModel),
              prompt: input.testPrompt || 'test image',
              n: 1,
              size: '512x512',
            }),
            input.timeoutMs,
          );
          excerpt = `images=${result.images.length}`;
          break;
        }
        case 'tts': {
          const result = await this.awaitWithTimeout(
            experimental_generateSpeech({
              model: provider.speech(input.upstreamModel),
              text: input.testPrompt || 'ping',
              voice: 'alloy',
            }),
            input.timeoutMs,
          );
          excerpt = `audio_format=${result.audio.format}`;
          break;
        }
        case 'stt': {
          const result = await this.awaitWithTimeout(
            experimental_transcribe({
              model: provider.transcription(input.upstreamModel),
              audio: new URL('https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3'),
            }),
            input.timeoutMs,
          );
          excerpt = `text_len=${String(result.text || '').length}`;
          break;
        }
        case 'chat':
        default: {
          const result = await this.awaitWithTimeout(
            generateText({
              model: provider.chat(input.upstreamModel),
              prompt: input.testPrompt || 'ping',
              temperature: 0,
              maxOutputTokens: 1,
            }),
            input.timeoutMs,
          );
          excerpt = this.truncate(String(result.text || ''), 500);
          break;
        }
      }

      return {
        ok: true,
        status_code: 200,
        latency_ms: Date.now() - startedAt,
        endpoint_url: input.endpointUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: '模型测试通过',
        response_excerpt: excerpt,
      };
    } catch (error: any) {
      const statusCodeRaw = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
      const statusCode = Number.isFinite(statusCodeRaw) ? statusCodeRaw : null;
      const message = this.resolveAiSdkErrorMessage(error);
      const timedOut = /timed out/i.test(String(message || ''));
      return {
        ok: false,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
        endpoint_url: input.endpointUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: timedOut
          ? `连接超时（>${input.timeoutMs}ms）`
          : statusCode
            ? `上游返回 ${statusCode} (${input.apiType})`
            : `连接失败：${message}`,
        response_excerpt: this.truncate(message, 500),
      };
    }
  }

  private async awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(500, Math.round(timeoutMs)) : 12000;
    let timer: NodeJS.Timeout | null = null;
    return new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`request timed out after ${safeTimeoutMs}ms`));
      }, safeTimeoutMs);
      promise
        .then((value) => resolve(value))
        .catch((error) => reject(error))
        .finally(() => {
          if (timer) {
            clearTimeout(timer);
          }
        });
    });
  }

  private resolveAiSdkErrorMessage(error: unknown): string {
    if (!error) {
      return 'unknown error';
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      const anyErr = error as any;
      if (typeof anyErr.responseBody === 'string' && anyErr.responseBody.trim()) {
        return anyErr.responseBody.trim();
      }
      if (typeof anyErr.body === 'string' && anyErr.body.trim()) {
        return anyErr.body.trim();
      }
      if (anyErr.body && typeof anyErr.body === 'object') {
        try {
          return JSON.stringify(anyErr.body);
        } catch {
          // ignore
        }
      }
      return error.message || 'unknown error';
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private buildOpenAiCompatibleProbePayload(
    capability: AiCapability,
    upstreamModel: string,
    testPrompt: string,
    requestOverrides: Record<string, unknown>,
  ): Record<string, unknown> {
    if (capability === 'embedding') {
      return {
        ...requestOverrides,
        model: upstreamModel,
        input: testPrompt || 'ping',
      };
    }
    if (capability === 'image') {
      return {
        ...requestOverrides,
        model: upstreamModel,
        prompt: testPrompt || 'test image',
        n: Number(requestOverrides.n ?? 1),
        size: String(requestOverrides.size || '512x512'),
      };
    }
    if (capability === 'tts') {
      return {
        ...requestOverrides,
        model: upstreamModel,
        input: testPrompt || 'ping',
        voice: String(requestOverrides.voice || requestOverrides.voice_id || 'alloy'),
      };
    }
    return {
      ...requestOverrides,
      model: upstreamModel,
      messages: [{ role: 'user', content: testPrompt || 'ping' }],
      temperature: 0,
      max_tokens: 1,
      stream: false,
    };
  }

  private buildOpenRouterProbePayload(
    capability: AiCapability,
    upstreamModel: string,
    testPrompt: string,
    requestOverrides: Record<string, unknown>,
  ): Record<string, unknown> {
    if (capability === 'stt') {
      return {
        ...requestOverrides,
        model: upstreamModel,
        input_audio: {
          data: this.buildTinyWavProbeBuffer().toString('base64'),
          format: 'wav',
        },
        language: String(requestOverrides.language || 'en'),
      };
    }
    if (capability === 'tts') {
      const normalizedModel = String(upstreamModel || '').trim().toLowerCase();
      const responseFormat = normalizedModel.includes('gemini') && normalizedModel.includes('tts')
        ? 'pcm'
        : String(requestOverrides.response_format || requestOverrides.format || 'mp3');
      return {
        ...requestOverrides,
        model: upstreamModel,
        input: testPrompt || 'ping',
        voice: String(requestOverrides.voice || requestOverrides.voice_id || 'alloy'),
        response_format: responseFormat,
      };
    }
    if (capability === 'image') {
      return {
        ...requestOverrides,
        model: upstreamModel,
        messages: [{ role: 'user', content: testPrompt || 'test image' }],
        modalities: Array.isArray(requestOverrides.modalities) ? requestOverrides.modalities : ['image', 'text'],
        stream: false,
      };
    }
    if (capability === 'video') {
      return {
        ...requestOverrides,
        model: upstreamModel,
        prompt: testPrompt || 'A short static product shot on a clean background',
      };
    }
    return this.buildOpenAiCompatibleProbePayload(capability, upstreamModel, testPrompt, requestOverrides);
  }

  private buildOpenAiSttProbeForm(upstreamModel: string, requestOverrides: Record<string, unknown>): FormData {
    const form = new FormData();
    form.append('model', upstreamModel);

    const appendIfPrimitive = (key: string) => {
      const value = requestOverrides[key];
      if (value === undefined || value === null) {
        return;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        form.append(key, String(value));
      }
    };

    ['language', 'prompt', 'response_format', 'temperature'].forEach((key) => appendIfPrimitive(key));
    const timestampGranularities = requestOverrides.timestamp_granularities;
    if (Array.isArray(timestampGranularities)) {
      timestampGranularities.forEach((item) => {
        if (item !== undefined && item !== null) {
          form.append('timestamp_granularities[]', String(item));
        }
      });
    }

    const probeBuffer = this.buildTinyWavProbeBuffer();
    const probeBytes = Uint8Array.from(probeBuffer);
    const probeFile = new Blob([probeBytes], { type: 'audio/wav' });
    form.append('file', probeFile, 'probe.wav');
    return form;
  }

  private isNoSpeechFoundProbeResponse(raw: string): boolean {
    const normalized = String(raw || '').toLowerCase();
    return normalized.includes('no speech found') && normalized.includes('request_params_invalid');
  }

  private buildTinyWavProbeBuffer(): Buffer {
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const durationMs = 300;
    const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = sampleCount * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize, 0);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    return buffer;
  }

  private buildMinimaxTtsProbePayload(
    upstreamModel: string,
    text: string,
    requestOverrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const voiceSettingOverrides = this.normalizeObject(requestOverrides.voice_setting);
    const audioSettingOverrides = this.normalizeObject(requestOverrides.audio_setting);
    const voiceId = String(voiceSettingOverrides.voice_id || requestOverrides.voice_id || 'male-qn-qingse');

    return {
      ...requestOverrides,
      model: upstreamModel,
      text,
      voice_setting: {
        ...voiceSettingOverrides,
        voice_id: voiceId,
        speed: Number(voiceSettingOverrides.speed ?? 1),
        vol: Number(voiceSettingOverrides.vol ?? 1),
        pitch: Number(voiceSettingOverrides.pitch ?? 0),
      },
      audio_setting: {
        ...audioSettingOverrides,
        sample_rate: Number(audioSettingOverrides.sample_rate ?? 32000),
        bitrate: Number(audioSettingOverrides.bitrate ?? 128000),
        format: String(audioSettingOverrides.format || requestOverrides.format || 'mp3'),
        channel: Number(audioSettingOverrides.channel ?? 1),
      },
      language_boost: String(requestOverrides.language_boost || 'English'),
      output_format: String(requestOverrides.output_format || 'hex'),
    };
  }

  private buildDashscopeCosyVoiceTtsProbePayload(
    upstreamModel: string,
    text: string,
    requestOverrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const inputOverrides = this.normalizeObject(requestOverrides.input);
    const voice = String(inputOverrides.voice || requestOverrides.voice || requestOverrides.voice_id || '').trim();
    const rootOverrides = { ...requestOverrides };
    delete rootOverrides.input;
    delete rootOverrides.voice;
    delete rootOverrides.voice_id;
    delete rootOverrides.language_boost;
    delete rootOverrides.output_format;
    return {
      ...rootOverrides,
      model: upstreamModel,
      input: {
        ...inputOverrides,
        text: text || 'ping',
        voice: voice || 'voice_required_for_probe',
        format: String(inputOverrides.format || requestOverrides.format || 'mp3'),
        sample_rate: Number(inputOverrides.sample_rate ?? requestOverrides.sample_rate ?? 24000),
      },
    };
  }

  private resolveSourceProbeRequest(
    providerType: string,
    endpointPath: string,
  ): { method: 'GET' | 'POST'; body?: Record<string, unknown>; query?: Record<string, string> } {
    const normalizedProvider = String(providerType || '').trim().toLowerCase();
    const normalizedPath = String(endpointPath || '').trim().toLowerCase();
    const isMinimax = normalizedProvider.includes('minimax');
    if (!isMinimax) {
      return { method: 'GET' };
    }

    if (normalizedPath.endsWith('/t2a_v2')) {
      return {
        method: 'POST',
        body: this.buildMinimaxSourceProbePayload(false),
      };
    }

    if (normalizedPath.endsWith('/t2a_async_v2')) {
      return {
        method: 'POST',
        body: this.buildMinimaxSourceProbePayload(true),
      };
    }

    if (normalizedPath.endsWith('/query/t2a_async_query_v2')) {
      return {
        method: 'GET',
        query: { task_id: '1' },
      };
    }

    return { method: 'GET' };
  }

  private buildMinimaxSourceProbePayload(asyncMode: boolean): Record<string, unknown> {
    const basePayload = {
      model: 'speech-2.8-turbo',
      text: 'ping',
      voice_setting: {
        voice_id: 'male-qn-qingse',
        speed: 1,
        vol: 1,
        pitch: 0,
      },
    };
    if (asyncMode) {
      return {
        ...basePayload,
        audio_setting: {
          audio_sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
      };
    }
    return {
      ...basePayload,
      output_format: 'hex',
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    };
  }

  private assertRunningHubEndpointPath(apiType: string, endpointPath: string, explicitlyProvided: boolean) {
    if (!isRunningHubTaskApiType(apiType)) {
      return;
    }
    const normalizedPath = this.normalizeEndpointPath(endpointPath || '');
    const isInvalid =
      !normalizedPath
      || !normalizedPath.startsWith('/openapi/v2/')
      || normalizedPath === RUNNINGHUB_DEFAULT_QUERY_PATH
      || normalizedPath === RUNNINGHUB_DEFAULT_UPLOAD_PATH;
    if (!isInvalid) {
      return;
    }
    const requirement = explicitlyProvided
      ? 'RunningHub endpoint_path 必须是官方模型路径或 submit 接口路径，例如 /openapi/v2/rhart-image-n-pro'
      : 'RunningHub 模型必须能解析出官方模型路径，例如 /openapi/v2/rhart-image-n-pro';
    throw new BadRequestException(requirement);
  }

  private async testRunningHubSourceConnectivity(input: {
    providerType: string;
    baseUrl: string;
    apiKey: string;
    customHeaders: Record<string, string>;
    timeoutMs: number;
  }): Promise<AiSourceConnectivityTestResult> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), input.timeoutMs);
    const startedAt = Date.now();
    const endpointUrl = this.joinUrl(input.baseUrl, RUNNINGHUB_DEFAULT_UPLOAD_PATH);
    try {
      const form = new FormData();
      const probeFile = new Blob([this.buildTinyPngProbeBuffer()], { type: 'image/png' });
      form.append('file', probeFile, 'runninghub-probe.png');

      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          ...input.customHeaders,
        },
        body: form,
        signal: controller.signal,
      });
      const raw = await response.text();
      const parsed = this.tryParseJsonObject(raw);
      const latencyMs = Date.now() - startedAt;
      const ok = response.ok && isRunningHubUploadSuccess(parsed);
      return {
        ok,
        status_code: response.status,
        latency_ms: latencyMs,
        endpoint_url: endpointUrl,
        provider_type: input.providerType,
        message: ok ? '连通性测试通过（RunningHub 上传接口可用）' : `上游返回 ${response.status}`,
        response_excerpt: this.truncate(this.safeJsonPreview(raw), 500),
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startedAt;
      const timedOut = error?.name === 'AbortError';
      return {
        ok: false,
        status_code: null,
        latency_ms: latencyMs,
        endpoint_url: endpointUrl,
        provider_type: input.providerType,
        message: timedOut ? `连接超时（>${input.timeoutMs}ms）` : `连接失败：${error?.message || 'unknown error'}`,
        response_excerpt: '',
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async testRunningHubModelConnectivity(input: {
    source: AiGlobalSourceRow;
    modelKey: string;
    capability: AiCapability;
    upstreamModel: string;
    endpointPath: string;
    requestOverrides: Record<string, unknown>;
    testPrompt: string;
    timeoutMs: number;
  }): Promise<AiModelConnectivityTestResult> {
    const startedAt = Date.now();
    const schema = resolveRunningHubSchema(input.requestOverrides, input.endpointPath);
    const modelRootPath = this.resolveRunningHubModelEndpointPath(schema.submit_path || input.endpointPath, input.upstreamModel);
    this.assertRunningHubEndpointPath(RUNNINGHUB_TASK_API_TYPE, modelRootPath, true);
    if (input.capability !== 'image' && input.capability !== 'video') {
      return {
        ok: false,
        status_code: null,
        latency_ms: 0,
        endpoint_url: this.joinUrl(input.source.base_url, modelRootPath),
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: '当前只支持 RunningHub 图片或视频模型测试',
        response_excerpt: '',
      };
    }

    const probeInputKind = this.resolveRunningHubProbeInputKind(input.capability, schema.input_kind);
    const submitPath = resolveRunningHubSubmitPathForInput(
      modelRootPath,
      input.upstreamModel,
      probeInputKind,
      schema.submit_action,
    );
    const submitUrl = this.joinUrl(input.source.base_url, submitPath);
    const queryUrl = this.joinUrl(input.source.base_url, schema.query_path);
    try {
      let uploadedImageUrl: string | null = null;
      if (probeInputKind === 'image-to-image' || probeInputKind === 'image-to-video' || probeInputKind === 'reference-to-video') {
        uploadedImageUrl = await this.uploadRunningHubProbeImage(input.source, schema.upload_path, input.timeoutMs);
      }

      const requestBody = this.buildRunningHubProbePayload(schema, input.testPrompt, uploadedImageUrl, probeInputKind);
      const submitResponse = await this.fetchRunningHubJson(submitUrl, input.source, requestBody, input.timeoutMs);
      const taskId = extractRunningHubTaskId(submitResponse.data);
      if (!taskId) {
        const submitError =
          extractRunningHubTaskErrorMessage(submitResponse.data)
          || this.truncate(JSON.stringify(submitResponse.data), 500);
        throw new BadRequestException(`RunningHub submit 响应未返回 taskId：${submitError}`);
      }

      const finalData = await this.pollRunningHubTaskResult(
        queryUrl,
        input.source,
        taskId,
        schema.poll_interval_ms,
        input.capability === 'video' ? RUNNINGHUB_VIDEO_POLL_TIMEOUT_MS : schema.poll_timeout_ms,
      );
      const resultUrls = extractRunningHubResultUrls(finalData);
      if (resultUrls.length === 0) {
        throw new BadRequestException('RunningHub 任务完成，但响应未返回结果 URL');
      }

      return {
        ok: true,
        status_code: submitResponse.statusCode,
        latency_ms: Date.now() - startedAt,
        endpoint_url: submitUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: `模型测试通过（taskId=${taskId}，results=${resultUrls.length}）`,
        response_excerpt: this.truncate(JSON.stringify(finalData), 500),
      };
    } catch (error: any) {
      return {
        ok: false,
        status_code: null,
        latency_ms: Date.now() - startedAt,
        endpoint_url: submitUrl,
        model_key: input.modelKey,
        upstream_model: input.upstreamModel,
        source_id: input.source.id,
        source_name: input.source.name,
        provider_type: input.source.provider_type,
        message: `连接失败：${error?.message || 'unknown error'}`,
        response_excerpt: '',
      };
    }
  }

  private buildRunningHubProbePayload(
    schema: ReturnType<typeof resolveRunningHubSchema>,
    testPrompt: string,
    uploadedImageUrl: string | null,
    inputKind: 'text-to-image' | 'image-to-image' | 'text-to-video' | 'image-to-video' | 'reference-to-video',
  ): Record<string, unknown> {
    const defaults = { ...schema.defaults };
    const fieldMap = {
      prompt: 'prompt',
      input_images: 'imageUrls',
      quality: 'quality',
      resolution: 'resolution',
      aspect_ratio: 'aspectRatio',
      output_format: 'outputFormat',
      webhook_url: 'webhookUrl',
      duration: 'duration',
      generate_audio: 'generateAudio',
      ratio: 'ratio',
      first_frame_url: 'firstFrameUrl',
      reference_images: 'imageUrls',
      return_last_frame: 'returnLastFrame',
      ...schema.field_map,
    };

    const assignMapped = (key: string, value: unknown) => {
      if (value === undefined || value === null) {
        return;
      }
      const targetKey = fieldMap[key] || key;
      defaults[targetKey] = value;
    };

    assignMapped('prompt', testPrompt || (inputKind.includes('video') ? 'test video' : 'test image'));
    if (inputKind === 'image-to-image' && uploadedImageUrl) {
      assignMapped('input_images', [uploadedImageUrl]);
    }
    if (inputKind === 'image-to-video' && uploadedImageUrl) {
      assignMapped('first_frame_url', uploadedImageUrl);
    }
    if (inputKind === 'reference-to-video' && uploadedImageUrl) {
      assignMapped('reference_images', [uploadedImageUrl]);
    }
    if (defaults[fieldMap.resolution] === undefined && fieldMap.resolution) {
      assignMapped('resolution', inputKind.includes('video') ? '720p' : '1k');
    }
    if (defaults[fieldMap.aspect_ratio] === undefined && fieldMap.aspect_ratio) {
      assignMapped('aspect_ratio', '1:1');
    }
    if (!inputKind.includes('video') && defaults[fieldMap.quality] === undefined && fieldMap.quality) {
      assignMapped('quality', 'low');
    }
    if (inputKind.includes('video')) {
      if (defaults[fieldMap.duration] === undefined && fieldMap.duration) {
        assignMapped('duration', '5');
      }
      if (defaults[fieldMap.ratio] === undefined && fieldMap.ratio) {
        assignMapped('ratio', 'adaptive');
      }
      if (defaults[fieldMap.generate_audio] === undefined && fieldMap.generate_audio) {
        assignMapped('generate_audio', false);
      }
      if (defaults[fieldMap.return_last_frame] === undefined && fieldMap.return_last_frame) {
        assignMapped('return_last_frame', false);
      }
    }
    return defaults;
  }

  private resolveRunningHubProbeInputKind(
    capability: AiCapability,
    schemaInputKind: ReturnType<typeof resolveRunningHubSchema>['input_kind'],
  ): 'text-to-image' | 'image-to-image' | 'text-to-video' | 'image-to-video' | 'reference-to-video' {
    if (capability === 'video') {
      if (
        schemaInputKind === 'image-to-video'
        || schemaInputKind === 'text-to-video'
        || schemaInputKind === 'reference-to-video'
      ) {
        return schemaInputKind;
      }
      return 'text-to-video';
    }
    if (schemaInputKind === 'image-to-image') {
      return 'image-to-image';
    }
    return 'text-to-image';
  }

  private async uploadRunningHubProbeImage(
    source: AiGlobalSourceRow,
    uploadPath: string,
    timeoutMs: number,
  ): Promise<string> {
    const endpointUrl = this.joinUrl(source.base_url, uploadPath || RUNNINGHUB_DEFAULT_UPLOAD_PATH);
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const form = new FormData();
      const probeFile = new Blob([this.buildTinyPngProbeBuffer()], { type: 'image/png' });
      form.append('file', probeFile, 'runninghub-model-probe.png');

      const response = await this.outboundHttp.fetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${source.api_key}`,
          ...this.normalizeStringObject(source.custom_headers),
        },
        body: form,
        signal: controller.signal,
      }, {
        proxyId: source.outbound_proxy_id,
      });
      const raw = await response.text();
      const parsed = this.tryParseJsonObject(raw);
      const downloadUrl = this.normalizeNullableString(this.normalizeObject(parsed.data).download_url, 2048);
      if (!response.ok || !isRunningHubUploadSuccess(parsed) || !downloadUrl) {
        throw new BadRequestException(
          `RunningHub 上传测试失败：${response.status} ${this.truncate(this.safeJsonPreview(raw), 240)}`,
        );
      }
      return downloadUrl;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async fetchRunningHubJson(
    endpointUrl: string,
    source: AiGlobalSourceRow,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ statusCode: number; data: Record<string, unknown> }> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.outboundHttp.fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${source.api_key}`,
          ...this.normalizeStringObject(source.custom_headers),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }, {
        proxyId: source.outbound_proxy_id,
      });
      const raw = await response.text();
      const data = this.tryParseJsonObject(raw);
      if (!response.ok) {
        throw new BadRequestException(
          `RunningHub 请求失败：${response.status} ${this.truncate(this.safeJsonPreview(raw), 240)}`,
        );
      }
      return {
        statusCode: response.status,
        data,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async pollRunningHubTaskResult(
    queryUrl: string,
    source: AiGlobalSourceRow,
    taskId: string,
    pollIntervalMs: number,
    pollTimeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() <= deadline) {
      const queryResponse = await this.fetchRunningHubJson(
        queryUrl,
        source,
        { taskId },
        Math.min(Math.max(pollIntervalMs, 1000), pollTimeoutMs),
      );
      const status = extractRunningHubTaskStatus(queryResponse.data);
      if (status && isRunningHubTaskTerminalSuccess(status)) {
        return queryResponse.data;
      }
      if (status && isRunningHubTaskTerminalFailure(status)) {
        const errorMessage = extractRunningHubTaskErrorMessage(queryResponse.data) || `task_status=${status}`;
        throw new BadRequestException(`RunningHub 任务失败：${errorMessage}`);
      }
      if (Date.now() + pollIntervalMs > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new BadRequestException(`RunningHub 任务轮询超时（>${pollTimeoutMs}ms）`);
  }

  private buildTinyPngProbeBuffer(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK2QAAAAASUVORK5CYII=',
      'base64',
    ));
  }

  private normalizeMinimaxEndpointPathForBase(providerType: string, baseUrl: string, endpointPath: string): string {
    const normalizedProvider = String(providerType || '').trim().toLowerCase();
    if (!normalizedProvider.includes('minimax')) {
      return endpointPath;
    }
    const normalizedBase = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
    const normalizedPath = this.normalizeEndpointPath(endpointPath);
    if (normalizedBase.endsWith('/v1') && normalizedPath.toLowerCase().startsWith('/v1/')) {
      return normalizedPath.slice(3);
    }
    return normalizedPath;
  }

  private normalizeObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private normalizeStringObject(value: unknown): Record<string, string> {
    const source = this.normalizeObject(value);
    const result: Record<string, string> = {};
    Object.entries(source).forEach(([key, val]) => {
      if (!key || val === undefined || val === null) {
        return;
      }
      result[String(key)] = String(val);
    });
    return result;
  }

  private joinUrl(baseUrl: string, endpointPath: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${endpointPath.replace(/^\/+/, '')}`;
  }

  private safeJsonPreview(raw: string): string {
    const trimmed = String(raw || '').trim();
    if (!trimmed) {
      return '';
    }
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed);
    } catch {
      return trimmed;
    }
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}...`;
  }

  private tryParseJsonObject(raw: string): Record<string, unknown> {
    const trimmed = String(raw || '').trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private minimaxTtsProbeHasPlayableAudio(data: Record<string, unknown>): boolean {
    const candidates = [
      this.getNestedString(data, ['data', 'audio']),
      this.getNestedString(data, ['audio']),
      this.getNestedString(data, ['output', 'audio']),
      this.getNestedString(data, ['audio_base64']),
      this.getNestedString(data, ['data', 'audio_base64']),
      this.getNestedString(data, ['output', 'audio_base64']),
    ].filter((item): item is string => !!item);
    for (const candidate of candidates) {
      if (/^[0-9a-fA-F]+$/.test(candidate) && candidate.length % 2 === 0) {
        return true;
      }
      const dataUrlMatch = candidate.match(/^data:audio\/[a-z0-9.+-]+;base64,(.+)$/i);
      const base64Text = dataUrlMatch ? dataUrlMatch[1] : candidate;
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text)) {
        try {
          const bytes = Buffer.from(base64Text, 'base64');
          if (bytes.length > 0) {
            return true;
          }
        } catch {
          // ignore invalid base64
        }
      }
    }
    return false;
  }

  private extractMinimaxAsyncTaskId(data: Record<string, unknown>): string | null {
    return (
      this.getNestedString(data, ['task_id']) ||
      this.getNestedString(data, ['taskId']) ||
      this.getNestedString(data, ['data', 'task_id']) ||
      this.getNestedString(data, ['data', 'taskId']) ||
      this.getNestedString(data, ['data', 'task', 'task_id']) ||
      this.getNestedString(data, ['data', 'task', 'id']) ||
      null
    );
  }

  private getNestedString(source: Record<string, unknown>, keys: string[]): string | null {
    let cursor: unknown = source;
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object') {
        return null;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === 'number' || typeof cursor === 'bigint') {
      return String(cursor);
    }
    if (typeof cursor !== 'string') {
      return null;
    }
    const trimmed = cursor.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private isValidModelKey(value: string): boolean {
    return /^[A-Za-z0-9._:/-]+$/.test(value);
  }

  private buildArchivedModelKey(modelKey: string, modelId: string): string {
    const idPart = String(modelId || '').replace(/-/g, '').slice(0, 8) || Date.now().toString(36);
    const suffix = `_archived_${idPart}`;
    const maxBaseLength = Math.max(1, 128 - suffix.length);
    const rawKey = String(modelKey || 'model');
    const normalizedBase = rawKey
      .replace(new RegExp(`${suffix}$`, 'i'), '')
      .replace(/(_archived_[a-z0-9]{8})+$/gi, '');
    const safeBase = normalizedBase.slice(0, maxBaseLength);
    return `${safeBase}${suffix}`;
  }

  private normalizeRmbPerMToken(value: unknown, fallback = 0): number {
    const parsed = this.toFiniteNumber(value, fallback);
    if (parsed < 0) {
      throw new BadRequestException('rmb_per_mtoken must be >= 0');
    }
    if (parsed > 1000000) {
      throw new BadRequestException('rmb_per_mtoken is too large');
    }
    return Number(parsed.toFixed(6));
  }

  private normalizeRmbPerCall(value: unknown, fallback = 0): number {
    const parsed = this.toFiniteNumber(value, fallback);
    if (parsed < 0) {
      throw new BadRequestException('rmb_per_call must be >= 0');
    }
    if (parsed > 1000000) {
      throw new BadRequestException('rmb_per_call is too large');
    }
    return Number(parsed.toFixed(6));
  }

  private normalizeRmbPerMinute(value: unknown, fallback = 0): number {
    const parsed = this.toFiniteNumber(value, fallback);
    if (parsed < 0) {
      throw new BadRequestException('rmb_per_minute must be >= 0');
    }
    if (parsed > 1000000) {
      throw new BadRequestException('rmb_per_minute is too large');
    }
    return Number(parsed.toFixed(6));
  }

  private normalizePointsPerMToken(value: unknown, fallback = 0): number {
    const parsed = this.toFiniteNumber(value, fallback);
    if (parsed < 0) {
      throw new BadRequestException('points_per_mtoken must be >= 0');
    }
    if (parsed > 1000000000) {
      throw new BadRequestException('points_per_mtoken is too large');
    }
    return Number(parsed.toFixed(6));
  }

  private normalizePointsPerCall(value: unknown, fallback = 0): number {
    const parsed = this.toFiniteNumber(value, fallback);
    if (parsed < 0) {
      throw new BadRequestException('points_per_call must be >= 0');
    }
    if (parsed > 1000000000) {
      throw new BadRequestException('points_per_call is too large');
    }
    return Number(parsed.toFixed(6));
  }

  private normalizePointsPerMinute(value: unknown, fallback = 0): number {
    const parsed = this.toFiniteNumber(value, fallback);
    if (parsed < 0) {
      throw new BadRequestException('points_per_minute must be >= 0');
    }
    if (parsed > 1000000000) {
      throw new BadRequestException('points_per_minute is too large');
    }
    return Number(parsed.toFixed(6));
  }

  private normalizeCostRmb(value: unknown, fallback = 0): number {
    const parsed = this.toFiniteNumber(value, fallback);
    if (parsed < 0) {
      return 0;
    }
    return Number(parsed.toFixed(6));
  }

  private normalizeNullableDecimal(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = this.toFiniteNumber(value, Number.NaN);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return Number(parsed.toFixed(6));
  }

  private normalizeBilledUnitLabel(value: unknown): string {
    const raw = String(value || '').trim().toLowerCase();
    if (
      raw === 'output_token'
      || raw === 'token'
      || raw === 'minute'
      || raw === 'image'
      || raw === 'call'
      || raw === 'second'
      || raw === 'character'
    ) {
      return raw;
    }
    return 'token';
  }

  private normalizeNullableString(value: unknown, maxLength = 255): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  private normalizeNullableUuid(value: unknown): string | null {
    const text = this.normalizeNullableString(value, 64);
    if (!text) {
      return null;
    }
    return /^[0-9a-fA-F-]{36}$/.test(text) ? text : null;
  }

  private normalizeNullableBigInt(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = this.toFiniteInteger(value, 0);
    if (parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private normalizeNullableInt(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = this.toFiniteInteger(value, 0);
    if (parsed < 0) {
      return null;
    }
    return parsed;
  }

  private toFiniteInteger(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.trunc(parsed);
  }

  private toFiniteNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return parsed;
  }

  private normalizePositiveInt(value: unknown, fallback: number): number {
    const parsed = this.toFiniteInteger(value, fallback);
    if (parsed <= 0) {
      return fallback;
    }
    return parsed;
  }

  private async prepareUsageFactsForRead(from: Date, to: Date) {
    const missingDays = await this.getMissingUsageFactDays(from, to);
    if (missingDays.length > 0) {
      await this.refreshUsageFactsForDays(missingDays);
    }
  }

  private async refreshUsageFactsFromWatermark() {
    await this.ensureSchema();
    const stateRows = await (this.prisma.$queryRawUnsafe(
      `SELECT last_processed_at FROM ai_usage_fact_refresh_state WHERE job_name = 'daily_usage'`,
    ) as Promise<Array<{ last_processed_at: Date | null }>>);
    const lastProcessedAt = stateRows[0]?.last_processed_at || null;
    const changedDayRows = await (this.prisma.$queryRawUnsafe(
      `SELECT DISTINCT timezone('UTC', created_at)::date::text AS fact_day
       FROM ai_usage_logs
       WHERE $1::timestamptz IS NULL OR created_at > $1::timestamptz
       ORDER BY fact_day ASC`,
      lastProcessedAt,
    ) as Promise<Array<{ fact_day: string }>>);
    if (!changedDayRows.length) {
      return;
    }
    await this.refreshUsageFactsForDays(changedDayRows.map((row) => row.fact_day));
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_usage_fact_refresh_state (
         job_name, last_processed_at, last_refresh_started_at, last_refresh_completed_at, last_error, updated_at
       )
       VALUES ('daily_usage', now(), now(), now(), NULL, now())
       ON CONFLICT (job_name) DO UPDATE
       SET last_processed_at = EXCLUDED.last_processed_at,
           last_refresh_started_at = EXCLUDED.last_refresh_started_at,
           last_refresh_completed_at = EXCLUDED.last_refresh_completed_at,
           last_error = NULL,
           updated_at = EXCLUDED.updated_at`,
    );
  }

  private async getMissingUsageFactDays(from: Date, to: Date): Promise<string[]> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT DISTINCT timezone('UTC', l.created_at)::date::text AS fact_day
       FROM ai_usage_logs l
       WHERE l.created_at >= $1::timestamptz
         AND l.created_at <= $2::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM ai_usage_daily_facts f
           WHERE f.fact_day = timezone('UTC', l.created_at)::date
         )
       ORDER BY fact_day ASC`,
      from,
      to,
    ) as Promise<Array<{ fact_day: string }>>);
    return rows.map((row) => row.fact_day);
  }

  private async refreshUsageFactsForDays(factDays: string[]) {
    for (const factDay of [...new Set(factDays.filter(Boolean))]) {
      await this.refreshUsageFactsForDay(factDay);
    }
  }

  private async refreshUsageFactsForDay(factDay: string) {
    await this.prisma.$executeRawUnsafe(`DELETE FROM ai_usage_daily_facts WHERE fact_day = $1::date`, factDay);
    await this.prisma.$executeRawUnsafe(`DELETE FROM ai_usage_user_daily_facts WHERE fact_day = $1::date`, factDay);
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO ai_usage_daily_facts (
        fact_day, app_id, global_model_id, model_key, capability, source_id, source_name, provider_type,
        requests_total, success_total, error_total, total_tokens, total_billed_units, total_cost_rmb, total_points_cost,
        latency_sum_ms, latency_sample_count, estimated_points_requests, unit_price_rmb_per_mtoken, unit_price_rmb_per_call,
        unit_price_rmb_per_minute, unit_price_mode, billed_unit_label, last_called_at, updated_at
      )
      SELECT
        timezone('UTC', l.created_at)::date AS fact_day,
        l.app_id,
        l.global_model_id,
        MAX(l.model_key) AS model_key,
        l.capability,
        l.source_id,
        MAX(l.source_name) AS source_name,
        MAX(l.provider_type) AS provider_type,
        COUNT(*)::bigint AS requests_total,
        SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
        SUM(CASE WHEN l.success THEN 0 ELSE 1 END)::bigint AS error_total,
        COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
        COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
        COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
        COALESCE(SUM(l.latency_ms) FILTER (WHERE l.latency_ms IS NOT NULL), 0)::bigint AS latency_sum_ms,
        COUNT(l.latency_ms)::bigint AS latency_sample_count,
        COUNT(*) FILTER (WHERE ${this.buildUsagePointsEstimatedSql('l')})::bigint AS estimated_points_requests,
        COALESCE(MAX(l.unit_price_rmb_per_mtoken), 0)::numeric AS unit_price_rmb_per_mtoken,
        COALESCE(MAX(l.unit_price_rmb_per_call), 0)::numeric AS unit_price_rmb_per_call,
        COALESCE(MAX(l.unit_price_rmb_per_minute), 0)::numeric AS unit_price_rmb_per_minute,
        COALESCE(MAX(l.unit_price_mode), 'per_mtoken') AS unit_price_mode,
        COALESCE(MAX(l.billed_unit_label), 'token') AS billed_unit_label,
        MAX(l.created_at) AS last_called_at,
        now()
      FROM ai_usage_logs l
      ${this.buildUsageLedgerJoinSql('l')}
      WHERE timezone('UTC', l.created_at)::date = $1::date
      GROUP BY 1, 2, 3, 5, 6
      `,
      factDay,
    );
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO ai_usage_user_daily_facts (
        fact_day, app_id, user_id, global_model_id, model_key, capability, source_id,
        requests_total, success_total, error_total, total_tokens, total_billed_units, total_cost_rmb, total_points_cost,
        last_called_at, updated_at
      )
      SELECT
        timezone('UTC', l.created_at)::date AS fact_day,
        l.app_id,
        l.user_id,
        l.global_model_id,
        MAX(l.model_key) AS model_key,
        l.capability,
        l.source_id,
        COUNT(*)::bigint AS requests_total,
        SUM(CASE WHEN l.success THEN 1 ELSE 0 END)::bigint AS success_total,
        SUM(CASE WHEN l.success THEN 0 ELSE 1 END)::bigint AS error_total,
        COALESCE(SUM(l.total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(l.billed_units), 0)::numeric AS total_billed_units,
        COALESCE(SUM(l.estimated_cost_rmb), 0)::numeric AS total_cost_rmb,
        COALESCE(SUM(${this.buildUsageEffectivePointsCostSql('l')}), 0)::numeric AS total_points_cost,
        MAX(l.created_at) AS last_called_at,
        now()
      FROM ai_usage_logs l
      ${this.buildUsageLedgerJoinSql('l')}
      WHERE timezone('UTC', l.created_at)::date = $1::date
        AND l.user_id IS NOT NULL
      GROUP BY 1, 2, 3, 4, 6, 7
      `,
      factDay,
    );
  }

  private resolveUsageRange(query: AiUsageSummaryQueryInput): { from: Date; to: Date; days: number } {
    const now = new Date();
    const days = Math.min(Math.max(this.normalizePositiveInt(query.days, 30), 1), 365);
    const defaultFrom = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const from = query.from ? new Date(query.from) : defaultFrom;
    const to = query.to ? new Date(query.to) : now;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('invalid usage range');
    }
    if (from > to) {
      throw new BadRequestException('usage range from must be <= to');
    }
    return { from, to, days };
  }

  private buildUsageWhereClause(
    query: AiUsageSummaryQueryInput,
    from: Date,
    to: Date,
    alias = '',
  ): {
    clause: string;
    params: unknown[];
  } {
    const prefix = alias ? `${alias}.` : '';
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (buildExpression: (index: number) => string, value: unknown) => {
      params.push(value);
      conditions.push(buildExpression(params.length));
    };

    push((index) => `${prefix}created_at >= $${index}::timestamptz`, from);
    push((index) => `${prefix}created_at <= $${index}::timestamptz`, to);

    const appId = this.normalizeNullableUuid(query.app_id);
    if (appId) {
      push((index) => `${prefix}app_id = $${index}::uuid`, appId);
    }

    if (query.capability !== undefined && query.capability !== null && String(query.capability).trim() !== '') {
      push((index) => `${prefix}capability = $${index}`, this.normalizeCapability(query.capability));
    }

    const modelId = this.normalizeNullableUuid(query.model_id);
    if (modelId) {
      push((index) => `${prefix}global_model_id = $${index}::uuid`, modelId);
    }

    const modelKey = this.normalizeNullableString(query.model_key, 128);
    if (modelKey) {
      push((index) => `${prefix}model_key = $${index}`, modelKey);
    }

    const sourceId = this.normalizeNullableUuid(query.source_id);
    if (sourceId) {
      push((index) => `${prefix}source_id = $${index}::uuid`, sourceId);
    }

    const success = this.normalizeUsageSuccess(query.success);
    if (success !== null) {
      push((index) => `${prefix}success = $${index}::boolean`, success);
    }

    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { clause, params };
  }

  private buildUsageFactsWhereClause(
    query: AiUsageSummaryQueryInput,
    from: Date,
    to: Date,
    alias = '',
    startIndex = 1,
  ): { clause: string; params: unknown[] } {
    const prefix = alias ? `${alias}.` : '';
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (buildExpression: (index: number) => string, value: unknown) => {
      params.push(value);
      conditions.push(buildExpression(startIndex + params.length - 1));
    };

    push((index) => `${prefix}fact_day >= $${index}::date`, this.toDateOnly(from));
    push((index) => `${prefix}fact_day <= $${index}::date`, this.toDateOnly(to));

    const appId = this.normalizeNullableUuid(query.app_id);
    if (appId) {
      push((index) => `${prefix}app_id = $${index}::uuid`, appId);
    }
    if (query.capability !== undefined && query.capability !== null && String(query.capability).trim() !== '') {
      push((index) => `${prefix}capability = $${index}`, this.normalizeCapability(query.capability));
    }
    const modelId = this.normalizeNullableUuid(query.model_id);
    if (modelId) {
      push((index) => `${prefix}global_model_id = $${index}::uuid`, modelId);
    }
    const modelKey = this.normalizeNullableString(query.model_key, 128);
    if (modelKey) {
      push((index) => `${prefix}model_key = $${index}`, modelKey);
    }
    const sourceId = this.normalizeNullableUuid(query.source_id);
    if (sourceId) {
      push((index) => `${prefix}source_id = $${index}::uuid`, sourceId);
    }
    return {
      clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  private buildUsageUserFactsWhereClause(
    query: AiUsageSummaryQueryInput,
    from: Date,
    to: Date,
    alias = '',
    startIndex = 1,
  ) {
    return this.buildUsageFactsWhereClause(query, from, to, alias, startIndex);
  }

  private normalizeUsageSuccess(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) {
      return null;
    }
    if (['1', 'true', 'yes', 'success', 'ok'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'failed', 'error'].includes(normalized)) {
      return false;
    }
    return null;
  }

  private buildUsageLedgerJoinSql(alias = 'l'): string {
    const prefix = alias ? `${alias}.` : '';
    return `
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(NULLIF(ledger.metadata_json->>'points_cost', '')::numeric(20, 2), ABS(ledger.delta)) AS points_cost,
          NULLIF(ledger.metadata_json->>'points_pricing_source', '') AS points_pricing_source
        FROM user_ai_points_ledger ledger
        WHERE ledger.app_id = ${prefix}app_id
          AND (
            ${prefix}points_cost IS NULL
            OR ${prefix}points_pricing_source IS NULL
            OR ${prefix}points_pricing_source = ''
            OR ${prefix}usage_reference_id IS NULL
            OR ${prefix}usage_reference_id = ''
          )
          AND ledger.reference_type = 'ai_usage'
          AND (
            ${prefix}usage_reference_id IS NOT NULL
            AND ${prefix}usage_reference_id <> ''
            AND ledger.reference_id = ${prefix}usage_reference_id
            OR (
              ${prefix}request_id IS NOT NULL
              AND ${prefix}request_id <> ''
              AND ledger.metadata_json->>'request_id' = ${prefix}request_id
            )
            OR (
              ${prefix}request_id IS NOT NULL
              AND ${prefix}request_id <> ''
              AND ledger.reference_id = CONCAT(${prefix}global_model_id::text, ':', ${prefix}request_id)
            )
          )
          AND (${prefix}user_id IS NULL OR ledger.user_id = ${prefix}user_id)
        ORDER BY ledger.created_at DESC
        LIMIT 1
      ) usage_points ON true
    `;
  }

  private buildUsageEffectivePointsCostSql(alias = 'l'): string {
    const prefix = alias ? `${alias}.` : '';
    return `COALESCE(${prefix}points_cost, usage_points.points_cost, 0::numeric)`;
  }

  private buildUsagePointsEstimatedSql(alias = 'l'): string {
    const prefix = alias ? `${alias}.` : '';
    return `(${prefix}points_cost IS NULL AND usage_points.points_cost IS NOT NULL)`;
  }

  private buildUsagePointsPricingSourceSql(alias = 'l'): string {
    const prefix = alias ? `${alias}.` : '';
    return `COALESCE(${prefix}points_pricing_source, usage_points.points_pricing_source)`;
  }

  private toDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private async backfillUsagePointsForRange(query: AiUsageSummaryQueryInput, from: Date, to: Date) {
    const where = this.buildUsageWhereClause(query, from, to, 'u');
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE ai_usage_logs l
        SET
          points_cost = matched.points_cost,
          points_pricing_source = COALESCE(matched.points_pricing_source, l.points_pricing_source),
          usage_reference_id = COALESCE(NULLIF(l.usage_reference_id, ''), matched.reference_id)
        FROM (
          SELECT
            u.id,
            ledger.reference_id,
            COALESCE(NULLIF(ledger.metadata_json->>'points_cost', '')::numeric(20, 2), ABS(ledger.delta)) AS points_cost,
            NULLIF(ledger.metadata_json->>'points_pricing_source', '') AS points_pricing_source
          FROM ai_usage_logs u
          JOIN LATERAL (
            SELECT ledger.reference_id, ledger.delta, ledger.metadata_json
            FROM user_ai_points_ledger ledger
            WHERE ledger.app_id = u.app_id
              AND ledger.reference_type = 'ai_usage'
              AND (
                (u.usage_reference_id IS NOT NULL AND u.usage_reference_id <> '' AND ledger.reference_id = u.usage_reference_id)
                OR (u.request_id IS NOT NULL AND u.request_id <> '' AND ledger.metadata_json->>'request_id' = u.request_id)
                OR (u.request_id IS NOT NULL AND u.request_id <> '' AND ledger.reference_id = CONCAT(u.global_model_id::text, ':', u.request_id))
              )
              AND (u.user_id IS NULL OR ledger.user_id = u.user_id)
            ORDER BY ledger.created_at DESC
            LIMIT 1
          ) ledger ON true
          ${where.clause}
            AND (
              u.points_cost IS NULL
              OR u.points_cost = 0
              OR u.points_pricing_source IS NULL
              OR u.points_pricing_source = ''
              OR u.usage_reference_id IS NULL
              OR u.usage_reference_id = ''
            )
        ) matched
        WHERE matched.id = l.id
      `,
      ...where.params,
    );
  }

  private maskSecret(value: string): string {
    if (!value) {
      return '';
    }
    if (value.length <= 8) {
      return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
    }
    return `${value.slice(0, 4)}***${value.slice(-4)}`;
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }
    this.schemaPromise = this.initSchema();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async initSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_global_sources (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(128) NOT NULL,
        provider_type varchar(64) NOT NULL DEFAULT 'openai-compatible',
        base_url text NOT NULL,
        api_key text NOT NULL,
        custom_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
        credentials_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_active boolean NOT NULL DEFAULT true,
        created_by_user_id uuid NULL,
        updated_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_sources
      ADD COLUMN IF NOT EXISTS credentials_json jsonb NOT NULL DEFAULT '{}'::jsonb
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_global_source_api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
        label varchar(128) NOT NULL DEFAULT 'Default',
        api_key text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        last_used_at timestamptz NULL,
        created_by_user_id uuid NULL,
        updated_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_global_source_api_keys_source_active_order
      ON ai_global_source_api_keys(source_id, is_active, sort_order, created_at)
    `);

    await this.prisma.$executeRawUnsafe(`
      INSERT INTO ai_global_source_api_keys (
        source_id,
        label,
        api_key,
        sort_order,
        is_active,
        created_by_user_id,
        updated_by_user_id,
        created_at,
        updated_at
      )
      SELECT
        s.id,
        'Default',
        s.api_key,
        0,
        true,
        s.created_by_user_id,
        s.updated_by_user_id,
        s.created_at,
        s.updated_at
      FROM ai_global_sources s
      WHERE s.api_key <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM ai_global_source_api_keys k
          WHERE k.source_id = s.id
        )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_global_models (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        model_key varchar(128) NOT NULL,
        display_name varchar(128) NOT NULL,
        capability varchar(32) NOT NULL DEFAULT 'chat',
        execution_mode varchar(16) NOT NULL DEFAULT 'sync',
        pricing_mode varchar(16) NOT NULL DEFAULT 'per_mtoken',
        rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        rmb_per_call numeric(16,6) NOT NULL DEFAULT 0,
        rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0,
        input_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        cached_input_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        cache_write_5m_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        cache_write_1h_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        output_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        points_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        points_per_call numeric(16,6) NOT NULL DEFAULT 0,
        points_per_minute numeric(16,6) NOT NULL DEFAULT 0,
        points_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        points_cached_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        points_cache_write_5m_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        points_cache_write_1h_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        points_output_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        default_source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
        upstream_model varchar(256) NOT NULL,
        endpoint_path varchar(255) NOT NULL DEFAULT '/chat/completions',
        api_type varchar(64) NOT NULL DEFAULT 'openai-chat-completions',
        request_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_default boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        is_visible boolean NOT NULL DEFAULT true,
        created_by_user_id uuid NULL,
        updated_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS capability varchar(32) NOT NULL DEFAULT 'chat'
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS execution_mode varchar(16) NOT NULL DEFAULT 'sync'
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS pricing_mode varchar(16) NOT NULL DEFAULT 'per_mtoken'
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS rmb_per_call numeric(16,6) NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS points_per_mtoken numeric(16,6) NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS points_per_call numeric(16,6) NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_models
      ADD COLUMN IF NOT EXISTS points_per_minute numeric(16,6) NOT NULL DEFAULT 0
    `);

    const modelBillingColumns = [
      'input_rmb_per_mtoken',
      'cached_input_rmb_per_mtoken',
      'cache_write_5m_rmb_per_mtoken',
      'cache_write_1h_rmb_per_mtoken',
      'output_rmb_per_mtoken',
      'points_input_per_mtoken',
      'points_cached_input_per_mtoken',
      'points_cache_write_5m_per_mtoken',
      'points_cache_write_1h_per_mtoken',
      'points_output_per_mtoken',
    ];
    for (const column of modelBillingColumns) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE ai_global_models
        ADD COLUMN IF NOT EXISTS ${column} numeric(16,6) NOT NULL DEFAULT 0
      `);
    }

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_app_model_routes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
        is_active boolean NOT NULL DEFAULT true,
        request_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id uuid NULL,
        updated_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (app_id, global_model_id)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_model_source_routes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        route_key varchar(96) NULL,
        app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
        global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        upstream_model varchar(256) NULL,
        endpoint_path varchar(255) NULL,
        api_type varchar(64) NULL,
        request_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id uuid NULL,
        updated_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_model_source_routes
      ADD COLUMN IF NOT EXISTS route_key varchar(96) NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      UPDATE ai_model_source_routes
      SET route_key = id::text
      WHERE route_key IS NULL OR route_key = ''
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_model_source_routes
      ALTER COLUMN route_key SET NOT NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      DROP INDEX IF EXISTS idx_ai_model_source_routes_global_unique
    `);

    await this.prisma.$executeRawUnsafe(`
      DROP INDEX IF EXISTS idx_ai_model_source_routes_app_unique
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_source_routes_global_unique
      ON ai_model_source_routes(global_model_id, route_key)
      WHERE app_id IS NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_source_routes_app_unique
      ON ai_model_source_routes(app_id, global_model_id, route_key)
      WHERE app_id IS NOT NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_model_source_routes_global_lookup
      ON ai_model_source_routes(global_model_id, is_active, sort_order)
      WHERE app_id IS NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_model_source_routes_app_lookup
      ON ai_model_source_routes(app_id, global_model_id, is_active, sort_order)
      WHERE app_id IS NOT NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      INSERT INTO ai_model_source_routes (
        route_key,
        app_id,
        global_model_id,
        source_id,
        sort_order,
        is_active,
        upstream_model,
        endpoint_path,
        api_type,
        request_overrides,
        created_by_user_id,
        updated_by_user_id
      )
      SELECT
        m.default_source_id::text,
        NULL,
        m.id,
        m.default_source_id,
        0,
        true,
        m.upstream_model,
        m.endpoint_path,
        m.api_type,
        '{}'::jsonb,
        m.created_by_user_id,
        m.updated_by_user_id
      FROM ai_global_models m
      WHERE NOT EXISTS (
        SELECT 1
        FROM ai_model_source_routes r
        WHERE r.app_id IS NULL
          AND r.global_model_id = m.id
          AND r.source_id = m.default_source_id
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      INSERT INTO ai_model_source_routes (
        route_key,
        app_id,
        global_model_id,
        source_id,
        sort_order,
        is_active,
        request_overrides,
        created_by_user_id,
        updated_by_user_id
      )
      SELECT
        r.source_id::text,
        r.app_id,
        r.global_model_id,
        r.source_id,
        0,
        r.is_active,
        COALESCE(r.request_overrides, '{}'::jsonb),
        r.created_by_user_id,
        r.updated_by_user_id
      FROM ai_app_model_routes r
      WHERE NOT EXISTS (
        SELECT 1
        FROM ai_model_source_routes sr
        WHERE sr.app_id = r.app_id
          AND sr.global_model_id = r.global_model_id
          AND sr.source_id = r.source_id
      )
    `);

    this.modelSourceRoutesTableAvailable = true;

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_app_capability_defaults (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        capability varchar(32) NOT NULL,
        global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
        created_by_user_id uuid NULL,
        updated_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (app_id, capability)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_usage_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        app_slug varchar(64) NOT NULL,
        user_id uuid NULL,
        global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE RESTRICT,
        model_key varchar(128) NOT NULL,
        upstream_model varchar(256) NOT NULL,
        capability varchar(32) NOT NULL,
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
        source_name varchar(128) NOT NULL,
        provider_type varchar(64) NOT NULL,
        endpoint_path varchar(255) NOT NULL,
        request_path varchar(255) NULL,
        request_id varchar(128) NULL,
        is_stream boolean NOT NULL DEFAULT false,
        success boolean NOT NULL DEFAULT true,
        error_message text NULL,
        prompt_tokens bigint NULL,
        completion_tokens bigint NULL,
        total_tokens bigint NULL,
        uncached_input_tokens bigint NULL,
        cached_input_tokens bigint NULL,
        cache_read_input_tokens bigint NULL,
        cache_creation_input_tokens bigint NULL,
        cache_creation_5m_input_tokens bigint NULL,
        cache_creation_1h_input_tokens bigint NULL,
        unit_price_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_per_call numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_cached_input_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_cache_write_5m_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_cache_write_1h_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_output_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_mode varchar(16) NOT NULL DEFAULT 'per_mtoken',
        billed_input_tokens bigint NULL,
        billed_cached_input_tokens bigint NULL,
        billed_cache_write_tokens bigint NULL,
        billed_output_tokens bigint NULL,
        billed_units numeric(18,6) NULL,
        billed_unit_label varchar(32) NULL,
        billed_duration_seconds bigint NULL,
        estimated_cost_rmb numeric(18,6) NOT NULL DEFAULT 0,
        latency_ms int NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS unit_price_rmb_per_call numeric(16,6) NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS unit_price_mode varchar(16) NOT NULL DEFAULT 'per_mtoken'
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS unit_price_rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS billed_units numeric(18,6) NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS billed_unit_label varchar(32) NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS billed_duration_seconds bigint NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS points_cost numeric(20,2) NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS points_pricing_source varchar(64) NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_usage_logs
      ADD COLUMN IF NOT EXISTS usage_reference_id varchar(128) NULL
    `);

    const usageBigintColumns = [
      'uncached_input_tokens',
      'cached_input_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'cache_creation_5m_input_tokens',
      'cache_creation_1h_input_tokens',
      'billed_input_tokens',
      'billed_cached_input_tokens',
      'billed_cache_write_tokens',
      'billed_output_tokens',
    ];
    for (const column of usageBigintColumns) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE ai_usage_logs
        ADD COLUMN IF NOT EXISTS ${column} bigint NULL
      `);
    }

    const usagePriceColumns = [
      'unit_price_rmb_input_per_mtoken',
      'unit_price_rmb_cached_input_per_mtoken',
      'unit_price_rmb_cache_write_5m_per_mtoken',
      'unit_price_rmb_cache_write_1h_per_mtoken',
      'unit_price_rmb_output_per_mtoken',
    ];
    for (const column of usagePriceColumns) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE ai_usage_logs
        ADD COLUMN IF NOT EXISTS ${column} numeric(16,6) NOT NULL DEFAULT 0
      `);
    }
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_usage_daily_facts (
        fact_day date NOT NULL,
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
        model_key varchar(128) NOT NULL,
        capability varchar(32) NOT NULL,
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
        source_name varchar(128) NOT NULL,
        provider_type varchar(64) NOT NULL,
        requests_total bigint NOT NULL DEFAULT 0,
        success_total bigint NOT NULL DEFAULT 0,
        error_total bigint NOT NULL DEFAULT 0,
        total_tokens bigint NOT NULL DEFAULT 0,
        total_billed_units numeric(18,6) NOT NULL DEFAULT 0,
        total_cost_rmb numeric(18,6) NOT NULL DEFAULT 0,
        total_points_cost numeric(20,2) NOT NULL DEFAULT 0,
        latency_sum_ms bigint NOT NULL DEFAULT 0,
        latency_sample_count bigint NOT NULL DEFAULT 0,
        estimated_points_requests bigint NOT NULL DEFAULT 0,
        unit_price_rmb_per_mtoken numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_per_call numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_rmb_per_minute numeric(16,6) NOT NULL DEFAULT 0,
        unit_price_mode varchar(16) NOT NULL DEFAULT 'per_mtoken',
        billed_unit_label varchar(32) NULL,
        last_called_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (fact_day, app_id, global_model_id, capability, source_id)
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_usage_user_daily_facts (
        fact_day date NOT NULL,
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
        model_key varchar(128) NOT NULL,
        capability varchar(32) NOT NULL,
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
        requests_total bigint NOT NULL DEFAULT 0,
        success_total bigint NOT NULL DEFAULT 0,
        error_total bigint NOT NULL DEFAULT 0,
        total_tokens bigint NOT NULL DEFAULT 0,
        total_billed_units numeric(18,6) NOT NULL DEFAULT 0,
        total_cost_rmb numeric(18,6) NOT NULL DEFAULT 0,
        total_points_cost numeric(20,2) NOT NULL DEFAULT 0,
        last_called_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (fact_day, app_id, user_id, global_model_id, capability, source_id)
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_usage_fact_refresh_state (
        job_name varchar(64) PRIMARY KEY,
        last_processed_at timestamptz NULL,
        last_refresh_started_at timestamptz NULL,
        last_refresh_completed_at timestamptz NULL,
        last_error text NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_global_sources_name_unique
      ON ai_global_sources(LOWER(name))
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_global_models_model_key_unique
      ON ai_global_models(model_key)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_global_models_default
      ON ai_global_models(is_default DESC, updated_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_global_models_capability
      ON ai_global_models(capability, is_default DESC, updated_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_app_model_routes_app_model
      ON ai_app_model_routes(app_id, global_model_id)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_app_capability_defaults_app_capability
      ON ai_app_capability_defaults(app_id, capability)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at
      ON ai_usage_logs(created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_app_created
      ON ai_usage_logs(app_id, created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_app_user_created
      ON ai_usage_logs(app_id, user_id, created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_app_user_feed
      ON ai_usage_logs(app_id, user_id, created_at DESC, id DESC)
      INCLUDE (global_model_id, model_key, total_tokens, points_cost, points_pricing_source, estimated_cost_rmb)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_model_created
      ON ai_usage_logs(global_model_id, created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_usage_reference
      ON ai_usage_logs(usage_reference_id)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_facts_lookup
      ON ai_usage_daily_facts(fact_day, app_id, capability, global_model_id, source_id)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_user_daily_facts_lookup
      ON ai_usage_user_daily_facts(fact_day, app_id, capability, global_model_id, source_id, user_id)
    `);
  }
}
