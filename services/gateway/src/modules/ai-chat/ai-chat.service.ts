import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { BadGatewayException, BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  embed,
  embedMany,
  experimental_generateSpeech,
  experimental_transcribe,
  generateImage,
  generateText,
  streamText,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Modality, type Part } from '@google/genai';
import OpenAI, { toFile } from 'openai';
import { AI_CAPABILITIES, AiCapability, AiRoutingService, ResolvedAiRoute } from './ai-routing.service';
import { normalizeLanguageCode } from '../../common/utils/language-code';
import { PRISMA_CLIENT } from '../../config/database.module';
import { UploadService } from '../upload/upload.service';
import { AiPointsService, DEFAULT_POINTS_PER_YUAN, InsufficientAiPointsError } from './ai-points.service';
import { AiGatewayRelease, AiGatewayThrottleService } from './ai-gateway-throttle.service';
import { AiGatewayUsageQueueService } from './ai-gateway-usage-queue.service';
import { AiProtocolAdapterService } from './ai-protocol-adapter.service';
import { AiUpstreamClientService } from './ai-upstream-client.service';
import { AiGatewayErrorClassifierService } from './ai-gateway-error-classifier.service';
import { AiGatewaySchedulerService } from './ai-gateway-scheduler.service';
import { AiVoicesService } from './ai-voices.service';
import { AiVideoResultProxyService } from './ai-video-result-proxy.service';
import { OutboundHttpClientService } from '../outbound-proxy/outbound-http-client.service';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';
import {
  RUNNINGHUB_DEFAULT_QUERY_PATH,
  RUNNINGHUB_DEFAULT_UPLOAD_PATH,
  RUNNINGHUB_VIDEO_POLL_TIMEOUT_MS,
  extractRunningHubResultUrls,
  extractRunningHubTaskErrorMessage,
  extractRunningHubTaskId,
  extractRunningHubTaskStatus,
  resolveRunningHubModelRootPath,
  resolveRunningHubSubmitPathForInput,
  isRunningHubSource,
  isRunningHubTaskApiType,
  isRunningHubTaskTerminalFailure,
  isRunningHubTaskTerminalSuccess,
  isRunningHubUploadSuccess,
  resolveRunningHubSchema,
} from './runninghub.utils';
import { isRunningHubKnownSubmitPath } from './runninghub.rules';

type ForwardedStreamResponse = {
  stream: true;
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
};

type ForwardedJsonResponse = {
  stream: false;
  data: Record<string, unknown>;
};

type ForwardedBinaryResponse = {
  stream: false;
  binary: true;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type ForwardedAiResponse = ForwardedStreamResponse | ForwardedJsonResponse | ForwardedBinaryResponse;

type MultipartInstruction = {
  file_field_name?: string;
  file_base64?: string;
  file_name?: string;
  file_mime_type?: string;
};

type RunningHubUploadAssetKind = 'image' | 'video' | 'audio';

type UpstreamDispatchResult = {
  response: Response;
  attemptedEndpoints: string[];
};

type AiInvocationContext = {
  user_id?: string | null;
  request_path?: string;
  skip_usage_tracking?: boolean;
  skip_points?: boolean;
};

type AiUsageMetrics = {
  request_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  uncached_input_tokens?: number | null;
  cached_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation_5m_input_tokens?: number | null;
  cache_creation_1h_input_tokens?: number | null;
  duration_seconds?: number | null;
  image_count?: number | null;
  video_resolution?: string | null;
};

type GoogleTtsAudioPart = {
  mediaType: string;
  uint8Array: Uint8Array;
  base64: string;
};

type DashscopeAsyncVideoQueueStatus =
  | 'QUEUED'
  | 'SUBMITTING'
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED'
  | 'UNKNOWN';

type DashscopeAsyncVideoTaskRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  public_task_id: string;
  external_task_id: string | null;
  source_id: string;
  model_id: string;
  model_key: string;
  upstream_model: string;
  status: string;
  reservation_key: string | null;
  usage_reference_id: string | null;
  request_payload_json: unknown;
  response_json: unknown;
  error_message: string | null;
  request_path: string | null;
  metadata_json: unknown;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type MinimaxVoiceItem = {
  index: number;
  language_zh: string;
  language_en: string;
  language_boost: string;
  voice_id: string;
  voice_name: string;
  gender_hint?: string;
  provider?: 'minimax' | 'gemini';
  style?: string;
  language_code?: string;
  source_type?: 'system' | 'voice_cloning' | 'voice_generation' | 'custom';
};

type MinimaxVoiceCatalog = {
  generated_at?: string;
  source_file?: string;
  total?: number;
  voices: MinimaxVoiceItem[];
  by_language?: Record<string, MinimaxVoiceItem[]>;
};

const MINIMAX_TTS_SYNC_API_TYPE = 'minimax-tts-sync';
const MINIMAX_TTS_ASYNC_API_TYPE = 'minimax-tts-async';
const MINIMAX_TTS_API_TYPE = 'minimax-tts';
const ALIYUN_ICE_PROVIDER_TYPE = 'aliyun-ice';
const ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE = 'aliyun-ice-video-translation';
const ALIYUN_ICE_VIDEO_TRANSLATION_MODEL_KEY = 'aliyun-video-translation';
const ALIYUN_ICE_DEFAULT_REGION = 'cn-shanghai';
const ALIYUN_ICE_DEFAULT_ENDPOINT = 'ice.cn-shanghai.aliyuncs.com';
const DASHSCOPE_COSYVOICE_TTS_API_TYPE = 'dashscope-cosyvoice-tts';
const DASHSCOPE_COSYVOICE_TTS_ENDPOINT = '/services/audio/tts/SpeechSynthesizer';
const DASHSCOPE_COSYVOICE_V35_MODELS = new Set(['cosyvoice-v3.5-plus', 'cosyvoice-v3.5-flash']);
const DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS: Record<string, string> = {
  zh: '中文',
  en: '英文',
  fr: '法语',
  de: '德语',
  ja: '日语',
  ko: '韩语',
  ru: '俄语',
  pt: '葡萄牙语',
  th: '泰语',
  id: '印尼语',
  vi: '越南语',
};
const MINIMAX_TTS_EMOTIONS = new Set([
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whipser',
]);
const DASHSCOPE_NATIVE_IMAGE_API_TYPE = 'dashscope-native-image';
const DASHSCOPE_NATIVE_STT_API_TYPE = 'dashscope-native-stt';
const DASHSCOPE_NATIVE_VIDEO_API_TYPE = 'dashscope-native-video';
const DASHSCOPE_VIDEORETALK_API_TYPE = 'dashscope-videoretalk';
const DASHSCOPE_VIDEORETALK_MODEL_KEY = 'videoretalk';
const OPENROUTER_CHAT_API_TYPE = 'openrouter-chat-completions';
const OPENROUTER_EMBEDDINGS_API_TYPE = 'openrouter-embeddings';
const OPENROUTER_AUDIO_SPEECH_API_TYPE = 'openrouter-audio-speech';
const OPENROUTER_AUDIO_TRANSCRIPTIONS_API_TYPE = 'openrouter-audio-transcriptions';
const OPENROUTER_VIDEO_API_TYPE = 'openrouter-video-generation';
const OPENROUTER_STT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DASHSCOPE_TEMP_URL_EXPIRES_SECONDS = 60 * 30;
const DASHSCOPE_TEMP_UPLOAD_PREFIX = 'tmp/ai-dashscope-bridge';
const DASHSCOPE_NATIVE_STT_ENDPOINT = '/api/v1/services/audio/asr/transcription';
const DASHSCOPE_NATIVE_VIDEO_ENDPOINT = '/api/v1/services/aigc/video-generation/video-synthesis';
const DASHSCOPE_VIDEORETALK_ENDPOINT = '/api/v1/services/aigc/image2video/video-synthesis';
const DASHSCOPE_TASK_QUERY_ENDPOINT_PREFIX = '/api/v1/tasks/';
const DASHSCOPE_VIDEO_QUEUE_CONCURRENCY_LIMIT = 5;
const VIDEO_UPSTREAM_TIMEOUT_MS = 60 * 60 * 1000;
const MINIMAX_TTS_KEY_MIN_INTERVAL_MS = 3200;
const MINIMAX_VOICE_API_CACHE_MS = 1000 * 60 * 60 * 6;
const DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS = [
  '/api/v1/services/aigc/image-generation/generation',
  '/api/v1/services/aigc/text2image/image-synthesis',
  '/api/v1/services/aigc/multimodal-generation/generation',
];
const MODEL_PRICING_CACHE_TTL_MS = 30_000;
const DASHSCOPE_TEMP_FILE_REFS_FIELD = '__dashscope_temp_file_refs';
const AI_SDK_OUTPUT_UPLOAD_PREFIX = 'tmp/ai-sdk-output';
const BASE64_FIELD_KEYWORDS = ['image', 'audio', 'file', 'mask', 'ref', 'reference', 'frame', 'cover'];
const RUNNINGHUB_DEFAULT_MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const RUNNINGHUB_SYNC_IMAGE_POLL_TIMEOUT_MS = 3 * 60 * 1000;
const MINIMAX_LANGUAGE_BOOST_BY_CODE: Record<string, string> = {
  zh: 'Chinese',
  yue: 'Chinese',
  en: 'English',
  it: 'Italian',
  es: 'Spanish',
  fr: 'French',
  ru: 'Russian',
  nl: 'Dutch',
  ja: 'Japanese',
  ko: 'Korean',
  tr: 'Turkish',
  de: 'German',
  pt: 'Portuguese',
  ar: 'Arabic',
};
const MINIMAX_LANGUAGE_LABELS_BY_BOOST: Record<string, { language_en: string; language_zh: string }> = {
  Chinese: { language_en: 'Chinese', language_zh: '中文' },
  English: { language_en: 'English', language_zh: '英语' },
  Italian: { language_en: 'Italian', language_zh: '意大利语' },
  Spanish: { language_en: 'Spanish', language_zh: '西班牙语' },
  French: { language_en: 'French', language_zh: '法语' },
  Russian: { language_en: 'Russian', language_zh: '俄语' },
  Dutch: { language_en: 'Dutch', language_zh: '荷兰语' },
  Japanese: { language_en: 'Japanese', language_zh: '日语' },
  Korean: { language_en: 'Korean', language_zh: '韩语' },
  Turkish: { language_en: 'Turkish', language_zh: '土耳其语' },
  German: { language_en: 'German', language_zh: '德语' },
  Portuguese: { language_en: 'Portuguese', language_zh: '葡萄牙语' },
  Arabic: { language_en: 'Arabic', language_zh: '阿拉伯语' },
};
const GEMINI_TTS_DEFAULT_VOICE = 'Kore';
const GEMINI_TTS_VOICES: Array<{ voice_id: string; style: string }> = [
  { voice_id: 'Zephyr', style: 'Bright' },
  { voice_id: 'Puck', style: 'Upbeat' },
  { voice_id: 'Charon', style: 'Informative' },
  { voice_id: 'Kore', style: 'Firm' },
  { voice_id: 'Fenrir', style: 'Excitable' },
  { voice_id: 'Leda', style: 'Youthful' },
  { voice_id: 'Orus', style: 'Firm' },
  { voice_id: 'Aoede', style: 'Breezy' },
  { voice_id: 'Callirrhoe', style: 'Easy-going' },
  { voice_id: 'Autonoe', style: 'Bright' },
  { voice_id: 'Enceladus', style: 'Breathy' },
  { voice_id: 'Iapetus', style: 'Clear' },
  { voice_id: 'Umbriel', style: 'Easy-going' },
  { voice_id: 'Algieba', style: 'Smooth' },
  { voice_id: 'Despina', style: 'Smooth' },
  { voice_id: 'Erinome', style: 'Clear' },
  { voice_id: 'Algenib', style: 'Gravelly' },
  { voice_id: 'Rasalgethi', style: 'Informative' },
  { voice_id: 'Laomedeia', style: 'Upbeat' },
  { voice_id: 'Achernar', style: 'Soft' },
  { voice_id: 'Alnilam', style: 'Firm' },
  { voice_id: 'Schedar', style: 'Even' },
  { voice_id: 'Gacrux', style: 'Mature' },
  { voice_id: 'Pulcherrima', style: 'Forward' },
  { voice_id: 'Achird', style: 'Friendly' },
  { voice_id: 'Zubenelgenubi', style: 'Casual' },
  { voice_id: 'Vindemiatrix', style: 'Gentle' },
  { voice_id: 'Sadachbia', style: 'Lively' },
  { voice_id: 'Sadaltager', style: 'Knowledgeable' },
  { voice_id: 'Sulafat', style: 'Warm' },
];
const GEMINI_TTS_LANGUAGE_CODE_BY_LANGUAGE: Record<string, string> = {
  ar: 'ar-EG',
  de: 'de-DE',
  en: 'en-US',
  es: 'es-US',
  fr: 'fr-FR',
  hi: 'hi-IN',
  id: 'id-ID',
  it: 'it-IT',
  ja: 'ja-JP',
  ko: 'ko-KR',
  pt: 'pt-BR',
  ru: 'ru-RU',
  nl: 'nl-NL',
  pl: 'pl-PL',
  th: 'th-TH',
  tr: 'tr-TR',
  vi: 'vi-VN',
  ro: 'ro-RO',
  uk: 'uk-UA',
  bn: 'bn-BD',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};
const MINIMAX_LANGUAGE_BOOST_BY_VOICE_PREFIX: Record<string, string> = {
  chinese: 'Chinese',
  'chinese mandarin': 'Chinese',
  mandarin: 'Chinese',
  english: 'English',
  italian: 'Italian',
  spanish: 'Spanish',
  french: 'French',
  russian: 'Russian',
  dutch: 'Dutch',
  japanese: 'Japanese',
  korean: 'Korean',
  turkish: 'Turkish',
  german: 'German',
  portuguese: 'Portuguese',
  arabic: 'Arabic',
};

@Injectable()
export class AiChatService implements OnModuleInit {
  private readonly logger = new Logger(AiChatService.name);
  private minimaxVoiceCatalogCache: MinimaxVoiceCatalog | null | undefined;
  private minimaxVoiceCatalogPath: string | null = null;
  private readonly minimaxVoiceApiCache = new Map<string, { value: MinimaxVoiceCatalog; expiresAt: number }>();
  private readonly minimaxVoiceApiCacheMs = this.readBoundedInt(
    'MINIMAX_VOICE_API_CACHE_MS',
    MINIMAX_VOICE_API_CACHE_MS,
    0,
    24 * 60 * 60 * 1000,
  );
  private dashscopeVideoQueueSchemaEnsured = false;
  private readonly modelPricingCache = new Map<string, { value: Record<string, unknown>; expiresAt: number }>();
  private readonly modelPricingInflight = new Map<string, Promise<Record<string, unknown>>>();
  private readonly minimaxTtsKeyQueueTails = new Map<string, Promise<void>>();
  private readonly minimaxTtsKeyLastStartedAt = new Map<string, number>();
  private aiGatewayTuning: Record<string, unknown> = {};
  private aiGatewayTuningLoadedAt = 0;
  private aiGatewayTuningLoading: Promise<void> | null = null;
  private readonly minimaxTtsKeyMinIntervalMs = this.readBoundedInt(
    'MINIMAX_TTS_KEY_MIN_INTERVAL_MS',
    MINIMAX_TTS_KEY_MIN_INTERVAL_MS,
    0,
    60_000,
  );
  private readonly openRouterSttMaxAudioBytes = this.readBoundedInt(
    'OPENROUTER_STT_MAX_AUDIO_BYTES',
    OPENROUTER_STT_MAX_AUDIO_BYTES,
    1024,
    120 * 1024 * 1024,
  );

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly aiRoutingService: AiRoutingService,
    private readonly uploadService: UploadService,
    private readonly aiPointsService: AiPointsService,
    private readonly aiGatewayThrottle: AiGatewayThrottleService,
    private readonly aiGatewayUsageQueue: AiGatewayUsageQueueService,
    private readonly aiProtocolAdapter: AiProtocolAdapterService,
    private readonly aiUpstreamClient: AiUpstreamClientService,
    private readonly aiGatewayErrorClassifier: AiGatewayErrorClassifierService,
    private readonly aiGatewayScheduler: AiGatewaySchedulerService,
    private readonly aiVoicesService: AiVoicesService,
    private readonly aiVideoResultProxy: AiVideoResultProxyService,
    private readonly outboundHttp: OutboundHttpClientService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureDashscopeVideoQueueSchema();
      await this.refreshAiGatewayTuning();
    } catch (error: any) {
      this.logger.warn(`ai chat startup warmup failed: ${error?.message || error}`);
    }
  }

  private buildModelPricingCacheKey(appSlug: string): string {
    return `model-pricing:${String(appSlug || '').trim().toLowerCase()}`;
  }

  private readModelPricingCache(cacheKey: string): Record<string, unknown> | null {
    const cached = this.modelPricingCache.get(cacheKey);
    if (!cached || cached.expiresAt <= Date.now()) {
      if (cached) {
        this.modelPricingCache.delete(cacheKey);
      }
      return null;
    }
    return cached.value;
  }

  private writeModelPricingCache(cacheKey: string, value: Record<string, unknown>) {
    this.modelPricingCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + MODEL_PRICING_CACHE_TTL_MS,
    });
  }

  async chatLegacy(appSlug: string, payload: Record<string, unknown>, context: AiInvocationContext = {}) {
    const messages = this.normalizeLegacyMessages(payload);
    const systemPrompt = this.stringOrUndefined(payload.system_prompt ?? payload.systemPrompt ?? payload.context);
    const stream = payload.stream === true || payload.stream === 'true';

    const completionPayload: Record<string, unknown> = {
      ...this.normalizeLegacyExtraFields(payload),
      messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
      stream,
    };
    const model = this.stringOrUndefined(payload.model);
    if (model) {
      completionPayload.model = model;
    }

    return this.forwardChatCompletions(appSlug, completionPayload, context);
  }

  async forwardChatCompletions(appSlug: string, payload: Record<string, unknown>, context: AiInvocationContext = {}) {
    return this.forwardByCapability(appSlug, 'chat', payload, context);
  }

  async forwardCompletions(appSlug: string, payload: Record<string, unknown>, context: AiInvocationContext = {}) {
    const stream = payload.stream === true || payload.stream === 'true';
    if (stream) {
      throw new BadRequestException('stream is not supported on /completions; use /chat/completions');
    }

    const prompt = payload.prompt;
    const promptText = this.normalizePromptToText(prompt);
    if (!promptText) {
      throw new BadRequestException('prompt is required');
    }

    const chatPayload: Record<string, unknown> = {
      messages: [{ role: 'user', content: promptText }],
      stream: false,
    };

    const passthroughFields = [
      'model',
      'temperature',
      'top_p',
      'n',
      'stop',
      'max_tokens',
      'presence_penalty',
      'frequency_penalty',
      'logit_bias',
      'user',
    ] as const;
    passthroughFields.forEach((key) => {
      if (payload[key] !== undefined) {
        chatPayload[key] = payload[key];
      }
    });

    const forwarded = await this.forwardChatCompletions(appSlug, chatPayload, context);
    if (forwarded.stream) {
      throw new BadGatewayException('invalid upstream stream response for /completions');
    }
    if ('binary' in forwarded && forwarded.binary) {
      throw new BadGatewayException('invalid upstream binary response for /completions');
    }
    if (!('data' in forwarded)) {
      throw new BadGatewayException('invalid upstream response for /completions');
    }

    return {
      stream: false,
      data: this.mapChatCompletionToTextCompletion(forwarded.data, payload),
    } satisfies ForwardedAiResponse;
  }

  async forwardResponses(appSlug: string, payload: Record<string, unknown>, context: AiInvocationContext = {}) {
    const requestedModel = this.stringOrUndefined(payload.model);
    const route = await this.aiRoutingService.resolveModelRouteByCapability(appSlug, 'chat', requestedModel);
    if (this.shouldProxyResponsesDirectly(route, payload)) {
      return this.forwardResponsesDirect(route, payload, context);
    }

    const stream = payload.stream === true || payload.stream === 'true';
    const chatPayload = this.normalizeResponsesPayloadToChat(payload);
    if (stream) {
      chatPayload.stream = true;
    }
    const forwarded = await this.forwardChatCompletions(appSlug, chatPayload, context);
    if (stream) {
      if (!forwarded.stream) {
        throw new BadGatewayException('invalid upstream non-stream response for /responses stream');
      }
      return {
        stream: true,
        status: forwarded.status || 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
        body: this.transformChatSseToResponsesStream(forwarded.body, this.stringOrUndefined(payload.model)),
      } satisfies ForwardedAiResponse;
    }

    if (forwarded.stream) {
      throw new BadGatewayException('invalid upstream stream response for /responses');
    }
    if ('binary' in forwarded && forwarded.binary) {
      throw new BadGatewayException('invalid upstream binary response for /responses');
    }
    if (!('data' in forwarded)) {
      throw new BadGatewayException('invalid upstream response for /responses');
    }

    return {
      stream: false,
      data: this.mapChatCompletionToResponses(forwarded.data, payload),
    } satisfies ForwardedAiResponse;
  }

  private async forwardResponsesDirect(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    await this.assertSufficientPointsBeforeInvoke(route, payload, context);
    const requestRoute: ResolvedAiRoute = {
      ...route,
      endpoint_path: this.resolveResponsesEndpointPath(route),
    };
    const upstreamPayload = await this.rewriteDashscopeBase64Inputs(requestRoute, {
      ...requestRoute.request_overrides,
      ...payload,
      model: requestRoute.upstream_model,
    }, context);
    return this.forwardToUpstream(requestRoute, upstreamPayload, context);
  }

  async listOpenAiModels(appSlug: string) {
    const models = await this.listAvailableModels(appSlug);
    const now = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: models.map((item) => ({
        id: item.model_key,
        object: 'model',
        created: now,
        owned_by: 'gateway',
        capability: item.capability,
        api_type: item.api_type,
      })),
    };
  }

  async listOpenAiModelPricing(
    appSlug: string,
    options: {
      refresh?: boolean;
    } = {},
  ) {
    const normalizedAppSlug = String(appSlug || '').trim().toLowerCase();
    const cacheKey = this.buildModelPricingCacheKey(normalizedAppSlug);
    const cached = !options.refresh ? this.readModelPricingCache(cacheKey) : null;
    if (cached) {
      return cached;
    }
    const inflight = this.modelPricingInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const nextRequest = (async () => {
      const models = await this.listAvailableModels(appSlug);

      const groupOrder = ['chat', 'embedding', 'image', 'video', 'video_translation', 'video_retalk', 'tts', 'stt', 'other'];
      const groups: Record<string, {
        type: string;
        label: string;
        models: Array<Record<string, unknown>>;
      }> = {
        chat: { type: 'chat', label: '文本模型', models: [] },
        embedding: { type: 'embedding', label: '向量模型', models: [] },
        image: { type: 'image', label: '图片模型', models: [] },
        video: { type: 'video', label: '视频模型', models: [] },
        video_translation: { type: 'video_translation', label: '视频翻译', models: [] },
        video_retalk: { type: 'video_retalk', label: 'VideoRetalk', models: [] },
        tts: { type: 'tts', label: '语音合成', models: [] },
        stt: { type: 'stt', label: '语音识别', models: [] },
        other: { type: 'other', label: '其他模型', models: [] },
      };

      for (const model of models) {
        const rawCapability = String(model.capability || 'other').trim().toLowerCase();
        const capability = ['chat', 'embedding', 'image', 'video', 'tts', 'stt'].includes(rawCapability)
          ? rawCapability
          : 'other';
        const pricingGroup = this.resolvePublicModelPricingGroup(capability, model);

        const videoResolutionRates = capability === 'video'
          ? this.buildPublicVideoResolutionRates(model.request_overrides)
          : [];
        const imageQualityResolutionRates = capability === 'image'
          ? this.buildPublicImageQualityResolutionRates(model.request_overrides)
          : [];
        const ttsCharacterRate = capability === 'tts'
          ? this.buildPublicTtsCharacterRate(model)
          : null;
        groups[pricingGroup.type].models.push({
          model: String(model.model_key || ''),
          display_name: String(model.display_name || model.model_key || ''),
          provider: String(model.api_type || ''),
          capability,
          category: pricingGroup.type,
          category_label: pricingGroup.label,
          pricing_mode: model.pricing_mode,
          points_per_mtoken: Number(model.points_per_mtoken || 0),
          points_input_per_mtoken: Number(model.points_input_per_mtoken || 0),
          points_cached_input_per_mtoken: Number(model.points_cached_input_per_mtoken || 0),
          points_cache_write_5m_per_mtoken: Number(model.points_cache_write_5m_per_mtoken || 0),
          points_cache_write_1h_per_mtoken: Number(model.points_cache_write_1h_per_mtoken || 0),
          points_output_per_mtoken: Number(model.points_output_per_mtoken || 0),
          points_per_call: Number(model.points_per_call || 0),
          points_per_minute: Number(model.points_per_minute || 0),
          is_default: !!model.is_default,
          ...(ttsCharacterRate
            ? {
                points_per_100_chars: ttsCharacterRate.points_per_100_chars,
                billing_unit: ttsCharacterRate.billing_unit,
                tts_character_rate: ttsCharacterRate,
                price_table: [ttsCharacterRate],
              }
            : {}),
          ...(capability === 'image'
            ? {
                image_quality_resolution_rates: imageQualityResolutionRates,
                price_table: imageQualityResolutionRates,
              }
            : {}),
          ...(capability === 'video'
            ? {
                video_resolution_rates: videoResolutionRates,
                price_table: videoResolutionRates,
              }
            : {}),
        });
      }

      const response = {
        object: 'model-pricing',
        updated_at: Math.floor(Date.now() / 1000),
        groups: groupOrder
          .map((type) => groups[type])
          .filter((group) => group.models.length > 0)
          .map((group) => ({
            ...group,
            models: [...group.models].sort((left, right) => {
              const leftDefault = left.is_default === true ? 1 : 0;
              const rightDefault = right.is_default === true ? 1 : 0;
              if (leftDefault !== rightDefault) {
                return rightDefault - leftDefault;
              }
              const leftName = String(left.display_name || left.model || '').toLowerCase();
              const rightName = String(right.display_name || right.model || '').toLowerCase();
              return leftName.localeCompare(rightName);
            }),
          })),
      };

      this.writeModelPricingCache(cacheKey, response);
      return response;
    })().finally(() => {
      this.modelPricingInflight.delete(cacheKey);
    });

    this.modelPricingInflight.set(cacheKey, nextRequest);
    return nextRequest;
  }

  getGatewayRuntimeStats() {
    return {
      generated_at: new Date().toISOString(),
      usage_queue: this.aiGatewayUsageQueue.getStats(),
      throttle: this.aiGatewayThrottle.getStats(),
      scheduler: this.aiGatewayScheduler.getStats(),
    };
  }

  async getOpenAiModel(appSlug: string, modelId: string) {
    const models = await this.listAvailableModels(appSlug);
    const matched = models.find((item) => item.model_key === modelId);
    if (!matched) {
      throw new NotFoundException(`model not found: ${modelId}`);
    }
    return {
      id: matched.model_key,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'gateway',
      capability: matched.capability,
      api_type: matched.api_type,
    };
  }

  async listGeminiModels(appSlug: string) {
    const models = (await this.listAvailableModels(appSlug))
      .filter((item) => item.capability === 'chat' || item.capability === 'embedding' || item.capability === 'image');
    return {
      models: models.map((item) => this.serializeGeminiModel(item)),
    };
  }

  async getGeminiModel(appSlug: string, modelIdRaw: string) {
    const modelId = this.normalizeGeminiModelId(modelIdRaw);
    const models = await this.listAvailableModels(appSlug);
    const matched = models.find((item) => item.model_key === modelId);
    if (!matched) {
      throw new NotFoundException(`model not found: ${modelId}`);
    }
    return this.serializeGeminiModel(matched);
  }

  async forwardGeminiGenerateContent(
    appSlug: string,
    modelIdRaw: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const modelId = this.normalizeGeminiModelId(modelIdRaw);
    const model = await this.getAvailableGeminiModel(appSlug, modelId);
    if (model.capability === 'embedding') {
      throw new BadRequestException('embedContent is required for embedding models');
    }

    if (model.capability === 'image' || this.geminiRequestWantsImage(payload)) {
      const imagePayload = await this.buildGeminiImageInvocationPayload(modelId, payload);
      const forwarded = await this.invokeByCapability(appSlug, 'image', imagePayload, context);
      if (forwarded.stream) {
        throw new BadGatewayException('invalid stream response for Gemini image generation');
      }
      if ('binary' in forwarded && forwarded.binary) {
        throw new BadGatewayException('invalid binary response for Gemini image generation');
      }
      if (!('data' in forwarded)) {
        throw new BadGatewayException('invalid JSON response for Gemini image generation');
      }
      return {
        stream: false,
        data: this.mapImageForwardedResponseToGemini(forwarded.data, modelId),
      };
    }

    const chatPayload = await this.buildGeminiChatInvocationPayload(modelId, payload, false);
    const forwarded = await this.forwardChatCompletions(appSlug, chatPayload, context);
    if (forwarded.stream) {
      throw new BadGatewayException('invalid stream response for Gemini generateContent');
    }
    if ('binary' in forwarded && forwarded.binary) {
      throw new BadGatewayException('invalid binary response for Gemini generateContent');
    }
    if (!('data' in forwarded)) {
      throw new BadGatewayException('invalid JSON response for Gemini generateContent');
    }
    return {
      stream: false,
      data: this.mapChatCompletionToGeminiGenerateContent(forwarded.data, modelId),
    };
  }

  async forwardGeminiStreamGenerateContent(
    appSlug: string,
    modelIdRaw: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const modelId = this.normalizeGeminiModelId(modelIdRaw);
    const model = await this.getAvailableGeminiModel(appSlug, modelId);
    if (model.capability !== 'chat') {
      throw new BadRequestException('streamGenerateContent only supports chat-capable models');
    }

    const chatPayload = await this.buildGeminiChatInvocationPayload(modelId, payload, true);
    const forwarded = await this.forwardChatCompletions(appSlug, chatPayload, context);
    if (!forwarded.stream) {
      throw new BadGatewayException('invalid non-stream response for Gemini streamGenerateContent');
    }

    return {
      stream: true,
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      body: this.transformOpenAiSseToGeminiStream(forwarded.body, modelId),
    };
  }

  async forwardGeminiEmbedContent(
    appSlug: string,
    modelIdRaw: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<Record<string, unknown>> {
    const modelId = this.normalizeGeminiModelId(modelIdRaw);
    const model = await this.getAvailableGeminiModel(appSlug, modelId);
    if (model.capability !== 'embedding') {
      throw new BadRequestException('embedContent only supports embedding models');
    }

    const input = this.buildGeminiEmbeddingInput(payload);
    const forwarded = await this.invokeByCapability(appSlug, 'embedding', {
      model: modelId,
      input,
    }, context);
    if (forwarded.stream) {
      throw new BadGatewayException('invalid stream response for Gemini embedContent');
    }
    if ('binary' in forwarded && forwarded.binary) {
      throw new BadGatewayException('invalid binary response for Gemini embedContent');
    }
    if (!('data' in forwarded)) {
      throw new BadGatewayException('invalid JSON response for Gemini embedContent');
    }

    return this.mapEmbeddingForwardedResponseToGemini(forwarded.data);
  }

  async invokeByCapability(
    appSlug: string,
    capabilityInput: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ) {
    const capability = this.normalizeCapability(capabilityInput);
    return this.forwardByCapability(appSlug, capability, payload, context);
  }

  async forwardByCapability(
    appSlug: string,
    capability: AiCapability,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ) {
    const requestedModel = this.stringOrUndefined(payload.model);
    let routes = await this.aiRoutingService.resolveModelRouteCandidatesByCapability(appSlug, capability, requestedModel);
    let effectivePayload = capability === 'tts' ? this.normalizeTtsVoiceAliases(payload) : payload;
    if (capability === 'tts') {
      const resolvedVoice = await this.aiVoicesService.resolveVoiceForTts(appSlug, effectivePayload, context.user_id || null);
      if (resolvedVoice) {
        if (!requestedModel && resolvedVoice.global_model_id) {
          routes = await this.aiRoutingService.resolveModelRouteCandidatesByModelId(appSlug, capability, resolvedVoice.global_model_id);
        }
        routes = this.aiVoicesService.filterRoutesForVoice(routes, resolvedVoice);
        effectivePayload = this.aiVoicesService.applyResolvedVoiceToPayload(effectivePayload, resolvedVoice);
      } else {
        routes = this.aiVoicesService.filterSpeechRoutes(routes);
      }
    }
    const preferredRouteKey = this.resolvePreferredMediaRouteKey(routes[0], effectivePayload);
    routes = this.orderRoutesByPreferredRouteKey(routes, preferredRouteKey);
    return this.invokeResolvedRouteCandidates(routes, effectivePayload, context, { fixedFirstRouteKey: preferredRouteKey });
  }

  private orderRoutesByPreferredRouteKey(
    routes: ResolvedAiRoute[],
    preferredRouteKey: string,
  ): ResolvedAiRoute[] {
    if (routes.length <= 1 || !preferredRouteKey) {
      return routes;
    }
    const preferredIndex = routes.findIndex((route) => route.route_key === preferredRouteKey);
    if (preferredIndex <= 0) {
      return routes;
    }
    return [routes[preferredIndex], ...routes.slice(0, preferredIndex), ...routes.slice(preferredIndex + 1)];
  }

  private resolvePreferredMediaRouteKey(route: ResolvedAiRoute | undefined, payload: Record<string, unknown>): string {
    if (!route) {
      return '';
    }
    const overrides = this.normalizeObject(route.request_overrides);
    const pricingRoot = this.normalizeObject(overrides.pricing);
    if (route.capability === 'image') {
      const qualityRates = this.normalizeObject(
        pricingRoot.image_quality_resolution_rates
        || pricingRoot.image_resolution_rates
        || overrides.image_quality_resolution_rates
        || overrides.image_resolution_rates,
      );
      const inputObject = this.normalizeObject(payload.input);
      const parameters = this.normalizeObject(payload.parameters);
      const quality = this.resolveImageQualityKey(
        this.stringOrUndefined(payload.quality)
        || this.stringOrUndefined(parameters.quality)
        || this.stringOrUndefined(inputObject.quality),
      );
      const resolution = this.resolveImageResolutionKey(
        this.stringOrUndefined(payload.resolution)
        || this.stringOrUndefined(payload.image_size)
        || this.stringOrUndefined(payload.imageSize)
        || this.stringOrUndefined(payload.size)
        || this.stringOrUndefined(parameters.resolution)
        || this.stringOrUndefined(parameters.size)
        || this.stringOrUndefined(inputObject.resolution)
        || this.stringOrUndefined(inputObject.image_size)
        || this.stringOrUndefined(inputObject.imageSize)
        || this.stringOrUndefined(inputObject.size),
      );
      const qualityRoot = this.normalizeObject(
        qualityRates[quality]
        || qualityRates[quality.toUpperCase()]
        || qualityRates[quality.toLowerCase()],
      );
      const rate = this.normalizeObject(
        qualityRoot[resolution]
        || qualityRoot[resolution.toLowerCase()]
        || qualityRoot[resolution.replace('K', 'k')]
        || qualityRates[`${quality}_${resolution}`]
        || qualityRates[`${quality}_${resolution}`.toLowerCase()],
      );
      return this.stringOrUndefined(rate.preferred_route_key) || this.stringOrUndefined(rate.preferredRouteKey) || '';
    }
    if (route.capability === 'video') {
      const resolutionRates = this.normalizeObject(
        pricingRoot.video_resolution_rates || overrides.video_resolution_rates,
      );
      const inputObject = this.normalizeObject(payload.input);
      const parameters = this.normalizeObject(payload.parameters);
      const resolution = this.resolveVideoResolutionKey(
        this.stringOrUndefined(payload.resolution)
        || this.stringOrUndefined(parameters.resolution)
        || this.stringOrUndefined(payload.size)
        || this.stringOrUndefined(inputObject.resolution)
        || this.stringOrUndefined(inputObject.size),
      );
      const rate = this.normalizeObject(
        resolutionRates[resolution]
        || resolutionRates[resolution.toLowerCase()]
        || resolutionRates[resolution.replace('P', 'p')]
        || resolutionRates[resolution.replace('K', 'k')],
      );
      return this.stringOrUndefined(rate.preferred_route_key) || this.stringOrUndefined(rate.preferredRouteKey) || '';
    }
    return '';
  }

  async forwardVertexTtsSpeech(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const requestedModel = this.stringOrUndefined(payload.model);
    const effectivePayload = this.normalizeTtsVoiceAliases(payload);
    const routes = (await this.aiRoutingService.resolveModelRouteCandidatesByCapability(appSlug, 'tts', requestedModel))
      .filter((route) => this.isVertexAiSource(route.source.provider_type, route.source.base_url));

    if (routes.length === 0) {
      throw new BadRequestException('Vertex AI TTS model route is not configured for this app');
    }

    return this.aiGatewayScheduler.invokeCandidates(routes, {
      payload: effectivePayload,
      context,
      shouldTryNext: (error) => this.shouldTryNextResolvedRoute(error),
      invoke: (route) => this.forwardGoogleGenAiTts(route, effectivePayload, context),
      onRetry: (route, nextIndex, error) => {
        this.logger.warn(
          `Vertex TTS route fallback model=${route.model_key} source=${route.source.name} next_index=${nextIndex}: ${this.truncate(String((error as any)?.message || 'request failed'), 360)}`,
        );
      },
    });
  }

  async forwardGoogleTtsSpeech(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const requestedModel = this.stringOrUndefined(payload.model);
    const effectivePayload = this.normalizeTtsVoiceAliases(payload);
    const routes = (await this.aiRoutingService.resolveModelRouteCandidatesByCapability(appSlug, 'tts', requestedModel))
      .filter((route) => this.isGeminiSource(route.source.provider_type, route.source.base_url));

    if (routes.length === 0) {
      throw new BadRequestException('Google Gemini TTS model route is not configured for this app');
    }

    return this.aiGatewayScheduler.invokeCandidates(routes, {
      payload: effectivePayload,
      context,
      shouldTryNext: (error) => this.shouldTryNextResolvedRoute(error),
      invoke: (route) => this.forwardGoogleGenAiTts(route, effectivePayload, context),
      onRetry: (route, nextIndex, error) => {
        this.logger.warn(
          `Google Gemini TTS route fallback model=${route.model_key} source=${route.source.name} next_index=${nextIndex}: ${this.truncate(String((error as any)?.message || 'request failed'), 360)}`,
        );
      },
    });
  }

  private normalizeTtsVoiceAliases(payload: Record<string, unknown>): Record<string, unknown> {
    const next = { ...payload };
    const voiceSetting = this.normalizeObject(next.voice_setting);
    const canonicalVoiceId =
      this.stringOrUndefined(next.voice_id) ||
      this.stringOrUndefined(next.voice) ||
      this.stringOrUndefined(voiceSetting.voice_id);
    if (!canonicalVoiceId) {
      return next;
    }
    next.voice_id = canonicalVoiceId;
    next.voice = canonicalVoiceId;
    next.voice_setting = {
      ...voiceSetting,
      voice_id: canonicalVoiceId,
    };
    return next;
  }

  private async invokeResolvedRouteCandidates(
    routes: ResolvedAiRoute[],
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
    options: { video_mode?: 'sync' | 'async'; fixedFirstRouteKey?: string } = {},
  ) {
    return this.aiGatewayScheduler.invokeCandidates(routes, {
      payload,
      context,
      fixedFirstRouteKey: options.fixedFirstRouteKey,
      shouldTryNext: (error) => this.shouldTryNextResolvedRoute(error),
      invoke: (route) => this.invokeResolvedRoute(route, payload, context, options),
      onRetry: (route, nextIndex, error) => {
        this.logger.warn(
          `AI route fallback model=${route.model_key} source=${route.source.name} next_index=${nextIndex}: ${this.truncate(String((error as any)?.message || 'request failed'), 360)}`,
        );
      },
    });
  }

  private shouldTryNextResolvedRoute(error: unknown): boolean {
    if (
      error instanceof BadRequestException
      || error instanceof ForbiddenException
      || error instanceof NotFoundException
      || error instanceof InsufficientAiPointsError
    ) {
      return false;
    }
    const status = Number((error as any)?.status || (error as any)?.response?.status);
    if (Number.isFinite(status)) {
      return this.aiGatewayErrorClassifier.shouldTryNextRoute({
        status,
        message: String((error as any)?.message || ''),
      });
    }
    const message = String((error as any)?.message || '').toLowerCase();
    return this.aiGatewayErrorClassifier.shouldTryNextRoute({ message })
      || message.includes('cooling down');
  }

  async invokePlaygroundRoute(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
    options: { video_mode?: 'sync' | 'async' } = {},
  ) {
    return this.invokeResolvedRoute(
      route,
      payload,
      {
        ...context,
        skip_points: true,
        skip_usage_tracking: true,
      },
      options,
    );
  }

  async queryPlaygroundVideoTask(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const taskId = this.stringOrUndefined(payload.task_id ?? payload.taskId);
    if (!taskId) {
      throw new BadRequestException('task_id is required');
    }
    if (this.shouldUseRunningHub(route) && route.capability === 'video') {
      const data = await this.fetchRunningHubTaskData(route, payload, taskId, context);
      return {
        stream: false,
        data: await this.buildRunningHubVideoTaskResponseWithProxy(route, data, {
          includeVideoUrls: true,
          fallbackTaskId: taskId,
          proxyWaitTimeoutMs: 5_000,
        }),
      };
    }
    if (this.shouldUseOpenRouter(route) && route.capability === 'video') {
      return this.queryOpenRouterVideoTask(route, payload, taskId, context);
    }
    if (!this.shouldUseDashscopeNative(route) || route.capability !== 'video') {
      throw new BadRequestException('当前视频模型不支持异步任务查询');
    }
    const data = await this.fetchDashscopeTaskData(route, payload, taskId);
    return {
      stream: false,
      data: this.buildDashscopeVideoTaskResponse(data, {
        includeVideoUrls: true,
        fallbackTaskId: taskId,
      }),
    };
  }

  private async invokeResolvedRoute(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
    options: { video_mode?: 'sync' | 'async' } = {},
  ) {
    const normalizedPayload = { ...payload };
    const preferSyncTts =
      route.capability === 'tts'
      && (normalizedPayload.prefer_sync_tts === true || normalizedPayload.prefer_sync_tts === 'true');
    const preferAsyncTts =
      route.capability === 'tts'
      && (
        normalizedPayload.prefer_async_tts === true
        || normalizedPayload.prefer_async_tts === 'true'
        || normalizedPayload.async_tts === true
        || normalizedPayload.async_tts === 'true'
      );
    const ttsTextLength = route.capability === 'tts' ? this.extractTtsTextLength(normalizedPayload) : 0;
    delete normalizedPayload.prefer_sync_tts;
    delete normalizedPayload.prefer_async_tts;
    delete normalizedPayload.async_tts;

    await this.assertSufficientPointsBeforeInvoke(route, normalizedPayload, context);

    let upstreamPayload: Record<string, unknown> = {
      ...route.request_overrides,
      ...normalizedPayload,
      model: route.upstream_model,
    };
    upstreamPayload = await this.rewriteDashscopeBase64Inputs(route, upstreamPayload, context);
    upstreamPayload = this.sanitizeChatPayloadForReasoningModel(route, upstreamPayload);

    if (this.shouldUseAnthropic(route)) {
      return this.forwardViaAnthropic(route, upstreamPayload, context);
    }
    if (this.isAnthropicSource(route.source.provider_type, route.source.base_url)) {
      throw new BadRequestException(`Anthropic source 暂只支持 capability=chat，当前为 ${route.capability}`);
    }

    if (this.shouldUseGoogleGenAi(route)) {
      return this.forwardViaGoogleGenAi(route, upstreamPayload, context);
    }

    if (this.shouldUseOpenRouter(route)) {
      return this.forwardViaOpenRouter(route, upstreamPayload, context);
    }

    if (route.capability === 'chat' && this.shouldBypassAiSdkChatForward(route, upstreamPayload)) {
      const multipart = this.extractMultipartInstruction(upstreamPayload);
      if (multipart) {
        return this.forwardMultipartToUpstream(route, upstreamPayload, multipart, context);
      }
      return this.forwardToUpstream(route, upstreamPayload, context);
    }

    if (route.capability === 'image' && this.shouldUseOpenAiStrictImageRoute(route, upstreamPayload, context)) {
      return this.forwardOpenAiStrictImage(route, upstreamPayload, context);
    }

    if (route.capability === 'stt' && this.shouldUseDashscopeCompatibleStt(route)) {
      return this.forwardDashscopeCompatibleStt(route, upstreamPayload, context);
    }

    if (route.capability === 'stt') {
      const multipart = this.extractMultipartInstruction(upstreamPayload);
      if (multipart) {
        return this.forwardMultipartToUpstream(route, upstreamPayload, multipart, context);
      }
    }

    if (this.isDashscopeCosyVoiceTtsRoute(route)) {
      if (route.capability !== 'tts') {
        throw new BadRequestException(`api_type ${route.api_type} 仅支持 capability=tts`);
      }
      return this.forwardDashscopeCosyVoiceTts(route, normalizedPayload, context);
    }

    const forceMinimaxTts =
      route.capability === 'tts'
      && this.isMinimaxSource(route.source.provider_type)
      && !this.isVoiceCloneApiType(route.api_type);
    if (this.isMinimaxTtsApiType(route.api_type) || forceMinimaxTts) {
      if (route.capability !== 'tts') {
        throw new BadRequestException(`api_type ${route.api_type} 仅支持 capability=tts`);
      }
      const asyncModeConfigured = this.normalizeApiType(route.api_type) === MINIMAX_TTS_ASYNC_API_TYPE;
      const asyncMode = preferSyncTts ? false : (preferAsyncTts || (asyncModeConfigured && ttsTextLength > 10000));
      return this.forwardMinimaxTts(route, normalizedPayload, asyncMode, context);
    }

    if (this.shouldUseDashscopeNative(route)) {
      if (route.capability === 'image') {
        return this.forwardDashscopeNativeImage(route, upstreamPayload, context);
      }
      if (route.capability === 'stt') {
        return this.forwardDashscopeNativeStt(route, upstreamPayload, context);
      }
      if (route.capability === 'video') {
        if (options.video_mode === 'async') {
          return this.forwardDashscopeNativeVideoAsync(route, normalizedPayload);
        }
        return this.forwardDashscopeNativeVideo(route, upstreamPayload, context);
      }
    }
    if (this.shouldUseAliyunIceVideoTranslation(route)) {
      if (route.capability !== 'video') {
        throw new BadRequestException(`api_type ${route.api_type} 仅支持 capability=video`);
      }
      if (options.video_mode === 'async') {
        return this.forwardAliyunIceVideoTranslationAsync(route, normalizedPayload, context);
      }
      throw new BadRequestException('阿里云视频翻译仅支持异步接口');
    }
    if (this.shouldUseRunningHub(route)) {
      if (route.capability === 'image') {
        return this.forwardRunningHubImage(route, upstreamPayload, context);
      }
      if (route.capability === 'video') {
        if (options.video_mode === 'async') {
          return this.forwardRunningHubVideoAsync(route, upstreamPayload, context);
        }
        return this.forwardRunningHubVideo(route, upstreamPayload, context);
      }
      throw new BadRequestException(`RunningHub source 暂仅支持 capability=image 或 video，当前为 ${route.capability}`);
    }
    if (this.shouldUseAiSdkForward(route, route.capability)) {
      return this.forwardViaAiSdk(route, upstreamPayload, context);
    }
    const multipart = this.extractMultipartInstruction(upstreamPayload);
    if (multipart) {
      return this.forwardMultipartToUpstream(route, upstreamPayload, multipart, context);
    }
    return this.forwardToUpstream(route, upstreamPayload, context);
  }

  async queryTtsAsyncTask(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const requestedModel = this.stringOrUndefined(payload.model);
    const route = await this.aiRoutingService.resolveModelRouteByCapability(appSlug, 'tts', requestedModel);
    if (this.normalizeApiType(route.api_type) !== MINIMAX_TTS_ASYNC_API_TYPE) {
      throw new BadRequestException('当前 TTS 模型不是 minimax-tts-async，无法查询异步任务');
    }

    const taskId = this.stringOrUndefined(payload.task_id ?? payload.taskId);
    if (!taskId) {
      throw new BadRequestException('task_id is required');
    }
    const taskToken = this.stringOrUndefined(payload.task_token ?? payload.taskToken);
    const endpointPath = this.stringOrUndefined(
      payload.endpoint_path ?? payload.query_endpoint_path ?? payload.query_endpoint,
    );
    const data = await this.fetchMinimaxAsyncTaskData(route, taskId, taskToken, endpointPath);
    const usage = this.extractUsageMetrics(data);
    this.logUsageSafe(route, payload, context, {
      success: true,
      is_stream: false,
      usage,
      request_id: usage.request_id || this.stringOrUndefined(payload.task_id ?? payload.taskId) || null,
      latency_ms: null,
      billable: false,
    });
    return {
      stream: false,
      data,
    };
  }

  async submitVideoTranslationJob(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const route = await this.aiRoutingService.resolveModelRouteByCapability(
      appSlug,
      'video',
      ALIYUN_ICE_VIDEO_TRANSLATION_MODEL_KEY,
    );
    if (!this.shouldUseAliyunIceVideoTranslation(route)) {
      throw new BadRequestException('视频翻译模型未配置为 aliyun-ice-video-translation');
    }
    const preparedPayload = this.buildAliyunIceVideoTranslationPayload(route, payload);
    await this.assertSufficientPointsBeforeInvoke(route, preparedPayload, context);
    const reservation = await this.reserveAsyncVideoPoints(route, preparedPayload, context);
    try {
      const forwarded = await this.forwardAliyunIceVideoTranslationAsync(route, preparedPayload, context);
      const response = this.normalizeObject((forwarded as ForwardedJsonResponse).data);
      const providerTaskId = this.extractAliyunIceVideoTranslationJobId(response);
      if (!providerTaskId) {
        throw new BadGatewayException('Aliyun ICE video translation accepted but no JobId returned');
      }
      const task = await this.createAliyunIceVideoTranslationTask(
        route,
        preparedPayload,
        context,
        providerTaskId,
        response,
        reservation?.reservation_key || null,
      );
      if (reservation && context.user_id) {
        await this.aiPointsService.attachReservationTask({
          app_id: route.app_id,
          user_id: context.user_id,
          reservation_key: reservation.reservation_key,
          external_task_id: providerTaskId,
          usage_reference_id: this.stringOrUndefined(task.usage_reference_id) || this.buildAiUsageReferenceId(route, task.public_task_id),
          metadata: {
            model_key: route.model_key,
            upstream_model: route.upstream_model,
            provider: ALIYUN_ICE_PROVIDER_TYPE,
          },
        });
      }
      return {
        stream: false,
        data: this.buildAliyunIceVideoTranslationSubmitResponse(response, {
          publicTaskId: task.public_task_id,
          providerTaskId,
        }),
      };
    } catch (error) {
      if (reservation && context.user_id) {
        await this.aiPointsService.releaseReservationByKey({
          app_id: route.app_id,
          user_id: context.user_id,
          reservation_key: reservation.reservation_key,
          metadata: {
            reason: 'upstream_create_failed',
            provider: ALIYUN_ICE_PROVIDER_TYPE,
            error_message: String((error as any)?.message || 'request failed'),
          },
        });
      }
      throw error;
    }
  }

  async queryVideoTranslationJob(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const taskId = this.stringOrUndefined(payload.task_id ?? payload.taskId ?? payload.job_id ?? payload.jobId);
    if (!taskId) {
      throw new BadRequestException('task_id is required');
    }
    const appId = await this.resolveAppIdBySlug(appSlug);
    const task = await this.findDashscopeAsyncVideoTask(appId, taskId, context.user_id || null);
    const route = await this.aiRoutingService.resolveModelRouteByCapability(
      appSlug,
      'video',
      task?.model_key || ALIYUN_ICE_VIDEO_TRANSLATION_MODEL_KEY,
    );
    if (!this.shouldUseAliyunIceVideoTranslation(route)) {
      throw new BadRequestException('视频翻译模型未配置为 aliyun-ice-video-translation');
    }
    if (task) {
      return this.queryAliyunIceVideoTranslationExternalTask(route, task, context);
    }
    const providerTaskId = this.stringOrUndefined(payload.provider_task_id ?? payload.providerTaskId) || taskId;
    const data = await this.fetchAliyunIceVideoTranslationTaskData(route, providerTaskId);
    return {
      stream: false,
      data: this.buildAliyunIceVideoTranslationTaskResponse(data, {
        includeUrls: true,
        fallbackTaskId: taskId,
        providerTaskId,
      }),
    };
  }

  async submitVideoRetalkJob(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    return this.invokeVideoAsync(appSlug, { ...payload, model: DASHSCOPE_VIDEORETALK_MODEL_KEY }, context);
  }

  async queryVideoRetalkJob(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    return this.queryVideoAsyncTask(appSlug, { ...payload, model: DASHSCOPE_VIDEORETALK_MODEL_KEY }, context);
  }

  async invokeVideoAsync(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const normalizedPayload = { ...payload };
    const requestedModel = this.stringOrUndefined(normalizedPayload.model);
    const route = await this.aiRoutingService.resolveModelRouteByCapability(appSlug, 'video', requestedModel);
    if (this.shouldUseRunningHub(route)) {
      const startedAt = Date.now();
      let taskId: string | null = null;
      const preparedPayload: Record<string, unknown> = {
        ...route.request_overrides,
        ...normalizedPayload,
        model: route.upstream_model,
      };
      await this.assertSufficientPointsBeforeInvoke(route, preparedPayload, context);
      const reservation = await this.reserveAsyncVideoPoints(route, preparedPayload, context);
      try {
        const forwarded = await this.forwardRunningHubVideoAsync(route, preparedPayload, context);
        const response = this.normalizeObject((forwarded as ForwardedJsonResponse).data);
        taskId =
          extractRunningHubTaskId(response)
          || this.stringOrUndefined(response.task_id)
          || this.stringOrUndefined(response.request_id)
          || null;
        if (!taskId) {
          throw new BadGatewayException('RunningHub async video accepted but no task_id returned');
        }
        const task = await this.createRunningHubAsyncVideoTask(
          route,
          preparedPayload,
          context,
          taskId,
          response,
          reservation?.reservation_key || null,
        );
        if (reservation && context.user_id) {
          await this.aiPointsService.attachReservationTask({
            app_id: route.app_id,
            user_id: context.user_id,
            reservation_key: reservation.reservation_key,
            external_task_id: taskId,
            usage_reference_id: this.stringOrUndefined(task.usage_reference_id) || this.buildAiUsageReferenceId(route, taskId),
            metadata: {
              model_key: route.model_key,
              upstream_model: route.upstream_model,
              provider: 'runninghub',
            },
          });
        }
        return forwarded;
      } catch (error) {
        this.logUsageSafe(route, preparedPayload, context, {
          success: false,
          is_stream: false,
          usage: {},
          request_id: taskId,
          latency_ms: Date.now() - startedAt,
          error_message: this.truncate(String((error as any)?.message || 'unknown error'), 900),
        });
        if (reservation && context.user_id) {
          await this.aiPointsService.releaseReservationByKey({
            app_id: route.app_id,
            user_id: context.user_id,
            reservation_key: reservation.reservation_key,
            metadata: {
              reason: 'upstream_create_failed',
              provider: 'runninghub',
              error_message: String((error as any)?.message || 'request failed'),
            },
          });
        }
        throw error;
      }
    }
    if (this.shouldUseAliyunIceVideoTranslation(route)) {
      return this.submitVideoTranslationJob(appSlug, normalizedPayload, context);
    }
    if (this.shouldUseOpenRouter(route)) {
      const preparedPayload: Record<string, unknown> = {
        ...route.request_overrides,
        ...normalizedPayload,
        model: route.upstream_model,
      };
      await this.assertSufficientPointsBeforeInvoke(route, preparedPayload, context);
      return this.forwardOpenRouterVideo(route, preparedPayload, context);
    }
    if (!this.shouldUseDashscopeNative(route)) {
      throw new BadRequestException('当前视频模型不支持异步视频接口');
    }
    await this.assertSufficientPointsBeforeInvoke(route, normalizedPayload, context);
    const reservation = await this.reserveAsyncVideoPoints(route, normalizedPayload, context);
    const preparedPayload: Record<string, unknown> = {
      ...route.request_overrides,
      ...normalizedPayload,
      model: route.upstream_model,
    };
    try {
      const task = await this.createDashscopeAsyncVideoTask(route, preparedPayload, context, reservation?.reservation_key || null);
      await this.pumpDashscopeVideoQueue(route);
      const refreshed = await this.findDashscopeAsyncVideoTask(route.app_id, task.public_task_id, context.user_id || null);
      return {
        stream: false,
        data: await this.buildDashscopeAsyncVideoQueueResponse(refreshed || task),
      };
    } catch (error) {
      if (reservation && context.user_id) {
        await this.aiPointsService.releaseReservationByKey({
          app_id: route.app_id,
          user_id: context.user_id,
          reservation_key: reservation.reservation_key,
          metadata: {
            reason: 'upstream_create_failed',
            error_message: String((error as any)?.message || 'request failed'),
          },
        });
      }
      throw error;
    }
  }

  async queryVideoAsyncTask(
    appSlug: string,
    payload: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<ForwardedAiResponse> {
    const taskId = this.stringOrUndefined(payload.task_id ?? payload.taskId);
    if (!taskId) {
      throw new BadRequestException('task_id is required');
    }
    const requestedModel = this.stringOrUndefined(payload.model);
    const appId = await this.resolveAppIdBySlug(appSlug);
    const queuedTask = await this.findDashscopeAsyncVideoTask(appId, taskId, context.user_id || null);
    if (queuedTask) {
      const route = await this.aiRoutingService.resolveModelRouteByCapability(appSlug, 'video', queuedTask.model_key);
      if (this.shouldUseRunningHub(route)) {
        return this.queryRunningHubExternalVideoTask(route, queuedTask, context);
      }
      if (this.shouldUseAliyunIceVideoTranslation(route)) {
        return this.queryAliyunIceVideoTranslationExternalTask(route, queuedTask, context);
      }
      if (!this.shouldUseDashscopeNative(route)) {
        throw new BadRequestException('当前视频模型不支持异步视频任务查询');
      }
      await this.pumpDashscopeVideoQueue(route);
      const latestTask = await this.findDashscopeAsyncVideoTask(appId, taskId, context.user_id || null);
      if (!latestTask) {
        throw new NotFoundException('video task not found');
      }
      if (!latestTask.external_task_id) {
        return {
          stream: false,
          data: await this.buildDashscopeAsyncVideoQueueResponse(latestTask),
        };
      }
      return this.queryDashscopeExternalVideoTask(route, latestTask, context);
    }

    const route = await this.aiRoutingService.resolveModelRouteByCapability(appSlug, 'video', requestedModel);
    if (this.shouldUseRunningHub(route)) {
      const data = await this.fetchRunningHubTaskData(route, payload, taskId, context);
      await this.finalizeRunningHubVideoTaskIfTerminal(route, null, payload, data, taskId, context);
      return {
        stream: false,
        data: await this.buildRunningHubVideoTaskResponseWithProxy(route, data, {
          includeVideoUrls: true,
          fallbackTaskId: taskId,
          proxyWaitTimeoutMs: 12_000,
        }),
      };
    }
    if (this.shouldUseAliyunIceVideoTranslation(route)) {
      const data = await this.fetchAliyunIceVideoTranslationTaskData(route, taskId);
      return {
        stream: false,
        data: this.buildAliyunIceVideoTranslationTaskResponse(data, {
          includeUrls: true,
          fallbackTaskId: taskId,
          providerTaskId: taskId,
        }),
      };
    }
    if (this.shouldUseOpenRouter(route)) {
      return this.queryOpenRouterVideoTask(route, payload, taskId, context);
    }
    if (!this.shouldUseDashscopeNative(route)) {
      throw new BadRequestException('当前视频模型不支持异步视频任务查询');
    }
    const data = await this.fetchDashscopeTaskData(route, payload, taskId);
    return {
      stream: false,
      data: this.buildDashscopeVideoTaskResponse(data, {
        includeVideoUrls: true,
        fallbackTaskId: taskId,
      }),
    };
  }

  private async queryDashscopeExternalVideoTask(
    route: ResolvedAiRoute,
    task: DashscopeAsyncVideoTaskRow,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const cachedResponse = this.normalizeObject(task.response_json);
    const cachedStatus = String(task.status || '').toUpperCase();
    const useCachedTerminalResponse =
      cachedStatus
      && (this.isDashscopeTaskTerminalSuccess(cachedStatus) || this.isDashscopeTaskTerminalFailure(cachedStatus))
      && Object.keys(cachedResponse).length > 0;
    if (!task.external_task_id && !useCachedTerminalResponse) {
      return {
        stream: false,
        data: await this.buildDashscopeAsyncVideoQueueResponse(task),
      };
    }
    const payload = this.normalizeObject(task.request_payload_json);
    const data = useCachedTerminalResponse
      ? cachedResponse
      : await this.fetchDashscopeTaskData(route, payload, task.external_task_id || task.public_task_id);
    const usage = {
      ...this.extractUsageMetrics(data),
      duration_seconds:
        this.extractDashscopeVideoDurationSeconds(data)
        ?? this.resolveDurationSecondsFromPayload(payload),
    };
    const status = this.extractDashscopeTaskStatus(data) || cachedStatus;
    const usageReferenceId = this.stringOrUndefined(task.usage_reference_id) || this.buildAiUsageReferenceId(route, task.public_task_id);
    const reservation = task.external_task_id && context.user_id
      ? await this.aiPointsService.findReservationByTask({
          app_id: route.app_id,
          user_id: context.user_id,
          external_task_id: task.external_task_id,
        })
      : null;
    const alreadyRecorded = await this.aiRoutingService.hasUsageReference(usageReferenceId);
    if (status && this.isDashscopeTaskTerminalSuccess(status)) {
      if (!alreadyRecorded) {
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage,
          request_id: task.external_task_id,
          usage_reference_id: usageReferenceId,
          latency_ms: null,
          billable: reservation ? false : undefined,
        });
      }
      if (reservation && reservation.status === 'pending' && context.user_id && task.external_task_id) {
        const billing = this.resolveBillingMetrics(
          route,
          payload,
          {
            prompt_tokens: usage.prompt_tokens ?? null,
            completion_tokens: usage.completion_tokens ?? null,
            total_tokens: usage.total_tokens ?? null,
            duration_seconds: usage.duration_seconds ?? null,
            image_count: usage.image_count ?? null,
            video_resolution: usage.video_resolution ?? null,
          },
          'actual',
        );
        const settings = await this.aiPointsService.getSettingsByAppId(route.app_id);
        const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
        const pointCharge = this.resolvePointsCharge(route, billing, pointsPerYuan);
        await this.aiPointsService.settleReservation({
          app_id: route.app_id,
          user_id: context.user_id,
          external_task_id: task.external_task_id,
          success: true,
          settled_points: pointCharge.points,
          usage_reference_id: usageReferenceId,
          request_id: task.external_task_id,
          metadata: {
            model_id: route.model_id,
            model_key: route.model_key,
            upstream_model: route.upstream_model,
            capability: route.capability,
            billed_units: billing.billed_units,
            billed_unit_label: billing.billed_unit_label,
            billed_duration_seconds: billing.billed_duration_seconds,
            estimated_cost_rmb: billing.estimated_cost_rmb,
            points_pricing_source: pointCharge.source,
            points_per_yuan: pointsPerYuan,
            request_path: context.request_path || '',
          },
        });
        await this.aiRoutingService.updateUsagePointsSettlement({
          usage_reference_id: usageReferenceId,
          points_cost: pointCharge.points,
          points_pricing_source: pointCharge.source,
        });
      } else if (alreadyRecorded && reservation && reservation.status === 'captured' && reservation.settled_points > 0) {
        await this.aiRoutingService.updateUsagePointsSettlement({
          usage_reference_id: usageReferenceId,
          points_cost: reservation.settled_points,
          points_pricing_source: this.stringOrUndefined(reservation.metadata?.points_pricing_source) || 'reserved_points_capture',
        });
      }
      await this.finishDashscopeAsyncVideoTask(task.id, status, data, null);
    } else if (
      status
      && this.isDashscopeTaskTerminalFailure(status)
      && reservation
      && reservation.status === 'pending'
      && context.user_id
      && task.external_task_id
    ) {
      await this.aiPointsService.settleReservation({
        app_id: route.app_id,
        user_id: context.user_id,
        external_task_id: task.external_task_id,
        success: false,
        settled_points: 0,
        usage_reference_id: usageReferenceId,
        request_id: task.external_task_id,
        metadata: {
          request_path: context.request_path || '',
          error_message: this.resolveDashscopeTaskErrorMessage(data),
        },
      });
      await this.finishDashscopeAsyncVideoTask(task.id, status, data, this.resolveDashscopeTaskErrorMessage(data) || null);
    } else {
      await this.refreshDashscopeAsyncVideoTaskStatus(task.id, status || 'PENDING', data);
    }
    return {
      stream: false,
      data: this.buildDashscopeVideoTaskResponse(data, {
        includeVideoUrls: true,
        fallbackTaskId: task.public_task_id,
        providerTaskId: task.external_task_id,
      }),
    };
  }

  private async queryRunningHubExternalVideoTask(
    route: ResolvedAiRoute,
    task: DashscopeAsyncVideoTaskRow,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const cachedResponse = this.normalizeObject(task.response_json);
    const cachedStatus = String(task.status || '').toUpperCase();
    const useCachedTerminalResponse =
      cachedStatus
      && (isRunningHubTaskTerminalSuccess(cachedStatus) || isRunningHubTaskTerminalFailure(cachedStatus))
      && Object.keys(cachedResponse).length > 0;
    const payload = this.normalizeObject(task.request_payload_json);
    const taskId = this.stringOrUndefined(task.external_task_id) || task.public_task_id;
    if (!taskId && !useCachedTerminalResponse) {
      return {
        stream: false,
        data: await this.buildDashscopeAsyncVideoQueueResponse(task),
      };
    }
    const data = useCachedTerminalResponse
      ? cachedResponse
      : await this.fetchRunningHubTaskData(route, payload, taskId, context);
    await this.finalizeRunningHubVideoTaskIfTerminal(route, task, payload, data, taskId, context);
    return {
      stream: false,
      data: await this.buildRunningHubVideoTaskResponseWithProxy(route, data, {
        includeVideoUrls: true,
        fallbackTaskId: task.public_task_id,
        proxyWaitTimeoutMs: 12_000,
      }),
    };
  }

  private async queryAliyunIceVideoTranslationExternalTask(
    route: ResolvedAiRoute,
    task: DashscopeAsyncVideoTaskRow,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const cachedResponse = this.normalizeObject(task.response_json);
    const cachedStatus = String(task.status || '').toUpperCase();
    const useCachedTerminalResponse =
      cachedStatus
      && (this.isAliyunIceVideoTranslationTerminalSuccess(cachedStatus) || this.isAliyunIceVideoTranslationTerminalFailure(cachedStatus))
      && Object.keys(cachedResponse).length > 0;
    const payload = this.normalizeObject(task.request_payload_json);
    const providerTaskId = this.stringOrUndefined(task.external_task_id) || task.public_task_id;
    const data = useCachedTerminalResponse
      ? cachedResponse
      : await this.fetchAliyunIceVideoTranslationTaskData(route, providerTaskId);
    await this.finalizeAliyunIceVideoTranslationTaskIfTerminal(route, task, payload, data, providerTaskId, context);
    return {
      stream: false,
      data: this.buildAliyunIceVideoTranslationTaskResponse(data, {
        includeUrls: true,
        fallbackTaskId: task.public_task_id,
        providerTaskId,
      }),
    };
  }

  private async finalizeAliyunIceVideoTranslationTaskIfTerminal(
    route: ResolvedAiRoute,
    task: DashscopeAsyncVideoTaskRow | null,
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
    fallbackTaskId: string | null,
    context: AiInvocationContext,
  ): Promise<void> {
    const status = this.extractAliyunIceVideoTranslationStatus(data);
    const externalTaskId =
      this.extractAliyunIceVideoTranslationJobId(data)
      || this.stringOrUndefined(task?.external_task_id)
      || this.stringOrUndefined(fallbackTaskId)
      || this.stringOrUndefined(task?.public_task_id);
    const publicTaskId = this.stringOrUndefined(task?.public_task_id) || externalTaskId;
    if (!status || (!this.isAliyunIceVideoTranslationTerminalSuccess(status) && !this.isAliyunIceVideoTranslationTerminalFailure(status))) {
      if (task) {
        await this.refreshDashscopeAsyncVideoTaskStatus(task.id, status || 'PENDING', data);
      }
      return;
    }

    const usageReferenceId =
      this.stringOrUndefined(task?.usage_reference_id)
      || this.buildAiUsageReferenceId(route, publicTaskId || externalTaskId || null);
    const reservation = externalTaskId && context.user_id
      ? await this.aiPointsService.findReservationByTask({
          app_id: route.app_id,
          user_id: context.user_id,
          external_task_id: externalTaskId,
        })
      : null;
    const alreadyRecorded = await this.aiRoutingService.hasUsageReference(usageReferenceId);

    if (this.isAliyunIceVideoTranslationTerminalSuccess(status)) {
      const outputUrls = this.extractAliyunIceVideoTranslationOutputUrls(data);
      if (outputUrls.length === 0) {
        const errorMessage = 'Aliyun ICE video translation completed but returned no output url';
        if (!alreadyRecorded) {
          this.logUsageSafe(route, payload, context, {
            success: false,
            is_stream: false,
            usage: {},
            request_id: externalTaskId,
            usage_reference_id: usageReferenceId,
            latency_ms: null,
            error_message: errorMessage,
            billable: false,
          });
        }
        if (reservation && reservation.status === 'pending' && context.user_id && externalTaskId) {
          await this.aiPointsService.settleReservation({
            app_id: route.app_id,
            user_id: context.user_id,
            external_task_id: externalTaskId,
            success: false,
            settled_points: 0,
            usage_reference_id: usageReferenceId,
            request_id: externalTaskId,
            metadata: {
              provider: ALIYUN_ICE_PROVIDER_TYPE,
              request_path: context.request_path || '',
              error_message: errorMessage,
            },
          });
        }
        if (task) {
          await this.finishDashscopeAsyncVideoTask(task.id, status, data, errorMessage);
        }
        return;
      }

      const usage: AiUsageMetrics = {
        ...this.extractUsageMetrics(data),
        duration_seconds: this.extractDurationSecondsFromData(data)
          ?? this.resolveDurationSecondsFromPayload(payload),
        video_resolution: this.extractVideoResolutionFromData(data)
          || this.resolveVideoResolutionFromPayload(payload),
        request_id: externalTaskId,
      };
      if (!alreadyRecorded) {
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage,
          request_id: externalTaskId,
          usage_reference_id: usageReferenceId,
          latency_ms: null,
          billable: reservation ? false : undefined,
        });
      }
      if (reservation && reservation.status === 'pending' && context.user_id && externalTaskId) {
        await this.settleAsyncVideoReservationSuccess(
          route,
          payload,
          context,
          usage,
          usageReferenceId,
          externalTaskId,
          ALIYUN_ICE_PROVIDER_TYPE,
        );
      } else if (alreadyRecorded && reservation && reservation.status === 'captured' && reservation.settled_points > 0) {
        await this.aiRoutingService.updateUsagePointsSettlement({
          usage_reference_id: usageReferenceId,
          points_cost: reservation.settled_points,
          points_pricing_source: this.stringOrUndefined(reservation.metadata?.points_pricing_source) || 'reserved_points_capture',
        });
      }
      if (task) {
        await this.finishDashscopeAsyncVideoTask(task.id, status, data, null);
      }
      return;
    }

    const errorMessage = this.extractAliyunIceVideoTranslationErrorMessage(data) || `task_status=${status}`;
    if (!alreadyRecorded) {
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        request_id: externalTaskId,
        usage_reference_id: usageReferenceId,
        latency_ms: null,
        error_message: this.truncate(errorMessage, 900),
        billable: false,
      });
    }
    if (reservation && reservation.status === 'pending' && context.user_id && externalTaskId) {
      await this.aiPointsService.settleReservation({
        app_id: route.app_id,
        user_id: context.user_id,
        external_task_id: externalTaskId,
        success: false,
        settled_points: 0,
        usage_reference_id: usageReferenceId,
        request_id: externalTaskId,
        metadata: {
          provider: ALIYUN_ICE_PROVIDER_TYPE,
          request_path: context.request_path || '',
          error_message: errorMessage,
        },
      });
    }
    if (task) {
      await this.finishDashscopeAsyncVideoTask(task.id, status, data, errorMessage || null);
    }
  }

  private async finalizeRunningHubVideoTaskIfTerminal(
    route: ResolvedAiRoute,
    task: DashscopeAsyncVideoTaskRow | null,
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
    fallbackTaskId: string | null,
    context: AiInvocationContext,
  ): Promise<void> {
    const status = extractRunningHubTaskStatus(data);
    const externalTaskId =
      extractRunningHubTaskId(data)
      || this.stringOrUndefined(task?.external_task_id)
      || this.stringOrUndefined(fallbackTaskId)
      || this.stringOrUndefined(task?.public_task_id);
    const publicTaskId = this.stringOrUndefined(task?.public_task_id) || externalTaskId;
    if (!status || (!isRunningHubTaskTerminalSuccess(status) && !isRunningHubTaskTerminalFailure(status))) {
      if (task) {
        await this.refreshDashscopeAsyncVideoTaskStatus(task.id, status || 'PENDING', data);
      }
      return;
    }
    const usageReferenceId =
      this.stringOrUndefined(task?.usage_reference_id)
      || this.buildAiUsageReferenceId(route, publicTaskId || externalTaskId || null);
    const reservation = externalTaskId && context.user_id
      ? await this.aiPointsService.findReservationByTask({
          app_id: route.app_id,
          user_id: context.user_id,
          external_task_id: externalTaskId,
        })
      : null;
    const alreadyRecorded = await this.aiRoutingService.hasUsageReference(usageReferenceId);

    if (isRunningHubTaskTerminalSuccess(status)) {
      const videoUrls = extractRunningHubResultUrls(data);
      if (videoUrls.length === 0) {
        const errorMessage = 'RunningHub task completed but returned no video url';
        if (!alreadyRecorded) {
          this.logUsageSafe(route, payload, context, {
            success: false,
            is_stream: false,
            usage: {},
            request_id: externalTaskId,
            usage_reference_id: usageReferenceId,
            latency_ms: null,
            error_message: errorMessage,
            billable: false,
          });
        }
        if (reservation && reservation.status === 'pending' && context.user_id && externalTaskId) {
          await this.aiPointsService.settleReservation({
            app_id: route.app_id,
            user_id: context.user_id,
            external_task_id: externalTaskId,
            success: false,
            settled_points: 0,
            usage_reference_id: usageReferenceId,
            request_id: externalTaskId,
            metadata: {
              provider: 'runninghub',
              request_path: context.request_path || '',
              error_message: errorMessage,
            },
          });
        }
        if (task) {
          await this.finishDashscopeAsyncVideoTask(task.id, status, data, errorMessage);
        }
        return;
      }

      const usage: AiUsageMetrics = {
        ...this.extractUsageMetrics(data),
        duration_seconds: this.extractRunningHubVideoDurationSeconds(data)
          ?? this.resolveDurationSecondsFromPayload(payload),
        video_resolution: this.extractVideoResolutionFromData(data)
          || this.resolveVideoResolutionFromPayload(payload),
        request_id: externalTaskId,
      };
      if (!alreadyRecorded) {
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage,
          request_id: externalTaskId,
          usage_reference_id: usageReferenceId,
          latency_ms: null,
          billable: reservation ? false : undefined,
        });
      }
      if (reservation && reservation.status === 'pending' && context.user_id && externalTaskId) {
        await this.settleAsyncVideoReservationSuccess(route, payload, context, usage, usageReferenceId, externalTaskId);
      } else if (alreadyRecorded && reservation && reservation.status === 'captured' && reservation.settled_points > 0) {
        await this.aiRoutingService.updateUsagePointsSettlement({
          usage_reference_id: usageReferenceId,
          points_cost: reservation.settled_points,
          points_pricing_source: this.stringOrUndefined(reservation.metadata?.points_pricing_source) || 'reserved_points_capture',
        });
      }
      if (task) {
        await this.finishDashscopeAsyncVideoTask(task.id, status, data, null);
      }
      return;
    }

    const errorMessage = extractRunningHubTaskErrorMessage(data) || `task_status=${status}`;
    if (!alreadyRecorded) {
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        request_id: externalTaskId,
        usage_reference_id: usageReferenceId,
        latency_ms: null,
        error_message: this.truncate(errorMessage, 900),
        billable: false,
      });
    }
    if (reservation && reservation.status === 'pending' && context.user_id && externalTaskId) {
      await this.aiPointsService.settleReservation({
        app_id: route.app_id,
        user_id: context.user_id,
        external_task_id: externalTaskId,
        success: false,
        settled_points: 0,
        usage_reference_id: usageReferenceId,
        request_id: externalTaskId,
        metadata: {
          provider: 'runninghub',
          request_path: context.request_path || '',
          error_message: errorMessage,
        },
      });
    }
    if (task) {
      await this.finishDashscopeAsyncVideoTask(task.id, status, data, errorMessage || null);
    }
  }

  private async settleAsyncVideoReservationSuccess(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    usage: AiUsageMetrics,
    usageReferenceId: string,
    externalTaskId: string,
    provider = 'runninghub',
  ): Promise<void> {
    if (!context.user_id) {
      return;
    }
    const billing = this.resolveBillingMetrics(
      route,
      payload,
      {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        duration_seconds: usage.duration_seconds ?? null,
        image_count: usage.image_count ?? null,
        video_resolution: usage.video_resolution ?? null,
      },
      'actual',
    );
    const settings = await this.aiPointsService.getSettingsByAppId(route.app_id);
    const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
    const pointCharge = this.resolvePointsCharge(route, billing, pointsPerYuan);
    await this.aiPointsService.settleReservation({
      app_id: route.app_id,
      user_id: context.user_id,
      external_task_id: externalTaskId,
      success: true,
      settled_points: pointCharge.points,
      usage_reference_id: usageReferenceId,
      request_id: externalTaskId,
      metadata: {
        model_id: route.model_id,
        model_key: route.model_key,
        upstream_model: route.upstream_model,
        capability: route.capability,
        provider,
        billed_units: billing.billed_units,
        billed_unit_label: billing.billed_unit_label,
        billed_duration_seconds: billing.billed_duration_seconds,
        estimated_cost_rmb: billing.estimated_cost_rmb,
        points_pricing_source: pointCharge.source,
        points_per_yuan: pointsPerYuan,
        request_path: context.request_path || '',
      },
    });
    await this.aiRoutingService.updateUsagePointsSettlement({
      usage_reference_id: usageReferenceId,
      points_cost: pointCharge.points,
      points_pricing_source: pointCharge.source,
    });
  }

  private async createDashscopeAsyncVideoTask(
    route: ResolvedAiRoute,
    preparedPayload: Record<string, unknown>,
    context: AiInvocationContext,
    reservationKey: string | null,
  ): Promise<DashscopeAsyncVideoTaskRow> {
    await this.ensureDashscopeVideoQueueSchema();
    const publicTaskId = this.buildAsyncVideoPublicTaskId(route);
    const usageReferenceId = this.buildAiUsageReferenceId(route, publicTaskId);
    const requestPath = this.stringOrUndefined(context.request_path) || null;
    const userId = this.stringOrUndefined(context.user_id) || null;
    const metadata = {
      app_slug: route.app_slug,
      model_key: route.model_key,
      upstream_model: route.upstream_model,
    };

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_async_video_tasks (
         id, app_id, user_id, public_task_id, source_id, model_id, model_key, upstream_model,
         status, reservation_key, usage_reference_id, request_payload_json, request_path, metadata_json
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7,
         'QUEUED', $8, $9, $10::jsonb, $11, $12::jsonb
       )
       RETURNING *`,
      route.app_id,
      userId,
      publicTaskId,
      route.source.id,
      route.model_id,
      route.model_key,
      route.upstream_model,
      this.normalizeNullableString(reservationKey, 128),
      this.normalizeNullableString(usageReferenceId, 120),
      JSON.stringify(preparedPayload),
      requestPath,
      JSON.stringify(metadata),
    ) as Promise<DashscopeAsyncVideoTaskRow[]>);
    return rows[0];
  }

  private async createRunningHubAsyncVideoTask(
    route: ResolvedAiRoute,
    preparedPayload: Record<string, unknown>,
    context: AiInvocationContext,
    taskId: string,
    response: Record<string, unknown>,
    reservationKey: string | null,
  ): Promise<DashscopeAsyncVideoTaskRow> {
    await this.ensureDashscopeVideoQueueSchema();
    const usageReferenceId = this.buildAiUsageReferenceId(route, taskId);
    const requestPath = this.stringOrUndefined(context.request_path) || null;
    const userId = this.stringOrUndefined(context.user_id) || null;
    const metadata = {
      provider: 'runninghub',
      app_slug: route.app_slug,
      model_key: route.model_key,
      upstream_model: route.upstream_model,
    };
    const status = String(extractRunningHubTaskStatus(response) || 'PENDING').toUpperCase().slice(0, 24);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_async_video_tasks (
         id, app_id, user_id, public_task_id, external_task_id, source_id, model_id, model_key, upstream_model,
         status, reservation_key, usage_reference_id, request_payload_json, response_json, request_path, metadata_json,
         started_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $3, $4::uuid, $5::uuid, $6, $7,
         $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb, now()
       )
       ON CONFLICT (app_id, public_task_id)
       DO UPDATE SET
         external_task_id = COALESCE(ai_async_video_tasks.external_task_id, EXCLUDED.external_task_id),
         status = EXCLUDED.status,
         reservation_key = COALESCE(ai_async_video_tasks.reservation_key, EXCLUDED.reservation_key),
         usage_reference_id = COALESCE(ai_async_video_tasks.usage_reference_id, EXCLUDED.usage_reference_id),
         request_payload_json = EXCLUDED.request_payload_json,
         response_json = EXCLUDED.response_json,
         request_path = COALESCE(EXCLUDED.request_path, ai_async_video_tasks.request_path),
         metadata_json = COALESCE(ai_async_video_tasks.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
         started_at = COALESCE(ai_async_video_tasks.started_at, EXCLUDED.started_at),
         updated_at = now()
       RETURNING *`,
      route.app_id,
      userId,
      this.normalizeNullableString(taskId, 128),
      route.source.id,
      route.model_id,
      route.model_key,
      route.upstream_model,
      status,
      this.normalizeNullableString(reservationKey, 128),
      this.normalizeNullableString(usageReferenceId, 120),
      JSON.stringify(preparedPayload),
      JSON.stringify(response),
      requestPath,
      JSON.stringify(metadata),
    ) as Promise<DashscopeAsyncVideoTaskRow[]>);
    return rows[0];
  }

  private async createAliyunIceVideoTranslationTask(
    route: ResolvedAiRoute,
    preparedPayload: Record<string, unknown>,
    context: AiInvocationContext,
    taskId: string,
    response: Record<string, unknown>,
    reservationKey: string | null,
  ): Promise<DashscopeAsyncVideoTaskRow> {
    await this.ensureDashscopeVideoQueueSchema();
    const publicTaskId = this.buildAsyncVideoPublicTaskId(route);
    const usageReferenceId = this.buildAiUsageReferenceId(route, publicTaskId);
    const requestPath = this.stringOrUndefined(context.request_path) || null;
    const userId = this.stringOrUndefined(context.user_id) || null;
    const metadata = {
      provider: ALIYUN_ICE_PROVIDER_TYPE,
      task_kind: 'video_translation',
      app_slug: route.app_slug,
      model_key: route.model_key,
      upstream_model: route.upstream_model,
    };
    const status = String(this.extractAliyunIceVideoTranslationStatus(response) || 'PENDING').toUpperCase().slice(0, 24);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_async_video_tasks (
         id, app_id, user_id, public_task_id, external_task_id, source_id, model_id, model_key, upstream_model,
         status, reservation_key, usage_reference_id, request_payload_json, response_json, request_path, metadata_json,
         started_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8,
         $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15::jsonb, now()
       )
       RETURNING *`,
      route.app_id,
      userId,
      publicTaskId,
      this.normalizeNullableString(taskId, 128),
      route.source.id,
      route.model_id,
      route.model_key,
      route.upstream_model,
      status,
      this.normalizeNullableString(reservationKey, 128),
      this.normalizeNullableString(usageReferenceId, 120),
      JSON.stringify(preparedPayload),
      JSON.stringify(response),
      requestPath,
      JSON.stringify(metadata),
    ) as Promise<DashscopeAsyncVideoTaskRow[]>);
    return rows[0];
  }

  private async pumpDashscopeVideoQueue(route: ResolvedAiRoute): Promise<void> {
    await this.ensureDashscopeVideoQueueSchema();
    const limit = this.resolveDashscopeVideoConcurrencyLimit(route);
    const maxStarts = Math.max(1, limit);
    for (let startedCount = 0; startedCount < maxStarts; startedCount += 1) {
      const claimed = await this.claimNextDashscopeAsyncVideoTask(route, limit);
      if (!claimed) {
        return;
      }
      try {
        let upstreamPayload = this.normalizeObject(claimed.request_payload_json);
        upstreamPayload = await this.rewriteDashscopeBase64Inputs(route, upstreamPayload, {
          user_id: claimed.user_id,
          request_path: claimed.request_path || '',
        });
        const forwarded = await this.forwardDashscopeNativeVideoAsync(route, upstreamPayload);
        const providerTaskId = this.stringOrUndefined((forwarded as any)?.data?.task_id);
        if (!providerTaskId) {
          throw new BadGatewayException('DashScope async video accepted but no task_id returned');
        }
        const upstreamResponse = this.normalizeObject((forwarded as any)?.data);
        await this.markDashscopeAsyncVideoTaskSubmitted(claimed.id, providerTaskId, upstreamResponse);
        if (claimed.user_id && claimed.reservation_key) {
          await this.aiPointsService.attachReservationTask({
            app_id: route.app_id,
            user_id: claimed.user_id,
            reservation_key: claimed.reservation_key,
            external_task_id: providerTaskId,
            usage_reference_id: this.stringOrUndefined(claimed.usage_reference_id) || this.buildAiUsageReferenceId(route, claimed.public_task_id),
            metadata: {
              model_key: route.model_key,
              upstream_model: route.upstream_model,
            },
          });
        }
      } catch (error) {
        const errorMessage = String((error as any)?.message || 'DashScope async video create failed');
        await this.failDashscopeAsyncVideoTask(claimed.id, errorMessage);
        if (claimed.user_id && claimed.reservation_key) {
          await this.aiPointsService.releaseReservationByKey({
            app_id: route.app_id,
            user_id: claimed.user_id,
            reservation_key: claimed.reservation_key,
            metadata: {
              reason: 'queue_submission_failed',
              error_message: errorMessage,
            },
          });
        }
      }
    }
  }

  private async claimNextDashscopeAsyncVideoTask(
    route: ResolvedAiRoute,
    concurrencyLimit: number,
  ): Promise<DashscopeAsyncVideoTaskRow | null> {
    await this.ensureDashscopeVideoQueueSchema();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        route.source.id,
        route.upstream_model,
      );
      const activeRows = await (tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM ai_async_video_tasks
          WHERE source_id = $1::uuid
            AND upstream_model = $2
            AND status IN ('SUBMITTING', 'PENDING', 'RUNNING')`,
        route.source.id,
        route.upstream_model,
      ) as Promise<Array<{ count: number | string }>>);
      const activeCount = Number(activeRows[0]?.count || 0);
      if (activeCount >= concurrencyLimit) {
        return null;
      }

      const candidates = await (tx.$queryRawUnsafe(
        `SELECT *
           FROM ai_async_video_tasks
          WHERE source_id = $1::uuid
            AND upstream_model = $2
            AND status = 'QUEUED'
          ORDER BY queued_at ASC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        route.source.id,
        route.upstream_model,
      ) as Promise<DashscopeAsyncVideoTaskRow[]>);
      const candidate = candidates[0];
      if (!candidate) {
        return null;
      }

      const updatedRows = await (tx.$queryRawUnsafe(
        `UPDATE ai_async_video_tasks
            SET status = 'SUBMITTING',
                started_at = COALESCE(started_at, now()),
                error_message = NULL,
                updated_at = now()
          WHERE id = $1::uuid
          RETURNING *`,
        candidate.id,
      ) as Promise<DashscopeAsyncVideoTaskRow[]>);
      return updatedRows[0] || null;
    });
  }

  private async markDashscopeAsyncVideoTaskSubmitted(
    taskRowId: string,
    providerTaskId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const status = this.extractDashscopeTaskStatus(response) || 'PENDING';
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_async_video_tasks
          SET external_task_id = $2,
              status = $3,
              response_json = $4::jsonb,
              updated_at = now()
        WHERE id = $1::uuid`,
      taskRowId,
      this.normalizeNullableString(providerTaskId, 128),
      status,
      JSON.stringify(response),
    );
  }

  private async refreshDashscopeAsyncVideoTaskStatus(
    taskRowId: string,
    status: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_async_video_tasks
          SET status = $2,
              response_json = $3::jsonb,
              updated_at = now()
        WHERE id = $1::uuid`,
      taskRowId,
      String(status || 'PENDING').toUpperCase(),
      JSON.stringify(response),
    );
  }

  private async finishDashscopeAsyncVideoTask(
    taskRowId: string,
    status: string,
    response: Record<string, unknown>,
    errorMessage: string | null,
  ): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_async_video_tasks
          SET status = $2,
              response_json = $3::jsonb,
              error_message = $4,
              finished_at = now(),
              updated_at = now()
        WHERE id = $1::uuid`,
      taskRowId,
      String(status || 'UNKNOWN').toUpperCase(),
      JSON.stringify(response),
      this.normalizeNullableString(errorMessage, 1000),
    );
  }

  private async failDashscopeAsyncVideoTask(taskRowId: string, errorMessage: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_async_video_tasks
          SET status = 'FAILED',
              error_message = $2,
              finished_at = now(),
              updated_at = now()
        WHERE id = $1::uuid`,
      taskRowId,
      this.normalizeNullableString(errorMessage, 1000),
    );
  }

  private async findDashscopeAsyncVideoTask(
    appId: string,
    publicTaskId: string,
    userId?: string | null,
  ): Promise<DashscopeAsyncVideoTaskRow | null> {
    await this.ensureDashscopeVideoQueueSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM ai_async_video_tasks
        WHERE app_id = $1::uuid
          AND public_task_id = $2
          AND ($3::uuid IS NULL OR user_id = $3::uuid)
        LIMIT 1`,
      appId,
      this.normalizeNullableString(publicTaskId, 128),
      userId || null,
    ) as Promise<DashscopeAsyncVideoTaskRow[]>);
    return rows[0] || null;
  }

  private async buildDashscopeAsyncVideoQueueResponse(task: DashscopeAsyncVideoTaskRow): Promise<Record<string, unknown>> {
    const response = this.normalizeObject(task.response_json);
    const status = String(task.status || 'QUEUED').toUpperCase() as DashscopeAsyncVideoQueueStatus;
    const payload: Record<string, unknown> = {
      created: Math.floor(new Date(task.created_at || new Date()).getTime() / 1000),
      task_id: task.public_task_id,
      task_status: status,
      provider_task_id: task.external_task_id || undefined,
    };
    const requestId = this.stringOrUndefined(response.request_id);
    if (requestId) {
      payload.request_id = requestId;
    }
    if (task.external_task_id && task.external_task_id !== task.public_task_id) {
      payload.upstream_task_id = task.external_task_id;
    }
    if (status === 'QUEUED') {
      payload.message = '排队中';
      payload.queue_position = await this.estimateDashscopeVideoQueuePosition(task);
    } else if (status === 'SUBMITTING') {
      payload.message = '任务提交中';
    } else if (task.error_message) {
      payload.message = task.error_message;
    } else {
      const responseMessage = this.resolveDashscopeTaskErrorMessage(response);
      if (responseMessage) {
        payload.message = responseMessage;
      }
    }
    return payload;
  }

  private async estimateDashscopeVideoQueuePosition(task: DashscopeAsyncVideoTaskRow): Promise<number> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM ai_async_video_tasks
        WHERE source_id = $1::uuid
          AND upstream_model = $2
          AND status = 'QUEUED'
          AND (
            queued_at < $3::timestamptz
            OR (queued_at = $3::timestamptz AND created_at <= $4::timestamptz)
          )`,
      task.source_id,
      task.upstream_model,
      task.queued_at,
      task.created_at,
    ) as Promise<Array<{ count: number | string }>>);
    return Math.max(1, Number(rows[0]?.count || 1));
  }

  private async reserveAsyncVideoPoints(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ) {
    if (context.skip_points) {
      return null;
    }
    const userId = this.stringOrUndefined(context.user_id);
    if (!userId) {
      return null;
    }
    const preflight = this.resolveBillingMetrics(
      route,
      payload,
      {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      },
      'preflight',
    );
    const settings = await this.aiPointsService.getSettingsByAppId(route.app_id);
    const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
    const requiredPoints = this.resolvePointsCharge(route, preflight, pointsPerYuan).points;
    if (requiredPoints <= 0) {
      return null;
    }
    return this.aiPointsService.reservePoints({
      app_id: route.app_id,
      user_id: userId,
      amount: requiredPoints,
      capability: route.capability,
      reservation_key: this.buildAsyncVideoReservationKey(route),
      metadata: {
        app_slug: route.app_slug,
        model_id: route.model_id,
        model_key: route.model_key,
        upstream_model: route.upstream_model,
        required_points: requiredPoints,
        request_path: context.request_path || '',
      },
    });
  }

  async listMinimaxVoices(appSlug: string | null | undefined, filters: Record<string, unknown> = {}) {
    const dynamicCatalog = await this.loadMinimaxVoiceCatalogFromApi(appSlug || '').catch((error: any) => {
      this.logger.warn(`Failed to load MiniMax voices from API: ${error?.message || error}`);
      return null;
    });
    const catalog = dynamicCatalog || this.loadMinimaxVoiceCatalog();
    if (!catalog) {
      return {
        ok: false,
        message: 'Minimax voice catalog not found',
        items: [],
        total: 0,
      };
    }

    const q = String(filters.q || '').trim().toLowerCase();
    const languageCode = normalizeLanguageCode(this.stringOrUndefined(filters.language) || '') || '';
    const inferredLanguageBoost = languageCode ? MINIMAX_LANGUAGE_BOOST_BY_CODE[languageCode] : '';
    const languageBoostRaw = this.stringOrUndefined(filters.language_boost) || inferredLanguageBoost || '';
    const languageBoost = String(languageBoostRaw).trim().toLowerCase();
    const languageEn = String(filters.language_en || '').trim().toLowerCase();
    const languageZh = String(filters.language_zh || '').trim().toLowerCase();
    const gender = String(filters.gender || '').trim().toLowerCase();
    const limitInput = Number(filters.limit ?? 200);
    const limit = Number.isFinite(limitInput) ? Math.min(Math.max(Math.round(limitInput), 1), 1000) : 200;

    let items = catalog.voices.filter((item) => !!item.voice_id);
    if (languageBoost) {
      items = items.filter((item) => String(item.language_boost || '').toLowerCase() === languageBoost);
    }
    if (languageEn) {
      items = items.filter((item) => String(item.language_en || '').toLowerCase().includes(languageEn));
    }
    if (languageZh) {
      items = items.filter((item) => String(item.language_zh || '').toLowerCase().includes(languageZh));
    }
    if (gender) {
      items = items.filter((item) => String(item.gender_hint || '').toLowerCase() === gender);
    }
    if (q) {
      items = items.filter((item) => {
        const haystack = [item.voice_id, item.voice_name, item.language_boost, item.language_en, item.language_zh]
          .map((value) => String(value || '').toLowerCase())
          .join(' ');
        return haystack.includes(q);
      });
    }

    const groupedRequested = filters.grouped === true || filters.grouped === 'true';
    const grouped = groupedRequested
      ? items.reduce<Record<string, number>>((acc, item) => {
          const key = String(item.language_boost || 'unknown');
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {})
      : undefined;

    return {
      ok: true,
      generated_at: catalog.generated_at,
      source_file: catalog.source_file,
      catalog_path: this.minimaxVoiceCatalogPath,
      source: dynamicCatalog ? 'minimax_api' : 'local_catalog',
      total_all: catalog.voices.length,
      total: items.length,
      total_filtered: items.length,
      items: items.slice(0, limit),
      grouped_by_language_boost: grouped,
    };
  }

  listGeminiVoices(filters: Record<string, unknown> = {}) {
    const q = String(filters.q || '').trim().toLowerCase();
    const languageCode = normalizeLanguageCode(this.stringOrUndefined(filters.language) || '') || '';
    const bcp47 = GEMINI_TTS_LANGUAGE_CODE_BY_LANGUAGE[languageCode] || '';
    const languageLabels = this.resolveGeminiVoiceLanguageLabels(languageCode);
    const limitInput = Number(filters.limit ?? 1000);
    const limit = Number.isFinite(limitInput) ? Math.min(Math.max(Math.round(limitInput), 1), 1000) : 1000;

    let items = GEMINI_TTS_VOICES.map((voice, index) => ({
      index: index + 1,
      provider: 'gemini' as const,
      language_zh: languageLabels.language_zh,
      language_en: languageLabels.language_en,
      language_boost: bcp47 || languageCode || 'auto',
      language_code: bcp47,
      voice_id: voice.voice_id,
      voice_name: `${voice.voice_id} - ${voice.style}`,
      style: voice.style,
      source_type: 'system' as const,
    }));

    if (q) {
      items = items.filter((item) => {
        const haystack = [item.voice_id, item.voice_name, item.style, item.language_code, item.language_en, item.language_zh]
          .map((value) => String(value || '').toLowerCase())
          .join(' ');
        return haystack.includes(q);
      });
    }

    return {
      ok: true,
      generated_at: 'static',
      source: 'gemini_static_catalog',
      provider: 'gemini',
      default_voice_id: GEMINI_TTS_DEFAULT_VOICE,
      language_code: bcp47,
      total_all: GEMINI_TTS_VOICES.length,
      total: items.length,
      total_filtered: items.length,
      items: items.slice(0, limit),
    };
  }

  isGeminiTtsVoiceName(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return GEMINI_TTS_VOICES.some((voice) => voice.voice_id.toLowerCase() === normalized);
  }

  isGeminiTtsModelKey(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized.includes('gemini') && normalized.includes('tts');
  }

  private resolveGeminiVoiceLanguageLabels(languageCode: string): { language_en: string; language_zh: string } {
    const boost = MINIMAX_LANGUAGE_BOOST_BY_CODE[languageCode] || '';
    return MINIMAX_LANGUAGE_LABELS_BY_BOOST[boost] || {
      language_en: languageCode || 'Auto',
      language_zh: languageCode || '自动',
    };
  }

  private shouldUseAiSdkForward(route: ResolvedAiRoute, capability: AiCapability): boolean {
    if (process.env.AI_DISABLE_VERCEL_SDK_FORWARD === '1') {
      return false;
    }
    if (capability === 'video') {
      return false;
    }
    if ((capability === 'image' || capability === 'stt') && this.shouldUseDashscopeNative(route)) {
      return false;
    }
    return true;
  }

  private shouldUseAnthropic(route: ResolvedAiRoute): boolean {
    if (!this.isAnthropicSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }
    return route.capability === 'chat';
  }

  private shouldUseGoogleGenAi(route: ResolvedAiRoute): boolean {
    if (!this.isGeminiSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }
    return route.capability === 'chat' || route.capability === 'embedding' || route.capability === 'image' || route.capability === 'tts';
  }

  private async forwardViaAiSdk(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const provider = createOpenAI({
      baseURL: this.resolveAiSdkBaseUrl(route),
      apiKey: route.source.api_key,
      headers: route.source.custom_headers,
      fetch: this.buildRouteFetch(route),
    });

    if (route.capability === 'chat') {
      return this.forwardAiSdkChat(route, payload, context, provider);
    }
    if (route.capability === 'embedding') {
      return this.forwardAiSdkEmbedding(route, payload, context, provider);
    }
    if (route.capability === 'image') {
      return this.forwardAiSdkImage(route, payload, context, provider);
    }
    if (route.capability === 'stt') {
      return this.forwardAiSdkStt(route, payload, context, provider);
    }
    if (route.capability === 'tts') {
      return this.forwardAiSdkTts(route, payload, context, provider);
    }

    throw new BadRequestException(`AI SDK unsupported capability: ${route.capability}`);
  }

  private async forwardViaAnthropic(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    if (route.capability !== 'chat') {
      throw new BadRequestException(`Anthropic source 暂只支持 capability=chat，当前为 ${route.capability}`);
    }
    return this.forwardAnthropicChat(route, payload, context);
  }

  private async forwardViaGoogleGenAi(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    return this.outboundHttp.runWithProxy(route.source.outbound_proxy_id, async () => {
      if (route.capability === 'chat') {
        return this.forwardGoogleGenAiChat(route, payload, context);
      }
      if (route.capability === 'embedding') {
        return this.forwardGoogleGenAiEmbedding(route, payload, context);
      }
      if (route.capability === 'image') {
        return this.forwardGoogleGenAiImage(route, payload, context);
      }
      if (route.capability === 'tts') {
        return this.forwardGoogleGenAiTts(route, payload, context);
      }
      throw new BadRequestException(`Google GenAI unsupported capability: ${route.capability}`);
    });
  }

  private shouldUseOpenRouter(route: ResolvedAiRoute): boolean {
    if (!route) {
      return false;
    }
    return this.isOpenRouterSource(route.source.provider_type, route.source.base_url)
      || this.isOpenRouterApiType(route.api_type);
  }

  private async forwardViaOpenRouter(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    if (route.capability === 'image') {
      return this.forwardOpenRouterImage(route, payload, context);
    }
    if (route.capability === 'tts') {
      return this.forwardOpenRouterSpeech(route, payload, context);
    }
    if (route.capability === 'stt') {
      return this.forwardOpenRouterTranscription(route, payload, context);
    }
    if (route.capability === 'video') {
      return this.forwardOpenRouterVideo(route, payload, context);
    }
    return this.forwardToUpstream(route, payload, context);
  }

  private async forwardOpenRouterImage(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const messages = Array.isArray(payload.messages) ? payload.messages : null;
    const prompt = this.stringOrUndefined(payload.prompt) || this.normalizePromptToText(payload.input);
    if (!messages && !prompt) {
      throw new BadRequestException('image prompt or messages is required');
    }
    const imageConfig = this.normalizeObject(payload.image_config);
    const nextPayload: Record<string, unknown> = {
      model: route.upstream_model,
      messages: messages || [{ role: 'user', content: prompt }],
      modalities: Array.isArray(payload.modalities) ? payload.modalities : ['image', 'text'],
      stream: false,
    };
    const aspectRatio = this.stringOrUndefined(payload.aspect_ratio ?? payload.aspectRatio);
    const imageSize = this.stringOrUndefined(payload.image_size ?? payload.imageSize ?? payload.resolution);
    if (Object.keys(imageConfig).length > 0 || aspectRatio || imageSize) {
      nextPayload.image_config = {
        ...imageConfig,
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(imageSize ? { image_size: imageSize } : {}),
      };
    }
    const provider = this.normalizeObject(payload.provider);
    if (Object.keys(provider).length > 0) {
      nextPayload.provider = provider;
    }
    return this.forwardToUpstream(route, nextPayload, context);
  }

  private async forwardOpenRouterSpeech(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const text = this.stringOrUndefined(payload.input) || this.stringOrUndefined(payload.text);
    if (!text) {
      throw new BadRequestException('input text is required');
    }
    const requestPayload: Record<string, unknown> = {
      model: route.upstream_model,
      input: text,
      voice: this.stringOrUndefined(payload.voice) || this.stringOrUndefined(payload.voice_id) || 'alloy',
      response_format: this.resolveOpenRouterSpeechResponseFormat(route, payload),
    };
    const speed = this.numberOrNull(payload.speed);
    if (speed !== null) {
      requestPayload.speed = speed;
    }
    const instructions = this.stringOrUndefined(payload.instructions);
    if (instructions) {
      requestPayload.instructions = instructions;
    }
    const provider = this.normalizeObject(payload.provider);
    if (Object.keys(provider).length > 0) {
      requestPayload.provider = provider;
    }
    return this.forwardOpenRouterJsonRequest(route, requestPayload, context);
  }

  private resolveOpenRouterSpeechResponseFormat(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): string {
    if (this.isOpenRouterGeminiTtsRoute(route)) {
      return 'pcm';
    }
    return (
      this.stringOrUndefined(payload.response_format) ||
      this.stringOrUndefined(payload.format) ||
      'mp3'
    ).toLowerCase();
  }

  private isOpenRouterGeminiTtsRoute(route: ResolvedAiRoute): boolean {
    return route.capability === 'tts'
      && this.shouldUseOpenRouter(route)
      && (
        this.isGeminiTtsModelKey(route.upstream_model) ||
        this.isGeminiTtsModelKey(route.model_key)
      );
  }

  private async forwardOpenRouterTranscription(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const requestPayload: Record<string, unknown> = {
      model: route.upstream_model,
      input_audio: await this.resolveOpenRouterInputAudio(route, payload),
    };
    const language = this.stringOrUndefined(payload.language);
    if (language) {
      requestPayload.language = language;
    }
    const temperature = this.numberOrNull(payload.temperature);
    if (temperature !== null) {
      requestPayload.temperature = temperature;
    }
    const provider = this.normalizeObject(payload.provider);
    if (Object.keys(provider).length > 0) {
      requestPayload.provider = provider;
    }
    return this.forwardOpenRouterJsonRequest(route, requestPayload, context);
  }

  private async forwardOpenRouterVideo(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const prompt = this.stringOrUndefined(payload.prompt) || this.normalizePromptToText(payload.input);
    if (!prompt) {
      throw new BadRequestException('video prompt is required');
    }
    const requestPayload: Record<string, unknown> = {
      model: route.upstream_model,
      prompt,
    };
    [
      'duration',
      'resolution',
      'aspect_ratio',
      'size',
      'frame_images',
      'input_references',
      'generate_audio',
      'seed',
      'callback_url',
      'provider',
    ].forEach((key) => {
      if (payload[key] !== undefined) {
        requestPayload[key] = payload[key];
      }
    });
    return this.forwardOpenRouterJsonRequest(route, requestPayload, context);
  }

  private async queryOpenRouterVideoTask(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    taskId: string,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const pollingUrl = this.resolveOpenRouterPollingUrl(route, payload, taskId);
    const startedAt = Date.now();
    const response = await this.aiUpstreamClient.fetch(route, pollingUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
    }, {
      timeoutMs: this.resolveDirectUpstreamTimeoutMs(route),
    });
    if (!response.ok) {
      const errorBody = await this.aiUpstreamClient.readText(response);
      this.logger.warn(JSON.stringify({
        event: 'openrouter_upstream_error',
        status: response.status,
        model_key: route.model_key,
        upstream_model: route.upstream_model,
        capability: route.capability,
        api_type: route.api_type,
        source_id: route.source.id,
        source_name: route.source.name,
        outbound_proxy_id: route.source.outbound_proxy_id || null,
        endpoint_path: route.endpoint_path || this.defaultOpenRouterEndpoint(route.capability),
        endpoint_host: this.safeUrlHost(pollingUrl),
        request_path: context.request_path || null,
        request_summary: this.summarizeOpenRouterPayloadForLog(payload),
        upstream_error: this.truncate(String(errorBody || response.statusText || ''), 1500),
        latency_ms: Date.now() - startedAt,
      }));
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `HTTP ${response.status}: ${this.truncate(String(errorBody || ''), 900)}`,
      });
      throw new BadGatewayException(`OpenRouter video task query failed (${response.status}): ${errorBody || response.statusText}`);
    }
    return this.buildSuccessfulForwardedResponse(route, payload, context, startedAt, response);
  }

  private async forwardOpenRouterJsonRequest(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const endpointUrl = this.joinUrl(route.source.base_url, route.endpoint_path || this.defaultOpenRouterEndpoint(route.capability));
    const response = await this.aiUpstreamClient.fetch(route, endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: JSON.stringify(payload),
    }, {
      timeoutMs: this.resolveDirectUpstreamTimeoutMs(route),
    });
    if (!response.ok) {
      const errorBody = await this.aiUpstreamClient.readText(response);
      this.logger.warn(JSON.stringify({
        event: 'openrouter_upstream_error',
        status: response.status,
        model_key: route.model_key,
        upstream_model: route.upstream_model,
        capability: route.capability,
        api_type: route.api_type,
        source_id: route.source.id,
        source_name: route.source.name,
        outbound_proxy_id: route.source.outbound_proxy_id || null,
        endpoint_path: route.endpoint_path || this.defaultOpenRouterEndpoint(route.capability),
        endpoint_host: this.safeUrlHost(endpointUrl),
        request_path: context.request_path || null,
        request_summary: this.summarizeOpenRouterPayloadForLog(payload),
        upstream_error: this.truncate(String(errorBody || response.statusText || ''), 1500),
        latency_ms: Date.now() - startedAt,
      }));
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `HTTP ${response.status}: ${this.truncate(String(errorBody || ''), 900)}`,
      });
      throw new BadGatewayException(`OpenRouter upstream error (${response.status}): ${errorBody || response.statusText}`);
    }
    return this.buildSuccessfulForwardedResponse(route, payload, context, startedAt, response);
  }

  private summarizeOpenRouterPayloadForLog(payload: Record<string, unknown>): Record<string, unknown> {
    const inputAudio = this.normalizeObject(payload.input_audio);
    const audioData = this.stringOrUndefined(inputAudio.data);
    const provider = this.normalizeObject(payload.provider);
    return {
      model: this.stringOrUndefined(payload.model) || null,
      language: this.stringOrUndefined(payload.language) || null,
      response_format: this.stringOrUndefined(payload.response_format) || null,
      format: this.stringOrUndefined(payload.format) || null,
      temperature: this.numberOrNull(payload.temperature),
      has_provider: Object.keys(provider).length > 0,
      input_audio: Object.keys(inputAudio).length > 0
        ? {
          format: this.stringOrUndefined(inputAudio.format) || null,
          data_bytes_estimate: audioData ? Math.floor(audioData.replace(/\s+/g, '').length * 3 / 4) : null,
          data_base64_chars: audioData ? audioData.replace(/\s+/g, '').length : 0,
        }
        : null,
    };
  }

  private safeUrlHost(value: string): string {
    try {
      return new URL(value).host;
    } catch {
      return '';
    }
  }

  private async resolveOpenRouterInputAudio(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Promise<{ data: string; format: string }> {
    const inputAudio = this.normalizeObject(payload.input_audio);
    const directData = this.stringOrUndefined(inputAudio.data);
    if (directData) {
      return {
        data: directData.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, ''),
        format: this.stringOrUndefined(inputAudio.format) || this.stringOrUndefined(payload.format) || 'wav',
      };
    }

    const multipart = this.extractMultipartInstruction(payload);
    const candidates = [
      this.stringOrUndefined(multipart?.file_base64),
      this.stringOrUndefined(payload.file_base64),
      this.stringOrUndefined(payload.audio_base64),
      this.stringOrUndefined(payload.audio),
      this.stringOrUndefined(payload.file),
    ].filter((item): item is string => !!item);

    for (const candidate of candidates) {
      if (/^https?:\/\//i.test(candidate)) {
        return this.resolveOpenRouterInputAudioFromUrl(route, payload, candidate);
      }
      const parsed = this.parseDataUrl(candidate);
      const raw = (parsed ? parsed.base64 : candidate).replace(/\s+/g, '');
      if (!this.isLikelyBase64(raw)) {
        continue;
      }
      return {
        data: raw,
        format: this.resolveOpenRouterAudioFormat(payload, parsed?.mimeType),
      };
    }

    const audioUrl = this.extractDashscopeAudioUrl(payload);
    if (audioUrl) {
      return this.resolveOpenRouterInputAudioFromUrl(route, payload, audioUrl);
    }
    throw new BadRequestException('input_audio.data or base64 audio is required');
  }

  private async resolveOpenRouterInputAudioFromUrl(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    audioUrl: string,
  ): Promise<{ data: string; format: string }> {
    const downloaded = await this.downloadAudioFromUrl(
      audioUrl,
      route.source.api_key,
      route.source.custom_headers,
      route.source.outbound_proxy_id,
    );
    if (!downloaded) {
      throw new BadGatewayException('OpenRouter STT audio URL could not be downloaded');
    }
    if (downloaded.buffer.length > this.openRouterSttMaxAudioBytes) {
      throw new BadRequestException(`OpenRouter STT audio is too large (${downloaded.buffer.length} bytes)`);
    }
    const format = this.resolveOpenRouterAudioFormat(payload, downloaded.mimeType);
    return {
      data: downloaded.buffer.toString('base64'),
      format,
    };
  }

  private resolveOpenRouterAudioFormat(payload: Record<string, unknown>, mimeType?: string | null): string {
    const explicit = this.stringOrUndefined(payload.format)
      || this.stringOrUndefined(payload.audio_format)
      || this.stringOrUndefined(payload.file_format);
    if (explicit) {
      return explicit.replace(/^\./, '').toLowerCase();
    }
    const mime = String(mimeType || this.stringOrUndefined(payload.file_mime_type) || '').toLowerCase();
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('flac')) return 'flac';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
    return 'wav';
  }

  private resolveOpenRouterPollingUrl(route: ResolvedAiRoute, payload: Record<string, unknown>, taskId: string): string {
    const pollingUrl = this.stringOrUndefined(payload.polling_url ?? payload.pollingUrl);
    if (pollingUrl) {
      const parsed = new URL(pollingUrl);
      if (!parsed.hostname.endsWith('openrouter.ai')) {
        throw new BadRequestException('invalid OpenRouter polling_url');
      }
      return parsed.toString();
    }
    return this.joinUrl(route.source.base_url, `/videos/${encodeURIComponent(taskId)}`);
  }

  private defaultOpenRouterEndpoint(capability: AiCapability): string {
    if (capability === 'embedding') return '/embeddings';
    if (capability === 'tts') return '/audio/speech';
    if (capability === 'stt') return '/audio/transcriptions';
    if (capability === 'video') return '/videos';
    return '/chat/completions';
  }

  private resolveAiSdkBaseUrl(route: ResolvedAiRoute): string {
    const baseUrl = String(route.source.base_url || '').trim();
    if (!baseUrl) {
      return baseUrl;
    }

    if (!this.isDashscopeSource(route.source.provider_type, route.source.base_url)) {
      return baseUrl;
    }

    const normalized = baseUrl.replace(/\/+$/, '');
    if (/\/compatible-mode\/v1$/i.test(normalized)) {
      return normalized;
    }
    if (/\/compatible-mode$/i.test(normalized)) {
      return `${normalized}/v1`;
    }
    if (/\/api\/v1$/i.test(normalized)) {
      return normalized.replace(/\/api\/v1$/i, '/compatible-mode/v1');
    }
    return `${normalized}/compatible-mode/v1`;
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

  private createAnthropicClient(route: ResolvedAiRoute): Anthropic {
    const baseURL = this.normalizeAnthropicBaseUrl(route.source.base_url);
    const headers = this.normalizeHeaderObject(route.source.custom_headers);
    Object.keys(headers).forEach((key) => {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'authorization' || normalizedKey === 'x-api-key') {
        delete headers[key];
      }
    });
    const useBearerAuth = this.shouldUseAnthropicBearerAuth(route.source.provider_type, baseURL);
    return new Anthropic({
      baseURL,
      ...(useBearerAuth ? { authToken: route.source.api_key } : { apiKey: route.source.api_key }),
      ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
      fetch: this.buildRouteFetch(route),
      maxRetries: 0,
    });
  }

  private createGoogleGenAiClient(route: ResolvedAiRoute): GoogleGenAI {
    const httpOptions = this.resolveGoogleGenAiHttpOptions(route);
    if (this.isVertexAiSource(route.source.provider_type, route.source.base_url)) {
      const credentials = this.normalizeObject(route.source.credentials);
      const authMode = String(credentials.auth_mode || 'api_key');
      if (authMode === 'api_key') {
        return new GoogleGenAI({
          vertexai: true,
          apiKey: route.source.api_key,
          project: String(credentials.project_id || ''),
          location: String(credentials.location || 'global'),
          ...(httpOptions ? { httpOptions } : {}),
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
        ...(httpOptions ? { httpOptions } : {}),
      });
    }
    return new GoogleGenAI({
      apiKey: route.source.api_key,
      ...(httpOptions ? { httpOptions } : {}),
    });
  }

  private resolveGoogleGenAiHttpOptions(route: ResolvedAiRoute): {
    baseUrl?: string;
    apiVersion?: string;
    headers?: Record<string, string>;
  } | undefined {
    const resolvedBase = this.resolveGoogleGenAiBase(route.source.base_url);
    const headers = this.normalizeHeaderObject(route.source.custom_headers);
    const output: Record<string, unknown> = {};
    if (resolvedBase.baseUrl) {
      output.baseUrl = resolvedBase.baseUrl;
    }
    if (resolvedBase.apiVersion) {
      output.apiVersion = resolvedBase.apiVersion;
    }
    if (Object.keys(headers).length > 0) {
      output.headers = headers;
    }
    return Object.keys(output).length > 0 ? output as any : undefined;
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

  private async forwardGoogleGenAiChat(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const client = this.createGoogleGenAiClient(route);
    const request = await this.buildGoogleGenerateContentRequest(payload);
    const isStream = payload.stream === true || payload.stream === 'true';

    if (isStream) {
      const streamResult = await client.models.generateContentStream({
        model: route.upstream_model,
        contents: request.contents,
        config: request.config,
      });
      const encoder = new TextEncoder();
      const created = Math.floor(Date.now() / 1000);
      const streamId = `chatcmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const includeUsage =
        this.normalizeObject(payload.stream_options).include_usage === true
        || this.normalizeObject(payload.stream_options).include_usage === 'true';
      let responseId: string | null = null;
      let usage: AiUsageMetrics = {};

      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const writeChunk = (chunk: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          try {
            writeChunk({
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: route.upstream_model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            });

            for await (const chunk of streamResult) {
              if (chunk.responseId) {
                responseId = chunk.responseId;
              }
              usage = this.extractGoogleGenerateContentUsage(chunk, usage);
              const deltaText = String(chunk.text || '');
              if (!deltaText) {
                continue;
              }
              writeChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model: route.upstream_model,
                choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }],
              });
            }

            const finalChunk: Record<string, unknown> = {
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: route.upstream_model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            if (includeUsage) {
              finalChunk.usage = this.toOpenAiUsageObject(usage);
            }
            writeChunk(finalChunk);
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();

            this.logUsageSafe(route, payload, context, {
              success: true,
              is_stream: true,
              usage,
              request_id: responseId,
              latency_ms: Date.now() - startedAt,
            });
          } catch (error: any) {
            this.logUsageSafe(route, payload, context, {
              success: false,
              is_stream: true,
              usage: {},
              latency_ms: Date.now() - startedAt,
              error_message: this.truncate(this.resolveGoogleGenAiErrorMessage(error), 900),
            });
            controller.error(error);
          }
        },
      });

      return {
        stream: true,
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
        body,
      };
    }

    try {
      const response = await client.models.generateContent({
        model: route.upstream_model,
        contents: request.contents,
        config: request.config,
      });
      const usage = this.extractGoogleGenerateContentUsage(response);
      const data: Record<string, unknown> = {
        id: response.responseId || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: route.upstream_model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: response.text || '' },
            finish_reason: 'stop',
          },
        ],
        usage: this.toOpenAiUsageObject(usage),
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: response.responseId || null,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data,
      };
    } catch (error: any) {
      const message = this.resolveGoogleGenAiErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`Google GenAI chat failed: ${message}`);
    }
  }

  private async forwardGoogleGenAiEmbedding(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const client = this.createGoogleGenAiClient(route);
    const rawInput = payload.input;
    const values = (Array.isArray(rawInput) ? rawInput : [rawInput ?? payload.text ?? payload.prompt])
      .map((item) => this.normalizePromptToText(item))
      .filter((item) => !!item);
    if (values.length === 0) {
      throw new BadRequestException('input is required');
    }

    try {
      const response = await client.models.embedContent({
        model: route.upstream_model,
        contents: values,
      });
      const embeddings = (response.embeddings || []).map((item) => item.values || []);
      const data: Record<string, unknown> = {
        object: 'list',
        data: embeddings.map((embedding, index) => ({
          object: 'embedding',
          embedding,
          index,
        })),
        model: route.upstream_model,
        usage: this.toOpenAiUsageObject({}),
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data,
      };
    } catch (error: any) {
      const message = this.resolveGoogleGenAiErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`Google GenAI embeddings failed: ${message}`);
    }
  }

  private async forwardGoogleGenAiImage(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const client = this.createGoogleGenAiClient(route);
    const prompt = this.stringOrUndefined(payload.prompt) || this.normalizePromptToText(payload.input);
    if (!prompt) {
      throw new BadRequestException('image prompt is required');
    }
    const request = await this.buildGoogleImageRequest(prompt, payload);
    const responseFormat = this.stringOrUndefined(payload.response_format) || 'url';

    try {
      const response = await client.models.generateContent({
        model: route.upstream_model,
        contents: request.contents,
        config: request.config,
      });
      const outputImages = this.extractGoogleImageParts(response);
      if (outputImages.length === 0) {
        throw new BadGatewayException(`Google GenAI image generation returned no image output. text=${response.text || ''}`);
      }

      const usage = this.extractGoogleGenerateContentUsage(response);
      usage.image_count = outputImages.length;
      const imageData: Array<Record<string, unknown>> = [];
      for (let i = 0; i < outputImages.length; i += 1) {
        const image = outputImages[i];
        if (responseFormat === 'b64_json') {
          imageData.push({ b64_json: image.base64 });
          continue;
        }
        const url = await this.uploadAiSdkOutputAndResolveUrl(route, context, image, `google-image-${i + 1}`);
        imageData.push({ url });
      }

      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: response.responseId || null,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data: {
          created: Math.floor(Date.now() / 1000),
          data: imageData,
        },
      };
    } catch (error: any) {
      const message = this.resolveGoogleGenAiErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`Google GenAI image generation failed: ${message}`);
    }
  }

  private async forwardGoogleGenAiTts(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    if (route.capability !== 'tts') {
      throw new BadRequestException(`Google GenAI TTS route requires capability=tts, current=${route.capability}`);
    }

    const requestPayload: Record<string, unknown> = {
      ...route.request_overrides,
      ...payload,
      model: route.upstream_model,
    };
    const text = this.resolveGoogleTtsContentText(requestPayload);
    if (!text) {
      throw new BadRequestException('text is required');
    }
    if (Buffer.byteLength(text, 'utf8') > 8000) {
      throw new BadRequestException('Google GenAI TTS contents must be 8000 bytes or less');
    }
    if (requestPayload.stream === true || requestPayload.stream === 'true') {
      throw new BadRequestException('Google GenAI TTS streaming is not supported by this endpoint');
    }

    const outputFormat = this.resolveGoogleTtsOutputFormat(requestPayload);
    const responseFormat = this.resolveGoogleTtsResponseFormat(requestPayload);
    const sampleRate = this.resolveGoogleTtsSampleRate(requestPayload);
    const channels = this.resolveGoogleTtsChannels(requestPayload);
    const temperature = this.numberOrNull(requestPayload.temperature);
    const speakers = this.resolveGoogleTtsSpeakers(requestPayload);
    const primaryVoice = this.resolveGoogleTtsPrimaryVoice(requestPayload);
    if (speakers.length === 0 && !this.isGeminiTtsVoiceName(primaryVoice)) {
      throw new BadRequestException(`Gemini TTS voice is not supported: ${primaryVoice}`);
    }
    const speechConfig = this.buildGoogleTtsSpeechConfig(requestPayload);
    for (const speaker of speakers) {
      const voiceConfig = this.normalizeObject(speaker.voiceConfig);
      const prebuilt = this.normalizeObject(voiceConfig.prebuiltVoiceConfig);
      const voiceName = this.stringOrUndefined(prebuilt.voiceName);
      if (voiceName && !this.isGeminiTtsVoiceName(voiceName)) {
        throw new BadRequestException(`Gemini TTS voice is not supported: ${voiceName}`);
      }
    }
    const config: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      speechConfig,
    };
    if (temperature !== null) {
      if (temperature <= 0 || temperature > 2) {
        throw new BadRequestException('temperature must be greater than 0 and less than or equal to 2');
      }
      config.temperature = temperature;
    }

    await this.assertSufficientPointsBeforeInvoke(route, requestPayload, context);

    const startedAt = Date.now();
    const client = this.createGoogleGenAiClient(route);
    try {
      const response = await this.outboundHttp.runWithProxy(route.source.outbound_proxy_id, () => client.models.generateContent({
        model: route.upstream_model,
        contents: [{ role: 'user', parts: [{ text }] }],
        config,
      } as any));
      const audio = this.extractGoogleAudioParts(response)[0];
      if (!audio) {
        throw new BadGatewayException(`Google GenAI TTS returned no audio output. text=${response.text || ''}`);
      }

      const pcmBuffer = Buffer.from(audio.uint8Array);
      const outputBuffer = outputFormat === 'wav' && !this.isWavMimeType(audio.mediaType)
        ? this.wrapPcm16AsWav(pcmBuffer, sampleRate, channels)
        : pcmBuffer;
      const mimeType = outputFormat === 'wav'
        ? 'audio/wav'
        : (this.stringOrUndefined(audio.mediaType) || this.contentTypeByAudioFormat(outputFormat));
      const outputBase64 = outputBuffer.toString('base64');
      const durationSeconds = this.resolvePcmDurationSeconds(pcmBuffer, sampleRate, channels, 2);
      const usage = this.extractGoogleGenerateContentUsage(response, { duration_seconds: durationSeconds });

      this.logUsageSafe(route, requestPayload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: response.responseId || null,
        latency_ms: Date.now() - startedAt,
      });

      if (responseFormat === 'binary') {
        return {
          stream: false,
          binary: true,
          status: 200,
          headers: {
            'content-type': mimeType,
            'content-disposition': `inline; filename="google-tts.${outputFormat}"`,
          },
          body: outputBuffer,
        };
      }

      const provider = this.isVertexAiSource(route.source.provider_type, route.source.base_url) ? 'vertex' : 'google';
      const data: Record<string, unknown> = {
        id: response.responseId || `google_tts_${Date.now().toString(36)}`,
        object: 'google.genai.tts.speech',
        created: Math.floor(Date.now() / 1000),
        provider,
        model: route.upstream_model,
        voice: this.resolveGoogleTtsPrimaryVoice(requestPayload),
        language_code: this.resolveGoogleTtsLanguageCode(requestPayload),
        format: outputFormat,
        mime_type: mimeType,
        usage: {
          text_chars: text.length,
          duration_seconds: durationSeconds,
          ...this.toOpenAiUsageObject(usage),
        },
      };

      if (responseFormat === 'b64_json') {
        data.audio_base64 = outputBase64;
        data.b64_json = outputBase64;
        return { stream: false, data };
      }

      const url = await this.uploadAiSdkOutputAndResolveUrl(route, context, {
        mediaType: mimeType,
        uint8Array: outputBuffer,
        base64: outputBase64,
      }, 'google-tts');
      data.url = url;
      data.audio_url = url;
      return { stream: false, data };
    } catch (error: any) {
      const message = this.resolveGoogleGenAiErrorMessage(error);
      this.logUsageSafe(route, requestPayload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      if (error instanceof BadGatewayException || error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new BadGatewayException(`Google GenAI TTS failed: ${message}`);
    }
  }

  private async forwardAnthropicChat(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const client = this.createAnthropicClient(route);
    const request = await this.buildAnthropicMessageRequest(payload);
    const isStream = this.isStreamingRequest(payload);

    if (isStream) {
      const stream = client.messages.stream({
        model: route.upstream_model,
        ...request,
      } as any);
      const encoder = new TextEncoder();
      const created = Math.floor(Date.now() / 1000);
      const streamId = `chatcmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const includeUsage =
        this.normalizeObject(payload.stream_options).include_usage === true
        || this.normalizeObject(payload.stream_options).include_usage === 'true';

      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const writeChunk = (chunk: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          try {
            writeChunk({
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: route.upstream_model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            });

            stream.on('text', (deltaText) => {
              if (!deltaText) {
                return;
              }
              writeChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model: route.upstream_model,
                choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }],
              });
            });

            const finalMessage = await stream.finalMessage();
            const usage = this.extractAnthropicUsage(finalMessage.usage);
            const finalChunk: Record<string, unknown> = {
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: route.upstream_model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: this.mapAnthropicStopReasonToOpenAi(finalMessage.stop_reason),
              }],
            };
            if (includeUsage) {
              finalChunk.usage = this.toOpenAiUsageObject(usage);
            }
            writeChunk(finalChunk);
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();

            this.logUsageSafe(route, payload, context, {
              success: true,
              is_stream: true,
              usage,
              request_id: finalMessage.id,
              latency_ms: Date.now() - startedAt,
            });
          } catch (error: any) {
            const message = this.resolveAiSdkErrorMessage(error);
            this.logUsageSafe(route, payload, context, {
              success: false,
              is_stream: true,
              usage: {},
              latency_ms: Date.now() - startedAt,
              error_message: this.truncate(message, 900),
            });
            controller.error(new BadGatewayException(`Anthropic chat failed: ${message}`));
          }
        },
      });

      return {
        stream: true,
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
        body,
      };
    }

    try {
      const result = await client.messages.create({
        model: route.upstream_model,
        ...request,
      } as any);
      const usage = this.extractAnthropicUsage(result.usage);
      const data: Record<string, unknown> = {
        id: result.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: route.upstream_model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: this.extractAnthropicTextContent(result.content) },
            finish_reason: this.mapAnthropicStopReasonToOpenAi(result.stop_reason),
          },
        ],
        usage: this.toOpenAiUsageObject(usage),
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: result.id || null,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data,
      };
    } catch (error: any) {
      const message = this.resolveAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`Anthropic chat failed: ${message}`);
    }
  }

  private async buildAnthropicMessageRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
    const systemParts: string[] = [];

    if (messages.length === 0) {
      const prompt = this.normalizePromptToText(payload.input) || this.stringOrUndefined(payload.prompt);
      if (!prompt) {
        throw new BadRequestException('messages or input is required');
      }
      anthropicMessages.push({
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      });
    } else {
      for (const rawMessage of messages) {
        if (!rawMessage || typeof rawMessage !== 'object') {
          continue;
        }
        const message = rawMessage as Record<string, unknown>;
        const roleRaw = this.stringOrUndefined(message.role) || 'user';
        if (
          roleRaw === 'tool'
          || message.tool_call_id !== undefined
          || message.tool_calls !== undefined
          || message.function_call !== undefined
        ) {
          throw new BadRequestException('Anthropic 源暂不支持 OpenAI tools / tool messages');
        }
        if (roleRaw === 'system') {
          const systemText = this.normalizePromptToText(message.content);
          if (systemText) {
            systemParts.push(systemText);
          }
          continue;
        }

        const role: 'user' | 'assistant' = roleRaw === 'assistant' ? 'assistant' : 'user';
        const content = await this.normalizeAnthropicMessageContent(message.content);
        if (content.length === 0) {
          continue;
        }

        const lastMessage = anthropicMessages[anthropicMessages.length - 1];
        if (lastMessage && lastMessage.role === role) {
          lastMessage.content.push(...content);
          continue;
        }
        anthropicMessages.push({ role, content });
      }
    }

    if (anthropicMessages.length === 0) {
      throw new BadRequestException('messages is required');
    }

    const request: Record<string, unknown> = {
      messages: anthropicMessages,
      max_tokens: 1024,
    };
    if (systemParts.length > 0) {
      request.system = systemParts.join('\n\n');
    }

    const temperature = Number(payload.temperature);
    if (Number.isFinite(temperature)) {
      request.temperature = temperature;
    }
    const topP = Number(payload.top_p);
    if (Number.isFinite(topP)) {
      request.top_p = topP;
    }
    const topK = Number(payload.top_k);
    if (Number.isFinite(topK)) {
      request.top_k = Math.round(topK);
    }
    const maxTokens = Number(payload.max_tokens ?? payload.max_output_tokens);
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      request.max_tokens = Math.round(maxTokens);
    }
    const stop = payload.stop;
    if (typeof stop === 'string' && stop.trim()) {
      request.stop_sequences = [stop.trim()];
    } else if (Array.isArray(stop)) {
      const stopSequences = stop
        .map((item) => this.stringOrUndefined(item))
        .filter((item): item is string => !!item);
      if (stopSequences.length > 0) {
        request.stop_sequences = stopSequences;
      }
    }
    return request;
  }

  private async normalizeAnthropicMessageContent(content: unknown): Promise<Array<Record<string, unknown>>> {
    if (typeof content === 'string') {
      const text = content.trim();
      return text ? [{ type: 'text', text }] : [];
    }
    if (!Array.isArray(content)) {
      const text = this.normalizePromptToText(content);
      return text ? [{ type: 'text', text }] : [];
    }

    const blocks: Array<Record<string, unknown>> = [];
    for (const rawPart of content) {
      if (!rawPart || typeof rawPart !== 'object') {
        const text = this.normalizePromptToText(rawPart);
        if (text) {
          blocks.push({ type: 'text', text });
        }
        continue;
      }
      const part = rawPart as Record<string, unknown>;
      const type = this.stringOrUndefined(part.type);
      if (type === 'text' || type === 'input_text' || type === 'output_text') {
        const text = this.stringOrUndefined(part.text);
        if (text) {
          blocks.push({ type: 'text', text });
        }
        continue;
      }
      if (type === 'image_url' || type === 'input_image') {
        const imageUrl = this.resolveOpenAiImagePartUrl(part.image_url ?? part.image ?? part.url);
        if (!imageUrl) {
          continue;
        }
        const parsed = this.parseDataUrl(imageUrl);
        if (parsed && this.isSupportedAnthropicImageMimeType(parsed.mimeType)) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mimeType,
              data: parsed.base64,
            },
          });
          continue;
        }
        if (parsed) {
          throw new BadRequestException('Anthropic 图片输入仅支持 JPEG、PNG、GIF、WEBP');
        }
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: imageUrl,
          },
        });
        continue;
      }
      const text = this.normalizePromptToText(part);
      if (text) {
        blocks.push({ type: 'text', text });
      }
    }
    return blocks;
  }

  private isSupportedAnthropicImageMimeType(mimeType?: string): boolean {
    const normalized = String(mimeType || '').trim().toLowerCase();
    return normalized === 'image/jpeg'
      || normalized === 'image/png'
      || normalized === 'image/gif'
      || normalized === 'image/webp';
  }

  private extractAnthropicTextContent(content: unknown): string {
    const blocks = Array.isArray(content) ? content : [];
    return blocks
      .filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text')
      .map((item) => this.stringOrUndefined((item as Record<string, unknown>).text))
      .filter((item): item is string => !!item)
      .join('\n')
      .trim();
  }

  private extractAnthropicUsage(usage: any): AiUsageMetrics {
    const promptTokens =
      this.pickNumber(usage?.input_tokens, usage?.inputTokens)
      ?? ((this.pickNumber(usage?.cache_creation_input_tokens) || 0) + (this.pickNumber(usage?.cache_read_input_tokens) || 0) > 0
        ? (this.pickNumber(usage?.cache_creation_input_tokens) || 0) + (this.pickNumber(usage?.cache_read_input_tokens) || 0)
        : null);
    const completionTokens = this.pickNumber(usage?.output_tokens, usage?.outputTokens);
    const totalTokens =
      promptTokens !== null || completionTokens !== null
        ? (promptTokens || 0) + (completionTokens || 0)
        : null;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }

  private mapAnthropicStopReasonToOpenAi(value?: string | null): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === 'end_turn' || normalized === 'stop_sequence') {
      return 'stop';
    }
    if (normalized === 'max_tokens') {
      return 'length';
    }
    if (normalized === 'tool_use') {
      return 'tool_calls';
    }
    if (normalized === 'refusal') {
      return 'content_filter';
    }
    return 'stop';
  }

  private async buildGoogleGenerateContentRequest(payload: Record<string, unknown>): Promise<{
    contents: Array<{ role: 'user' | 'model'; parts: Part[] }>;
    config: Record<string, unknown>;
  }> {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (messages.length === 0) {
      const prompt = this.normalizePromptToText(payload.input) || this.stringOrUndefined(payload.prompt);
      if (!prompt) {
        throw new BadRequestException('messages or input is required');
      }
      const config = this.buildGoogleChatConfig(payload);
      return {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config,
      };
    }

    const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
    const systemParts: Part[] = [];
    for (const rawMessage of messages) {
      if (!rawMessage || typeof rawMessage !== 'object') {
        continue;
      }
      const message = rawMessage as Record<string, unknown>;
      const roleRaw = this.stringOrUndefined(message.role) || 'user';
      const parts = await this.normalizeGooglePartsFromMessageContent(message.content);
      if (parts.length === 0) {
        continue;
      }
      if (roleRaw === 'system') {
        systemParts.push(...parts);
        continue;
      }
      const role: 'user' | 'model' = roleRaw === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts });
    }
    if (contents.length === 0) {
      throw new BadRequestException('messages is required');
    }

    const config = this.buildGoogleChatConfig(payload);
    if (systemParts.length > 0) {
      config.systemInstruction = { role: 'user', parts: systemParts };
    }

    return { contents, config };
  }

  private buildGoogleChatConfig(payload: Record<string, unknown>): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    const temperature = Number(payload.temperature);
    if (Number.isFinite(temperature)) {
      config.temperature = temperature;
    }
    const topP = Number(payload.top_p);
    if (Number.isFinite(topP)) {
      config.topP = topP;
    }
    const topK = Number(payload.top_k);
    if (Number.isFinite(topK)) {
      config.topK = Math.round(topK);
    }
    const maxTokens = Number(payload.max_tokens ?? payload.max_output_tokens);
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      config.maxOutputTokens = Math.round(maxTokens);
    }
    const presencePenalty = Number(payload.presence_penalty);
    if (Number.isFinite(presencePenalty)) {
      config.presencePenalty = presencePenalty;
    }
    const frequencyPenalty = Number(payload.frequency_penalty);
    if (Number.isFinite(frequencyPenalty)) {
      config.frequencyPenalty = frequencyPenalty;
    }
    const stop = payload.stop;
    if (typeof stop === 'string' && stop.trim()) {
      config.stopSequences = [stop.trim()];
    } else if (Array.isArray(stop)) {
      const values = stop.map((item) => this.stringOrUndefined(item)).filter((item): item is string => !!item);
      if (values.length > 0) {
        config.stopSequences = values;
      }
    }
    return config;
  }

  private async buildGoogleImageRequest(
    prompt: string,
    payload: Record<string, unknown>,
  ): Promise<{
    contents: Part[];
    config: Record<string, unknown>;
  }> {
    const nRaw = this.pickNumber(payload.n);
    const candidateCount = nRaw && nRaw > 0 ? Math.min(Math.max(nRaw, 1), 4) : 1;
    const imageParts = await this.collectGoogleImageInputParts(payload);
    const imageConfig = this.resolveGoogleImageConfig(payload);
    const config: Record<string, unknown> = {
      responseModalities: [Modality.IMAGE],
      imageConfig,
    };
    if (candidateCount > 1) {
      config.candidateCount = candidateCount;
    }
    return {
      contents: [...imageParts, { text: prompt }],
      config,
    };
  }

  private resolveGoogleImageConfig(payload: Record<string, unknown>): Record<string, unknown> {
    const explicitAspect = this.stringOrUndefined(payload.aspect_ratio) || this.stringOrUndefined(payload.aspectRatio);
    const explicitSize = this.stringOrUndefined(payload.image_size) || this.stringOrUndefined(payload.imageSize);
    const fromOpenAiSize = this.mapOpenAiSizeToGoogleImageConfig(this.stringOrUndefined(payload.size));
    return {
      aspectRatio: explicitAspect || fromOpenAiSize.aspectRatio || '1:1',
      imageSize: explicitSize || fromOpenAiSize.imageSize || '1K',
    };
  }

  private mapOpenAiSizeToGoogleImageConfig(sizeRaw?: string): { aspectRatio?: string; imageSize?: string } {
    const size = String(sizeRaw || '').trim();
    if (!size) {
      return {};
    }
    const matched = size.match(/^(\d{2,5})[xX](\d{2,5})$/);
    if (!matched) {
      return {};
    }
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return {};
    }
    const supportedRatios = [
      { label: '1:1', value: 1 },
      { label: '2:3', value: 2 / 3 },
      { label: '3:2', value: 3 / 2 },
      { label: '3:4', value: 3 / 4 },
      { label: '4:3', value: 4 / 3 },
      { label: '4:5', value: 4 / 5 },
      { label: '5:4', value: 5 / 4 },
      { label: '9:16', value: 9 / 16 },
      { label: '16:9', value: 16 / 9 },
      { label: '21:9', value: 21 / 9 },
    ];
    const ratio = width / height;
    const closest = supportedRatios.reduce((best, current) => {
      if (!best) {
        return current;
      }
      return Math.abs(current.value - ratio) < Math.abs(best.value - ratio) ? current : best;
    }, supportedRatios[0]);

    const maxEdge = Math.max(width, height);
    let imageSize = '1K';
    if (maxEdge >= 3400 || width * height >= 12_000_000) {
      imageSize = '4K';
    } else if (maxEdge >= 1700 || width * height >= 3_600_000) {
      imageSize = '2K';
    }

    return {
      aspectRatio: closest.label,
      imageSize,
    };
  }

  private async normalizeGooglePartsFromMessageContent(content: unknown): Promise<Part[]> {
    if (typeof content === 'string') {
      const text = content.trim();
      return text ? [{ text }] : [];
    }
    if (!Array.isArray(content)) {
      const text = this.normalizePromptToText(content);
      return text ? [{ text }] : [];
    }

    const parts: Part[] = [];
    for (const rawPart of content) {
      if (!rawPart || typeof rawPart !== 'object') {
        const text = this.normalizePromptToText(rawPart);
        if (text) {
          parts.push({ text });
        }
        continue;
      }
      const part = rawPart as Record<string, unknown>;
      const type = this.stringOrUndefined(part.type);
      if (type === 'text' || type === 'input_text' || type === 'output_text') {
        const text = this.stringOrUndefined(part.text);
        if (text) {
          parts.push({ text });
        }
        continue;
      }
      if (type === 'image_url' || type === 'input_image') {
        const imageUrl = this.resolveOpenAiImagePartUrl(part.image_url ?? part.image ?? part.url);
        if (imageUrl) {
          parts.push(await this.convertImageValueToGooglePart(imageUrl));
        }
        continue;
      }
      const text = this.normalizePromptToText(part);
      if (text) {
        parts.push({ text });
      }
    }
    return parts;
  }

  private async collectGoogleImageInputParts(payload: Record<string, unknown>): Promise<Part[]> {
    const values: string[] = [];
    const pushCandidate = (raw: unknown) => {
      const normalized = this.normalizeGoogleImageInput(raw);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    };

    ['image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url', 'mask']
      .forEach((key) => pushCandidate(payload[key]));

    const images = Array.isArray(payload.images) ? payload.images : [];
    images.forEach((item) => {
      if (typeof item === 'string') {
        pushCandidate(item);
        return;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        pushCandidate(record.image);
        pushCandidate(record.url);
        pushCandidate(record.b64_json);
      }
    });

    const multipart = this.extractMultipartInstruction(payload);
    if (multipart) {
      pushCandidate(this.stringOrUndefined(multipart.file_base64));
    }

    const parts: Part[] = [];
    for (const value of values) {
      parts.push(await this.convertImageValueToGooglePart(value));
    }
    return parts;
  }

  private normalizeGoogleImageInput(raw: unknown): string | null {
    const text = this.resolveOpenAiImagePartUrl(raw);
    if (text) {
      return text;
    }
    const dataUrl = this.parseDataUrl(this.stringOrUndefined(raw) || '');
    if (dataUrl) {
      return `data:${dataUrl.mimeType};base64,${dataUrl.base64}`;
    }
    const rawText = this.stringOrUndefined(raw);
    if (!rawText) {
      return null;
    }
    const normalizedBase64 = rawText.replace(/\s+/g, '');
    if (!this.isLikelyBase64(normalizedBase64)) {
      return null;
    }
    return `data:image/png;base64,${normalizedBase64}`;
  }

  private resolveOpenAiImagePartUrl(raw: unknown): string | null {
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text) {
        return null;
      }
      if (/^https?:\/\//i.test(text) || /^data:/i.test(text)) {
        return text;
      }
      return null;
    }
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const record = raw as Record<string, unknown>;
    return this.stringOrUndefined(record.url) || this.stringOrUndefined(record.image) || null;
  }

  private async convertImageValueToGooglePart(value: string): Promise<Part> {
    const parsed = this.parseDataUrl(value);
    if (parsed) {
      return {
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.base64,
        },
      };
    }

    const response = await fetch(value);
    if (!response.ok) {
      throw new BadGatewayException(`failed to fetch image input: ${response.status}`);
    }
    const mimeType = this.stringOrUndefined(response.headers.get('content-type')) || 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    };
  }

  private resolveGoogleTtsContentText(payload: Record<string, unknown>): string {
    const inputObject = this.normalizeObject(payload.input);
    const baseText =
      this.stringOrUndefined(payload.text)
      || this.stringOrUndefined(inputObject.text)
      || this.normalizePromptToText(payload.input)
      || this.stringOrUndefined(payload.content)
      || this.normalizePromptToText(payload.contents);
    const prompt =
      this.stringOrUndefined(payload.prompt)
      || this.stringOrUndefined(payload.style_prompt)
      || this.stringOrUndefined(payload.stylePrompt)
      || this.stringOrUndefined(inputObject.prompt)
      || this.stringOrUndefined(inputObject.style_prompt);

    if (prompt && baseText) {
      return `${prompt.trim()}\n\n${baseText.trim()}`.trim();
    }
    return (baseText || prompt || '').trim();
  }

  private resolveGoogleTtsOutputFormat(payload: Record<string, unknown>): 'wav' | 'pcm' {
    const raw = (
      this.stringOrUndefined(payload.output_format)
      || this.stringOrUndefined(payload.audio_format)
      || this.stringOrUndefined(payload.format)
      || this.pickGoogleTtsAudioFormat(this.stringOrUndefined(payload.response_format))
      || 'wav'
    ).toLowerCase();
    if (raw === 'wav' || raw === 'pcm') {
      return raw;
    }
    throw new BadRequestException('Google GenAI TTS output_format currently supports wav or pcm');
  }

  private resolveGoogleTtsResponseFormat(payload: Record<string, unknown>): 'url' | 'b64_json' | 'binary' {
    if (payload.return_audio_binary === true || payload.return_audio_binary === 'true') {
      return 'binary';
    }
    const raw = (
      this.stringOrUndefined(payload.response_format)
      || this.stringOrUndefined(payload.responseFormat)
      || 'url'
    ).toLowerCase();
    if (raw === 'binary' || raw === 'arraybuffer' || raw === 'audio') {
      return 'binary';
    }
    if (raw === 'b64_json' || raw === 'base64' || raw === 'json_base64') {
      return 'b64_json';
    }
    if (raw === 'url' || raw === 'json') {
      return 'url';
    }
    if (raw === 'wav' || raw === 'pcm') {
      return 'url';
    }
    throw new BadRequestException('response_format must be url, b64_json, or binary');
  }

  private pickGoogleTtsAudioFormat(value?: string): string | undefined {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'wav' || normalized === 'pcm' ? normalized : undefined;
  }

  private resolveGoogleTtsLanguageCode(payload: Record<string, unknown>): string {
    const inputObject = this.normalizeObject(payload.input);
    return this.stringOrUndefined(payload.language_code)
      || this.stringOrUndefined(payload.languageCode)
      || this.stringOrUndefined(payload.language)
      || this.stringOrUndefined(inputObject.language_code)
      || this.stringOrUndefined(inputObject.language)
      || 'en-US';
  }

  private resolveGoogleTtsPrimaryVoice(payload: Record<string, unknown>): string {
    const inputObject = this.normalizeObject(payload.input);
    const voiceSetting = this.normalizeObject(payload.voice_setting);
    return this.stringOrUndefined(payload.voice_name)
      || this.stringOrUndefined(payload.voiceName)
      || this.stringOrUndefined(payload.voice)
      || this.stringOrUndefined(payload.voice_id)
      || this.stringOrUndefined(inputObject.voice_name)
      || this.stringOrUndefined(inputObject.voice)
      || this.stringOrUndefined(voiceSetting.voice_name)
      || this.stringOrUndefined(voiceSetting.voice_id)
      || 'Kore';
  }

  private buildGoogleTtsSpeechConfig(payload: Record<string, unknown>): Record<string, unknown> {
    const speakers = this.resolveGoogleTtsSpeakers(payload);
    const config: Record<string, unknown> = {
      languageCode: this.resolveGoogleTtsLanguageCode(payload),
    };
    if (speakers.length > 0) {
      config.multiSpeakerVoiceConfig = {
        speakerVoiceConfigs: speakers,
      };
      return config;
    }
    config.voiceConfig = {
      prebuiltVoiceConfig: {
        voiceName: this.resolveGoogleTtsPrimaryVoice(payload),
      },
    };
    return config;
  }

  private resolveGoogleTtsSpeakers(payload: Record<string, unknown>): Array<Record<string, unknown>> {
    const rawSpeakers =
      payload.speakers
      ?? payload.speaker_voice_configs
      ?? payload.speakerVoiceConfigs
      ?? this.normalizeObject(payload.multi_speaker_voice_config).speaker_voice_configs
      ?? this.normalizeObject(payload.multiSpeakerVoiceConfig).speakerVoiceConfigs;
    if (!Array.isArray(rawSpeakers)) {
      return [];
    }
    if (rawSpeakers.length > 2) {
      throw new BadRequestException('Google GenAI multi-speaker TTS supports at most 2 speakers');
    }
    const resolved = rawSpeakers
      .map((item) => this.normalizeObject(item))
      .map((item) => {
        const speaker = this.stringOrUndefined(item.speaker)
          || this.stringOrUndefined(item.speaker_id)
          || this.stringOrUndefined(item.name);
        const voiceConfig = this.normalizeObject(item.voiceConfig || item.voice_config);
        const prebuilt = this.normalizeObject(voiceConfig.prebuiltVoiceConfig || voiceConfig.prebuilt_voice_config);
        const voiceName =
          this.stringOrUndefined(item.voice_name)
          || this.stringOrUndefined(item.voiceName)
          || this.stringOrUndefined(item.voice)
          || this.stringOrUndefined(item.voice_id)
          || this.stringOrUndefined(prebuilt.voiceName)
          || this.stringOrUndefined(prebuilt.voice_name);
        if (!speaker || !voiceName) {
          return null;
        }
        return {
          speaker,
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        };
      })
      .filter((item) => !!item);
    return resolved as Array<Record<string, unknown>>;
  }

  private resolveGoogleTtsSampleRate(payload: Record<string, unknown>): number {
    const sampleRate = this.numberOrNull(payload.sample_rate, payload.sampleRate);
    if (!sampleRate) {
      return 24000;
    }
    if (sampleRate < 8000 || sampleRate > 192000) {
      throw new BadRequestException('sample_rate must be between 8000 and 192000');
    }
    return Math.round(sampleRate);
  }

  private resolveGoogleTtsChannels(payload: Record<string, unknown>): number {
    const channels = this.numberOrNull(payload.channels, payload.channel_count, payload.channelCount);
    if (!channels) {
      return 1;
    }
    if (channels !== 1 && channels !== 2) {
      throw new BadRequestException('channels must be 1 or 2');
    }
    return channels;
  }

  private isWavMimeType(mimeType: string): boolean {
    return String(mimeType || '').toLowerCase().includes('wav');
  }

  private resolvePcmDurationSeconds(buffer: Buffer, sampleRate: number, channels: number, bytesPerSample: number): number | null {
    if (!buffer.length || sampleRate <= 0 || channels <= 0 || bytesPerSample <= 0) {
      return null;
    }
    const seconds = buffer.length / sampleRate / channels / bytesPerSample;
    return Number.isFinite(seconds) && seconds > 0 ? Number(seconds.toFixed(3)) : null;
  }

  private wrapPcm16AsWav(pcmBuffer: Buffer, sampleRate: number, channels: number): Buffer {
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([header, pcmBuffer]);
  }

  private extractGoogleGenerateContentUsage(
    response: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | null },
    fallback: AiUsageMetrics = {},
  ): AiUsageMetrics {
    const usage = response.usageMetadata;
    return {
      prompt_tokens: this.pickNumber(usage?.promptTokenCount) ?? fallback.prompt_tokens ?? null,
      completion_tokens: this.pickNumber(usage?.candidatesTokenCount) ?? fallback.completion_tokens ?? null,
      total_tokens: this.pickNumber(usage?.totalTokenCount) ?? fallback.total_tokens ?? null,
      image_count: fallback.image_count ?? null,
      duration_seconds: fallback.duration_seconds ?? null,
      request_id: fallback.request_id ?? null,
    };
  }

  private extractGoogleImageParts(response: {
    candidates?: Array<{ content?: { parts?: Part[] | null } | null }> | null;
  }): Array<{ mediaType: string; uint8Array: Uint8Array; base64: string }> {
    const output: Array<{ mediaType: string; uint8Array: Uint8Array; base64: string }> = [];
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content?.parts || [] : [];
      for (const part of parts) {
        const inlineData = part?.inlineData;
        const base64 = this.stringOrUndefined(inlineData?.data);
        if (!base64) {
          continue;
        }
        output.push({
          mediaType: this.stringOrUndefined(inlineData?.mimeType) || 'image/png',
          uint8Array: Buffer.from(base64, 'base64'),
          base64,
        });
      }
    }
    return output;
  }

  private extractGoogleAudioParts(response: {
    candidates?: Array<{ content?: { parts?: Part[] | null } | null }> | null;
  }): GoogleTtsAudioPart[] {
    const output: GoogleTtsAudioPart[] = [];
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content?.parts || [] : [];
      for (const part of parts) {
        const inlineData = part?.inlineData;
        const mediaType = this.stringOrUndefined(inlineData?.mimeType) || 'audio/pcm';
        if (mediaType && !mediaType.toLowerCase().startsWith('audio/')) {
          continue;
        }
        const rawData = (inlineData as any)?.data;
        if (typeof rawData === 'string' && rawData.trim()) {
          const base64 = rawData.trim();
          output.push({
            mediaType,
            uint8Array: Buffer.from(base64, 'base64'),
            base64,
          });
          continue;
        }
        if (rawData instanceof Uint8Array) {
          const buffer = Buffer.from(rawData);
          output.push({
            mediaType,
            uint8Array: buffer,
            base64: buffer.toString('base64'),
          });
        }
      }
    }
    return output;
  }

  private resolveGoogleGenAiErrorMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return this.resolveAiSdkErrorMessage(error);
    }
    const anyErr = error as Record<string, unknown>;
    if (anyErr.message && typeof anyErr.message === 'string' && anyErr.message.trim()) {
      return anyErr.message;
    }
    if (anyErr.statusText && typeof anyErr.statusText === 'string' && anyErr.statusText.trim()) {
      return anyErr.statusText;
    }
    return this.resolveAiSdkErrorMessage(error);
  }

  private normalizeHeaderObject(value: unknown): Record<string, string> {
    const record = this.normalizeObject(value);
    const output: Record<string, string> = {};
    Object.entries(record).forEach(([key, raw]) => {
      if (typeof raw === 'string' && raw.trim()) {
        output[key] = raw;
      }
    });
    return output;
  }

  private async forwardAiSdkChat(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    provider: ReturnType<typeof createOpenAI>,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const isStream = payload.stream === true || payload.stream === 'true';
    const requestInput: Record<string, unknown> = {
      model: provider.chat(route.upstream_model),
    };
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (messages.length > 0) {
      requestInput.messages = messages;
    } else {
      const promptText = this.normalizePromptToText(payload.prompt ?? payload.input);
      if (!promptText) {
        throw new BadRequestException('messages or prompt is required');
      }
      requestInput.prompt = promptText;
    }
    this.applyAiSdkChatSettings(requestInput, payload, route);

    if (isStream) {
      const streamResult = streamText(requestInput as any);
      const encoder = new TextEncoder();
      const created = Math.floor(Date.now() / 1000);
      const streamId = `chatcmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const includeUsage =
        this.normalizeObject(payload.stream_options).include_usage === true
        || this.normalizeObject(payload.stream_options).include_usage === 'true';
      const model = route.upstream_model;

      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const writeChunk = (chunk: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          try {
            writeChunk({
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            });

            for await (const deltaText of streamResult.textStream) {
              if (!deltaText) {
                continue;
              }
              writeChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }],
              });
            }

            const [usageRaw, responseMeta, finishReasonRaw] = await Promise.all([
              streamResult.usage,
              streamResult.response,
              streamResult.finishReason,
            ]);
            const usage = this.normalizeAiSdkLanguageUsage(usageRaw);
            const finishReason = this.mapAiSdkFinishReasonToOpenAi(finishReasonRaw as string | undefined);
            const finalChunk: Record<string, unknown> = {
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            };
            if (includeUsage) {
              finalChunk.usage = this.toOpenAiUsageObject(usage);
            }
            writeChunk(finalChunk);
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();

            this.logUsageSafe(route, payload, context, {
              success: true,
              is_stream: true,
              usage,
              request_id: usage.request_id || this.stringOrUndefined((responseMeta as any)?.id) || null,
              latency_ms: Date.now() - startedAt,
            });
          } catch (error: any) {
            this.logUsageSafe(route, payload, context, {
              success: false,
              is_stream: true,
              usage: {},
              latency_ms: Date.now() - startedAt,
              error_message: this.truncate(this.resolveAiSdkErrorMessage(error), 900),
            });
            controller.error(error);
          }
        },
      });

      return {
        stream: true,
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
        body,
      };
    }

    try {
      const result = await generateText(requestInput as any);
      const usage = this.normalizeAiSdkLanguageUsage(result.usage);
      const responseId = this.stringOrUndefined((result.response as any)?.id) || `chatcmpl_${Date.now()}`;
      const data: Record<string, unknown> = {
        id: responseId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: route.upstream_model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text || '' },
            finish_reason: this.mapAiSdkFinishReasonToOpenAi(result.finishReason as string | undefined),
          },
        ],
        usage: this.toOpenAiUsageObject(usage),
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: usage.request_id || responseId,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data,
      };
    } catch (error: any) {
      const message = this.resolveAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`AI SDK chat failed: ${message}`);
    }
  }

  private async forwardAiSdkEmbedding(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    provider: ReturnType<typeof createOpenAI>,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const rawInput = payload.input;
    const values = (Array.isArray(rawInput) ? rawInput : [rawInput ?? payload.text ?? payload.prompt])
      .map((item) => this.normalizePromptToText(item))
      .filter((item) => !!item);
    if (values.length === 0) {
      throw new BadRequestException('input is required');
    }

    try {
      let embeddings: number[][] = [];
      let promptTokens: number | null = null;
      if (values.length === 1) {
        const result = await embed({
          model: provider.embedding(route.upstream_model),
          value: values[0],
        });
        embeddings = [result.embedding as number[]];
        promptTokens = this.pickNumber((result as any).usage?.tokens);
      } else {
        const result = await embedMany({
          model: provider.embedding(route.upstream_model),
          values,
        });
        embeddings = result.embeddings as number[][];
        promptTokens = this.pickNumber((result as any).usage?.tokens);
      }

      const usage: AiUsageMetrics = {
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
      };
      const data: Record<string, unknown> = {
        object: 'list',
        data: embeddings.map((embeddingItem, index) => ({
          object: 'embedding',
          embedding: embeddingItem,
          index,
        })),
        model: route.upstream_model,
        usage: this.toOpenAiUsageObject(usage),
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data,
      };
    } catch (error: any) {
      const message = this.resolveAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`AI SDK embeddings failed: ${message}`);
    }
  }

  private async forwardAiSdkImage(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    provider: ReturnType<typeof createOpenAI>,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const prompt = this.stringOrUndefined(payload.prompt) || this.normalizePromptToText(payload.input);
    if (!prompt) {
      throw new BadRequestException('image prompt is required');
    }
    const nRaw = this.pickNumber(payload.n);
    const n = nRaw && nRaw > 0 ? Math.min(Math.max(nRaw, 1), 10) : 1;
    const size = this.stringOrUndefined(payload.size);
    const responseFormat = this.stringOrUndefined(payload.response_format) || 'url';

    try {
      const result = await generateImage({
        model: provider.image(route.upstream_model),
        prompt,
        n,
        size: size as `${number}x${number}` | undefined,
      });
      const usage: AiUsageMetrics = {
        total_tokens: this.pickNumber((result as any).usage?.tokens),
        image_count: result.images.length,
      };
      const imageData: Array<Record<string, unknown>> = [];
      for (let i = 0; i < result.images.length; i += 1) {
        const image = result.images[i];
        if (responseFormat === 'b64_json') {
          imageData.push({ b64_json: image.base64 });
          continue;
        }
        const url = await this.uploadAiSdkOutputAndResolveUrl(route, context, image, `image-${i + 1}`);
        imageData.push({ url });
      }

      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data: {
          created: Math.floor(Date.now() / 1000),
          data: imageData,
        },
      };
    } catch (error: any) {
      const message = this.resolveAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`AI SDK image generation failed: ${message}`);
    }
  }

  private shouldUseOpenAiStrictImageRoute(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): boolean {
    if (!route || route.capability !== 'image') {
      return false;
    }
    if (this.shouldUseRunningHub(route) || this.shouldUseDashscopeNative(route)) {
      return false;
    }
    if (!this.isOpenAiCompatibleSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }
    const openAiMode = this.resolveOpenAiImageModeFromPath(route, payload, context);
    return openAiMode === 'edits' || openAiMode === 'generations' || openAiMode === 'variations';
  }

  private resolveOpenAiImageModeFromPath(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): 'generations' | 'edits' | 'variations' | null {
    const requestPath = this.normalizeOpenAiImagePath(this.stringOrUndefined(context.request_path) || '');
    const endpointPath = this.normalizeOpenAiImagePath(route.endpoint_path || '');
    if (requestPath.includes('/images/edits')) {
      return 'edits';
    }
    if (endpointPath.includes('/images/edits')) {
      return 'edits';
    }
    if (requestPath.includes('/images/variations')) {
      return 'variations';
    }
    if (endpointPath.includes('/images/variations')) {
      return 'variations';
    }
    if (requestPath.includes('/images/edit') || endpointPath.includes('/images/edit')) {
      return 'edits';
    }
    if (
      (requestPath.includes('/images/generations') || endpointPath.includes('/images/generations'))
      && this.hasOpenAiImageInputs(payload)
    ) {
      return 'edits';
    }
    if (requestPath.includes('/images/generations')) {
      return 'generations';
    }
    if (endpointPath.includes('/images/generations')) {
      return 'generations';
    }
    if (requestPath.includes('/images/generation') || endpointPath.includes('/images/generation')) {
      return 'generations';
    }
    if (requestPath.includes('/images/variation') || endpointPath.includes('/images/variation')) {
      return 'variations';
    }
    if (payload.mask || payload.mask_url) {
      return 'edits';
    }
    if ((payload.image || payload.images) && !this.stringOrUndefined(payload.prompt)) {
      return 'variations';
    }
    return (payload.image || payload.images) ? 'edits' : null;
  }

  private async forwardOpenAiStrictImage(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const mode = this.resolveOpenAiImageModeFromPath(route, payload, context);
    if (mode === 'edits') {
      return this.forwardOpenAiStrictImageEdit(route, payload, context);
    }
    if (mode === 'variations') {
      return this.forwardOpenAiStrictImageVariations(route, payload, context);
    }
    return this.forwardOpenAiStrictImageGenerations(route, payload, context);
  }

  private async forwardOpenAiStrictImageGenerations(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const requestPayload = this.buildOpenAiStrictImageGenerationPayload(route, payload);
    if (requestPayload.stream === true) {
      throw new BadRequestException('image generations stream is not supported');
    }

    try {
      const endpointPath = this.normalizeEndpointPath(route.endpoint_path || '/images/generations');
      const upstreamResp = await this.fetchUpstream(route, this.joinUrl(route.source.base_url, endpointPath), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${route.source.api_key}`,
          ...route.source.custom_headers,
        },
        body: JSON.stringify(requestPayload),
      }, context, {
        timeoutMs: this.resolveOpenAiImageGenerationTimeoutMs(route),
      });
      const raw = await this.aiUpstreamClient.readText(upstreamResp);
      if (!upstreamResp.ok) {
        throw new BadGatewayException(
          `AI upstream error (${upstreamResp.status}): ${this.truncate(this.safeJsonPreview(raw), 900)}`,
        );
      }
      const data = this.parseOpenAiCompatibleImageResponse(raw, upstreamResp);
      const usage = this.extractUsageMetrics(data);
      const upstreamRequestId = this.extractUpstreamRequestId(upstreamResp, data);
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: usage.request_id || upstreamRequestId,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data,
      };
    } catch (error: any) {
      const message = this.resolveOfficialOpenAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`OpenAI image generations failed: ${message}`);
    }
  }

  private parseOpenAiCompatibleImageResponse(raw: string, response: Response): Record<string, unknown> {
    const data = this.tryParseJsonObject(raw);
    if (Object.keys(data).length === 0) {
      throw new BadGatewayException(
        `OpenAI image generations returned non-JSON response (${response.status}): ${this.truncate(raw, 500)}`,
      );
    }
    const normalizedImages = this.normalizeOpenAiCompatibleImageItems(data);
    if (normalizedImages.length === 0) {
      throw new BadGatewayException(
        `OpenAI image generations returned no image url or b64_json: ${this.truncate(this.safeJsonPreview(raw), 900)}`,
      );
    }
    return {
      ...data,
      created: this.pickNumber(data.created) ?? Math.floor(Date.now() / 1000),
      data: normalizedImages,
    };
  }

  private normalizeOpenAiCompatibleImageItems(data: Record<string, unknown>): Record<string, unknown>[] {
    const rawItems = Array.isArray(data.data) ? data.data : [];
    const normalized = rawItems
      .map((item) => this.normalizeOpenAiCompatibleImageItem(item))
      .filter((item): item is Record<string, unknown> => !!item);
    const topLevel = this.normalizeOpenAiCompatibleImageItem(data);
    if (topLevel && normalized.length === 0) {
      normalized.push(topLevel);
    }
    return normalized;
  }

  private normalizeOpenAiCompatibleImageItem(item: unknown): Record<string, unknown> | null {
    if (typeof item === 'string') {
      return /^https?:\/\//i.test(item) ? { url: item } : { b64_json: item };
    }
    const record = this.normalizeObject(item);
    const url =
      this.stringOrUndefined(record.url)
      || this.stringOrUndefined(record.image_url)
      || this.stringOrUndefined(record.imageUrl)
      || this.stringOrUndefined(record.output_url)
      || this.stringOrUndefined(record.outputUrl);
    const b64Json =
      this.stringOrUndefined(record.b64_json)
      || this.stringOrUndefined(record.b64Json)
      || this.stringOrUndefined(record.base64)
      || this.stringOrUndefined(record.image_base64)
      || this.stringOrUndefined(record.imageBase64);
    if (!url && !b64Json) {
      return null;
    }
    const normalized: Record<string, unknown> = { ...record };
    if (url) {
      normalized.url = url;
    }
    if (b64Json) {
      normalized.b64_json = b64Json;
    }
    return normalized;
  }

  private extractUpstreamRequestId(response: Response, data: Record<string, unknown>): string | null {
    return this.stringOrUndefined(data.id)
      || this.stringOrUndefined(data.request_id)
      || this.stringOrUndefined(data.requestId)
      || this.stringOrUndefined(response.headers.get('x-request-id'))
      || this.stringOrUndefined(response.headers.get('request-id'))
      || this.stringOrUndefined(response.headers.get('x-upstream-request-id'))
      || null;
  }

  private resolveOpenAiImageGenerationTimeoutMs(route: ResolvedAiRoute): number {
    this.ensureAiGatewayTuningFresh();
    const overrides = this.normalizeObject(route.request_overrides);
    const configured = this.pickNumber(
      overrides.openai_image_timeout_ms,
      overrides.image_timeout_ms,
      overrides.upstream_timeout_ms,
      this.aiGatewayTuning.image_upstream_timeout_ms,
      process.env.AI_GATEWAY_IMAGE_UPSTREAM_TIMEOUT_MS,
    );
    return this.boundNumber(configured ?? 600000, 600000, 10000, 600000);
  }

  private resolveDirectUpstreamTimeoutMs(route: ResolvedAiRoute): number | undefined {
    if (route.capability !== 'video') {
      return undefined;
    }
    this.ensureAiGatewayTuningFresh();
    const overrides = this.normalizeObject(route.request_overrides);
    const configured = this.pickNumber(
      overrides.openai_video_timeout_ms,
      overrides.video_timeout_ms,
      overrides.upstream_timeout_ms,
      this.aiGatewayTuning.video_upstream_timeout_ms,
      process.env.AI_GATEWAY_VIDEO_UPSTREAM_TIMEOUT_MS,
    );
    return this.boundNumber(
      configured ?? VIDEO_UPSTREAM_TIMEOUT_MS,
      VIDEO_UPSTREAM_TIMEOUT_MS,
      10000,
      VIDEO_UPSTREAM_TIMEOUT_MS,
    );
  }

  private async forwardOpenAiStrictImageEdit(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const client = this.createOfficialOpenAiClient(route);
    const requestPayload = await this.buildOpenAiStrictImageEditPayload(route, payload);
    if (requestPayload.stream === true) {
      throw new BadRequestException('image edits stream is not supported');
    }

    try {
      const result = await client.images.edit(requestPayload as any);
      const usage = this.extractUsageMetrics(this.normalizeObject(result as any));
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data: this.normalizeObject(result as any),
      };
    } catch (error: any) {
      const message = this.resolveOfficialOpenAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`OpenAI image edits failed: ${message}`);
    }
  }

  private async forwardOpenAiStrictImageVariations(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const client = this.createOfficialOpenAiClient(route);
    const requestPayload = await this.buildOpenAiStrictImageVariationsPayload(route, payload);
    if (requestPayload.stream === true) {
      throw new BadRequestException('image variations stream is not supported');
    }

    try {
      const result = await client.images.createVariation(requestPayload as any);
      const usage = this.extractUsageMetrics(this.normalizeObject(result as any));
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data: this.normalizeObject(result as any),
      };
    } catch (error: any) {
      const message = this.resolveOfficialOpenAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`OpenAI image variations failed: ${message}`);
    }
  }

  private buildOpenAiStrictImageGenerationPayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const prompt =
      this.stringOrUndefined(payload.prompt)
      || this.normalizePromptToText(payload.input)
      || this.stringOrUndefined(payload.text)
      || this.normalizePromptToText(payload.messages);
    if (!prompt) {
      throw new BadRequestException('prompt is required');
    }

    const request: Record<string, unknown> = {
      model: route.upstream_model,
      prompt,
    };

    const n = this.pickNumber(payload.n);
    if (n !== null) {
      request.n = this.boundNumber(n, 1, 1, 10);
    }

    this.assignOpenAiImagePassthroughParams(request, payload, {
      quality: true,
      resolution: true,
      aspectRatio: true,
    });

    const responseFormat = this.stringOrUndefined(payload.response_format);
    if (responseFormat) {
      const normalizedResponseFormat = responseFormat.toLowerCase();
      if (normalizedResponseFormat !== 'url' && normalizedResponseFormat !== 'b64_json') {
        throw new BadRequestException('response_format must be url or b64_json');
      }
      request.response_format = normalizedResponseFormat;
    }

    const style = this.stringOrUndefined(payload.style);
    if (style) {
      const normalizedStyle = style.toLowerCase();
      if (normalizedStyle !== 'vivid' && normalizedStyle !== 'natural') {
        throw new BadRequestException(`unsupported style: ${style}`);
      }
      request.style = normalizedStyle;
    }

    const background = this.stringOrUndefined(payload.background);
    if (background) {
      const normalizedBackground = background.toLowerCase();
      if (
        normalizedBackground !== 'transparent'
        && normalizedBackground !== 'opaque'
        && normalizedBackground !== 'auto'
      ) {
        throw new BadRequestException(`unsupported background: ${background}`);
      }
      request.background = normalizedBackground;
    }

    const outputFormat = this.stringOrUndefined(payload.output_format);
    if (outputFormat) {
      const normalizedOutputFormat = outputFormat.toLowerCase();
      if (
        normalizedOutputFormat !== 'png'
        && normalizedOutputFormat !== 'jpeg'
        && normalizedOutputFormat !== 'webp'
      ) {
        throw new BadRequestException(`unsupported output_format: ${outputFormat}`);
      }
      request.output_format = normalizedOutputFormat;
    }

    const outputCompression = this.pickNumber(payload.output_compression);
    if (outputCompression !== null) {
      request.output_compression = this.boundNumber(outputCompression, 100, 0, 100);
    }

    const moderation = this.stringOrUndefined(payload.moderation);
    if (moderation) {
      const normalizedModeration = moderation.toLowerCase();
      if (normalizedModeration !== 'low' && normalizedModeration !== 'auto') {
        throw new BadRequestException(`unsupported moderation: ${moderation}`);
      }
      request.moderation = normalizedModeration;
    }

    const size = this.stringOrUndefined(payload.size);
    if (size) {
      request.size = size;
    }

    const user = this.stringOrUndefined(payload.user);
    if (user) {
      request.user = user;
    }

    request.stream = false;
    return request;
  }

  private assignOpenAiImagePassthroughParams(
    request: Record<string, unknown>,
    payload: Record<string, unknown>,
    options: {
      quality?: boolean;
      resolution?: boolean;
      aspectRatio?: boolean;
    },
  ) {
    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    if (options.quality) {
      const quality =
        this.stringOrUndefined(payload.quality)
        || this.stringOrUndefined(inputObject.quality)
        || this.stringOrUndefined(parameters.quality);
      if (quality) {
        request.quality = quality;
      }
    }

    if (options.resolution) {
      const resolution =
        this.stringOrUndefined(payload.resolution)
        || this.stringOrUndefined(inputObject.resolution)
        || this.stringOrUndefined(parameters.resolution);
      if (resolution) {
        request.resolution = resolution;
      }
    }

    if (options.aspectRatio) {
      const aspectRatio =
        this.stringOrUndefined(payload.aspectRatio)
        || this.stringOrUndefined(inputObject.aspectRatio)
        || this.stringOrUndefined(parameters.aspectRatio);
      if (aspectRatio) {
        request.aspectRatio = aspectRatio;
      }
      const aspectRatioSnake =
        this.stringOrUndefined(payload.aspect_ratio)
        || this.stringOrUndefined(inputObject.aspect_ratio)
        || this.stringOrUndefined(parameters.aspect_ratio);
      if (aspectRatioSnake) {
        request.aspect_ratio = aspectRatioSnake;
      }
    }
  }

  private async buildOpenAiStrictImageEditPayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const prompt =
      this.stringOrUndefined(payload.prompt)
      || this.normalizePromptToText(payload.input)
      || this.stringOrUndefined(payload.text)
      || this.normalizePromptToText(payload.messages);
    if (!prompt) {
      throw new BadRequestException('prompt is required');
    }

    const images = await this.resolveOpenAiImageUploadFiles(payload, 'image');
    if (images.length === 0) {
      throw new BadRequestException('image is required for image edits');
    }
    if (images.length > 16) {
      throw new BadRequestException('images for edit supports up to 16 files');
    }

    const maskCandidates = await this.resolveOpenAiImageUploadFiles(payload, 'mask');
    if (maskCandidates.length > 1) {
      throw new BadRequestException('only one mask is supported');
    }

    const request: Record<string, unknown> = {
      model: route.upstream_model,
      prompt,
    };
    request.image = images.length > 1 ? images : images[0];

    const maskFile = maskCandidates[0];
    if (maskFile) {
      request.mask = maskFile;
    }

    const n = this.pickNumber(payload.n);
    if (n !== null) {
      request.n = this.boundNumber(n, 1, 1, 10);
    }

    const responseFormat = this.stringOrUndefined(payload.response_format);
    if (responseFormat) {
      const normalizedResponseFormat = responseFormat.toLowerCase();
      if (normalizedResponseFormat !== 'url' && normalizedResponseFormat !== 'b64_json') {
        throw new BadRequestException('response_format must be url or b64_json');
      }
      request.response_format = normalizedResponseFormat;
    }

    const size = this.stringOrUndefined(payload.size);
    if (size) {
      request.size = size;
    }

    const user = this.stringOrUndefined(payload.user);
    if (user) {
      request.user = user;
    }

    const background = this.stringOrUndefined(payload.background);
    if (background) {
      const normalizedBackground = background.toLowerCase();
      if (
        normalizedBackground !== 'transparent'
        && normalizedBackground !== 'opaque'
        && normalizedBackground !== 'auto'
      ) {
        throw new BadRequestException(`unsupported background: ${background}`);
      }
      request.background = normalizedBackground;
    }

    const inputFidelity = this.stringOrUndefined(payload.input_fidelity);
    if (inputFidelity) {
      const normalizedInputFidelity = inputFidelity.toLowerCase();
      if (normalizedInputFidelity !== 'high' && normalizedInputFidelity !== 'low') {
        throw new BadRequestException(`unsupported input_fidelity: ${inputFidelity}`);
      }
      request.input_fidelity = normalizedInputFidelity;
    }

    const outputCompression = this.pickNumber(payload.output_compression);
    if (outputCompression !== null) {
      request.output_compression = this.boundNumber(outputCompression, 100, 0, 100);
    }

    const outputFormat = this.stringOrUndefined(payload.output_format);
    if (outputFormat) {
      const normalizedOutputFormat = outputFormat.toLowerCase();
      if (
        normalizedOutputFormat !== 'png'
        && normalizedOutputFormat !== 'jpeg'
        && normalizedOutputFormat !== 'webp'
      ) {
        throw new BadRequestException(`unsupported output_format: ${outputFormat}`);
      }
      request.output_format = normalizedOutputFormat;
    }

    this.assignOpenAiImagePassthroughParams(request, payload, {
      quality: true,
      resolution: true,
      aspectRatio: true,
    });

    const partialImages = this.pickNumber(payload.partial_images);
    if (partialImages !== null) {
      request.partial_images = this.boundNumber(partialImages, 0, 0, 3);
    }

    request.stream = false;
    return request;
  }

  private async buildOpenAiStrictImageVariationsPayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const images = await this.resolveOpenAiImageUploadFiles(payload, 'image');
    if (images.length === 0) {
      throw new BadRequestException('image is required for image variations');
    }
    if (images.length > 1) {
      throw new BadRequestException('image variations supports only one image');
    }

    const request: Record<string, unknown> = {
      model: route.upstream_model,
      image: images[0],
    };

    const n = this.pickNumber(payload.n);
    if (n !== null) {
      request.n = this.boundNumber(n, 1, 1, 10);
    }

    const responseFormat = this.stringOrUndefined(payload.response_format);
    if (responseFormat) {
      const normalizedResponseFormat = responseFormat.toLowerCase();
      if (normalizedResponseFormat !== 'url' && normalizedResponseFormat !== 'b64_json') {
        throw new BadRequestException('response_format must be url or b64_json');
      }
      request.response_format = normalizedResponseFormat;
    }

    const size = this.stringOrUndefined(payload.size);
    if (size) {
      request.size = size;
    }

    const user = this.stringOrUndefined(payload.user);
    if (user) {
      request.user = user;
    }

    this.assignOpenAiImagePassthroughParams(request, payload, {
      quality: true,
      resolution: true,
      aspectRatio: true,
    });

    request.stream = false;
    return request;
  }

  private async resolveOpenAiImageUploadFiles(
    payload: Record<string, unknown>,
    fieldName: 'image' | 'mask',
  ): Promise<Array<File>> {
    const files: Array<File> = [];
    const rawItems = this.collectOpenAiImageUploadRawItems(payload, fieldName);

    for (let i = 0; i < rawItems.length; i += 1) {
      const file = await this.resolveOpenAiImageFileFromRaw(rawItems[i], `${fieldName}-${i + 1}`);
      if (file) {
        files.push(file);
      }
    }
    return files;
  }

  private hasOpenAiImageInputs(payload: Record<string, unknown>): boolean {
    return this.collectOpenAiImageUploadRawItems(payload, 'image').some((item) => this.hasOpenAiImageCandidateValue(item));
  }

  private collectOpenAiImageUploadRawItems(
    payload: Record<string, unknown>,
    fieldName: 'image' | 'mask',
  ): unknown[] {
    const rawItems: unknown[] = [];
    const pushItem = (raw: unknown) => {
      if (raw === undefined || raw === null) {
        return;
      }
      if (Array.isArray(raw)) {
        raw.forEach((item) => pushItem(item));
        return;
      }
      rawItems.push(raw);
    };

    const inputObject = this.normalizeObject(payload.input);
    pushItem(payload[fieldName]);
    pushItem(inputObject[fieldName]);

    if (fieldName === 'image') {
      [
        'images',
        'image_url',
        'reference_image',
        'reference_image_url',
        'reference_images',
        'ref_image',
        'ref_image_url',
        'ref_images',
      ].forEach((key) => {
        pushItem(payload[key]);
        pushItem(inputObject[key]);
      });

      [payload.messages, inputObject.messages, payload.content, inputObject.content].forEach((raw) => {
        this.collectOpenAiImagePartsFromMessages(raw).forEach((item) => pushItem(item));
      });
    }

    const multipart = this.extractMultipartInstruction(payload);
    if (multipart?.file_base64 && (!multipart.file_field_name || multipart.file_field_name === fieldName)) {
      pushItem(multipart.file_base64);
    }

    return rawItems;
  }

  private collectOpenAiImagePartsFromMessages(rawMessages: unknown): unknown[] {
    const values: unknown[] = [];
    const messages = Array.isArray(rawMessages) ? rawMessages : [rawMessages];
    messages.forEach((rawMessage) => {
      const message = this.normalizeObject(rawMessage);
      const content = Array.isArray(message.content) ? message.content : Array.isArray(rawMessage) ? rawMessage : [];
      content.forEach((rawPart) => {
        const part = this.normalizeObject(rawPart);
        const type = this.stringOrUndefined(part.type);
        if (type === 'image_url' || type === 'input_image' || part.image_url || part.image || part.url || part.b64_json) {
          values.push(rawPart);
        }
      });
    });
    return values;
  }

  private hasOpenAiImageCandidateValue(rawValue: unknown): boolean {
    if (typeof rawValue === 'string') {
      return !!rawValue.trim();
    }
    if (!rawValue || typeof rawValue !== 'object') {
      return false;
    }
    const record = this.normalizeObject(rawValue);
    return !!(
      this.stringOrUndefined(record.url)
      || this.stringOrUndefined(record.image)
      || this.stringOrUndefined(record.b64_json)
      || this.resolveOpenAiImagePartUrl(record.image_url)
      || this.stringOrUndefined(this.normalizeObject(record.image_url)?.url)
      || this.stringOrUndefined(record.image_url)
    );
  }

  private async resolveOpenAiImageFileFromRaw(
    rawValue: unknown,
    fileLabel: string,
  ): Promise<File | null> {
    const candidates: string[] = [];
    const pushCandidate = (candidate: unknown) => {
      const normalized = this.stringOrUndefined(candidate);
      if (normalized) {
        candidates.push(normalized);
      }
    };

    if (typeof rawValue === 'string' || rawValue === undefined || rawValue === null) {
      pushCandidate(rawValue);
    } else if (rawValue && typeof rawValue === 'object') {
      const record = this.normalizeObject(rawValue);
      pushCandidate(record.url);
      pushCandidate(record.image);
      pushCandidate(record.b64_json);
      const imageUrl = this.resolveOpenAiImagePartUrl(record.image_url);
      pushCandidate(imageUrl);
      const nestedUrl = this.stringOrUndefined(this.normalizeObject(record.image_url)?.url);
      pushCandidate(nestedUrl);
      pushCandidate(record.image_url);
    }

    for (const candidate of candidates) {
      const parsedDataUrl = this.parseDataUrl(candidate);
      if (parsedDataUrl) {
        const mimeType = parsedDataUrl.mimeType || 'image/png';
        const file = await toFile(
          Buffer.from(parsedDataUrl.base64, 'base64'),
          `${this.sanitizeFileName(fileLabel)}-${Date.now()}${this.extensionByMimeType(mimeType)}`,
          { type: mimeType },
        );
        return file;
      }

      const normalizedBase64 = candidate.replace(/\s+/g, '');
      if (this.isLikelyBase64(normalizedBase64)) {
        const mimeType = this.inferImageMimeTypeFromBase64(normalizedBase64, fileLabel);
        const file = await toFile(
          Buffer.from(normalizedBase64, 'base64'),
          `${this.sanitizeFileName(fileLabel)}-${Date.now()}${this.extensionByMimeType(mimeType)}`,
          { type: mimeType },
        );
        return file;
      }

      if (/^https?:\/\//i.test(candidate)) {
        const response = await fetch(candidate);
        if (!response.ok) {
          throw new BadRequestException(`failed to fetch image ${fileLabel}: ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        return toFile(
          buffer,
          this.sanitizeFileName(fileLabel),
          { type: response.headers.get('content-type') || undefined },
        );
      }
    }

    return null;
  }

  private normalizeOpenAiImagePath(rawPath: string): string {
    const pathWithoutQuery = String(rawPath || '').split('?')[0];
    if (!pathWithoutQuery) {
      return '';
    }
    return pathWithoutQuery.startsWith('/') ? pathWithoutQuery : `/${pathWithoutQuery}`;
  }

  private async forwardAiSdkStt(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    provider: ReturnType<typeof createOpenAI>,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const audio = this.resolveAiSdkTranscriptionAudio(payload);
    const responseFormat = this.stringOrUndefined(payload.response_format) || 'json';
    const language = this.stringOrUndefined(payload.language);
    const prompt = this.stringOrUndefined(payload.prompt);
    const timestampGranularities = Array.isArray(payload.timestamp_granularities)
      ? payload.timestamp_granularities.filter((item) => item === 'word' || item === 'segment')
      : [];

    try {
      const result = await experimental_transcribe({
        model: provider.transcription(route.upstream_model),
        audio,
        providerOptions: {
          openai: {
            ...(language ? { language } : {}),
            ...(prompt ? { prompt } : {}),
            ...(timestampGranularities.length ? { timestampGranularities } : {}),
          },
        },
      });
      const usage: AiUsageMetrics = {
        duration_seconds: this.numberOrNull(result.durationInSeconds),
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        latency_ms: Date.now() - startedAt,
      });
      if (responseFormat === 'verbose_json') {
        return {
          stream: false,
          data: {
            text: result.text,
            language: result.language,
            duration: result.durationInSeconds,
            segments: result.segments,
          },
        };
      }
      return {
        stream: false,
        data: {
          text: result.text,
        },
      };
    } catch (error: any) {
      const message = this.resolveAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`AI SDK transcription failed: ${message}`);
    }
  }

  private async forwardAiSdkTts(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    provider: ReturnType<typeof createOpenAI>,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const text = this.stringOrUndefined(payload.input) || this.stringOrUndefined(payload.text);
    if (!text) {
      throw new BadRequestException('input text is required');
    }
    const voice = this.stringOrUndefined(payload.voice) || 'alloy';
    const outputFormat =
      (this.stringOrUndefined(payload.response_format) || this.stringOrUndefined(payload.format) || 'mp3').toLowerCase();

    try {
      const result = await experimental_generateSpeech({
        model: provider.speech(route.upstream_model),
        text,
        voice,
        outputFormat: outputFormat as any,
      });
      const buffer = Buffer.from(result.audio.uint8Array);
      const usage: AiUsageMetrics = {
        duration_seconds: this.resolveDurationSecondsFromPayload(payload),
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        binary: true,
        status: 200,
        headers: {
          'content-type': this.contentTypeByAudioFormat(result.audio.format || outputFormat),
          'content-disposition': `inline; filename="speech.${result.audio.format || outputFormat}"`,
        },
        body: buffer,
      };
    } catch (error: any) {
      const message = this.resolveAiSdkErrorMessage(error);
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`AI SDK speech failed: ${message}`);
    }
  }

  private applyAiSdkChatSettings(
    requestInput: Record<string, unknown>,
    payload: Record<string, unknown>,
    route: ResolvedAiRoute,
  ) {
    if (!this.isOpenAiReasoningChatRoute(route)) {
      const temperature = Number(payload.temperature);
      if (Number.isFinite(temperature)) {
        requestInput.temperature = temperature;
      }
      const topP = Number(payload.top_p);
      if (Number.isFinite(topP)) {
        requestInput.topP = topP;
      }
    }
    const maxTokens = Number(payload.max_tokens ?? payload.max_output_tokens);
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      requestInput.maxOutputTokens = Math.round(maxTokens);
    }
    if (!this.isOpenAiReasoningChatRoute(route)) {
      const presencePenalty = Number(payload.presence_penalty);
      if (Number.isFinite(presencePenalty)) {
        requestInput.presencePenalty = presencePenalty;
      }
      const frequencyPenalty = Number(payload.frequency_penalty);
      if (Number.isFinite(frequencyPenalty)) {
        requestInput.frequencyPenalty = frequencyPenalty;
      }
    }
    const stop = payload.stop;
    if (typeof stop === 'string' && stop.trim()) {
      requestInput.stopSequences = [stop];
    } else if (Array.isArray(stop)) {
      const stops = stop.map((item) => this.stringOrUndefined(item)).filter((item): item is string => !!item);
      if (stops.length > 0) {
        requestInput.stopSequences = stops;
      }
    }
  }

  private sanitizeChatPayloadForReasoningModel(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.isOpenAiReasoningChatRoute(route)) {
      return payload;
    }
    const sanitized = { ...payload };
    delete sanitized.temperature;
    delete sanitized.top_p;
    delete sanitized.presence_penalty;
    delete sanitized.frequency_penalty;
    return sanitized;
  }

  private isOpenAiReasoningChatRoute(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'chat') {
      return false;
    }
    const modelKey = `${route.upstream_model || ''} ${route.model_key || ''}`.toLowerCase();
    return /(^|[\/:\s_-])o[134](?:[-\s]|$)/.test(modelKey)
      || /(^|[\/:\s_-])gpt-5(?:[-.\s]|$)/.test(modelKey)
      || modelKey.includes('reasoning');
  }

  private shouldBypassAiSdkChatForward(route: ResolvedAiRoute, payload: Record<string, unknown>): boolean {
    if (route.capability !== 'chat') {
      return false;
    }
    if (this.isStreamingRequest(payload) && this.isOpenAiCompatibleSource(route.source.provider_type, route.source.base_url)) {
      return true;
    }
    const directFields = [
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'functions',
      'function_call',
      'response_format',
      'reasoning',
      'reasoning_effort',
      'modalities',
      'audio',
      'prediction',
      'include',
      'metadata',
      'store',
      'service_tier',
      'web_search_options',
    ];
    if (directFields.some((key) => payload[key] !== undefined)) {
      return true;
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages.some((message) => this.messageRequiresRawChatProxy(message));
  }

  private isStreamingRequest(payload: Record<string, unknown>): boolean {
    return payload.stream === true || payload.stream === 'true';
  }

  private shouldProxyResponsesDirectly(route: ResolvedAiRoute, payload: Record<string, unknown>): boolean {
    if (route.capability !== 'chat') {
      return false;
    }
    const requestPath = this.normalizeEndpointPath(this.stringOrUndefined(payload.endpoint_path) || '');
    if (requestPath === '/responses' || requestPath === '/v1/responses') {
      return true;
    }
    if (
      payload.previous_response_id !== undefined
      || payload.instructions !== undefined
      || payload.tools !== undefined
      || payload.include !== undefined
      || payload.metadata !== undefined
      || payload.reasoning !== undefined
      || payload.store !== undefined
      || payload.text !== undefined
      || payload.truncation !== undefined
      || payload.max_output_tokens !== undefined
    ) {
      return true;
    }
    if (Array.isArray(payload.input)) {
      return true;
    }
    if (payload.input && typeof payload.input === 'object') {
      return true;
    }
    return payload.stream === true || payload.stream === 'true';
  }

  private messageRequiresRawChatProxy(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
      return false;
    }
    const message = raw as Record<string, unknown>;
    const role = this.stringOrUndefined(message.role);
    if (role === 'tool') {
      return true;
    }
    if (message.tool_call_id !== undefined || message.tool_calls !== undefined || message.function_call !== undefined) {
      return true;
    }

    const content = message.content;
    if (Array.isArray(content)) {
      return content.some((part) => {
        if (!part || typeof part !== 'object') {
          return false;
        }
        const partObj = part as Record<string, unknown>;
        const type = this.stringOrUndefined(partObj.type);
        return !!type && type !== 'text' && type !== 'input_text' && type !== 'output_text';
      });
    }
    return false;
  }

  private resolveResponsesEndpointPath(route: ResolvedAiRoute): string {
    const normalized = this.normalizeEndpointPath(route.endpoint_path || '/chat/completions');
    if (normalized === '/responses' || normalized === '/v1/responses') {
      return normalized;
    }
    if (normalized === '/chat/completions' || normalized === '/v1/chat/completions') {
      return '/responses';
    }
    return '/responses';
  }

  private normalizeAiSdkLanguageUsage(usage: any): AiUsageMetrics {
    const promptTokens = this.pickNumber(usage?.inputTokens, usage?.promptTokens, usage?.prompt_tokens);
    const completionTokens = this.pickNumber(usage?.outputTokens, usage?.completionTokens, usage?.completion_tokens);
    const totalTokens =
      this.pickNumber(usage?.totalTokens, usage?.total_tokens)
      ?? ((promptTokens ?? 0) + (completionTokens ?? 0) > 0 ? (promptTokens ?? 0) + (completionTokens ?? 0) : null);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }

  private toOpenAiUsageObject(usage: AiUsageMetrics): Record<string, number> {
    const promptTokens = this.normalizePositiveIntegerOrNull(usage.prompt_tokens) || 0;
    const completionTokens = this.normalizePositiveIntegerOrNull(usage.completion_tokens) || 0;
    const totalTokens = this.normalizePositiveIntegerOrNull(usage.total_tokens) || promptTokens + completionTokens;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }

  private mapAiSdkFinishReasonToOpenAi(value?: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === 'stop') {
      return 'stop';
    }
    if (normalized === 'length') {
      return 'length';
    }
    if (normalized === 'content-filter') {
      return 'content_filter';
    }
    if (normalized === 'tool-calls') {
      return 'tool_calls';
    }
    return 'stop';
  }

  private resolveAiSdkTranscriptionAudio(payload: Record<string, unknown>): Uint8Array | URL {
    const multipart = this.extractMultipartInstruction(payload);
    const multipartBase64 = this.stringOrUndefined(multipart?.file_base64);
    if (multipartBase64) {
      const parsed = this.parseDataUrl(multipartBase64);
      return Buffer.from((parsed ? parsed.base64 : multipartBase64).replace(/\s+/g, ''), 'base64');
    }

    const directUrl = this.extractDashscopeAudioUrl(payload);
    if (directUrl) {
      return new URL(directUrl);
    }

    const directBase64Candidates = [
      this.stringOrUndefined(payload.file_base64),
      this.stringOrUndefined(payload.audio_base64),
      this.stringOrUndefined(payload.audio),
      this.stringOrUndefined(payload.file),
    ].filter((item): item is string => !!item);

    for (const candidate of directBase64Candidates) {
      if (/^https?:\/\//i.test(candidate)) {
        return new URL(candidate);
      }
      const parsed = this.parseDataUrl(candidate);
      const raw = parsed ? parsed.base64 : candidate;
      if (this.isLikelyBase64(raw.replace(/\s+/g, ''))) {
        return Buffer.from(raw.replace(/\s+/g, ''), 'base64');
      }
    }

    throw new BadRequestException('file is required (multipart file, file_base64, or file_url)');
  }

  private async uploadAiSdkOutputAndResolveUrl(
    route: ResolvedAiRoute,
    context: AiInvocationContext,
    file: { mediaType: string; uint8Array: Uint8Array; base64: string },
    fileLabel: string,
  ): Promise<string> {
    const uploaderId = this.stringOrUndefined(context.user_id) || 'system';
    const mimeType = this.stringOrUndefined(file.mediaType) || 'application/octet-stream';
    const extension = this.extensionByMimeType(mimeType);
    const fileName = `${this.sanitizeFileName(fileLabel)}-${Date.now()}${extension}`;
    const uploaded = await this.uploadService.uploadBuffer(
      uploaderId,
      fileName,
      mimeType,
      Buffer.from(file.uint8Array),
      route.app_slug,
      AI_SDK_OUTPUT_UPLOAD_PREFIX,
    );
    const readableUrl = await this.uploadService.resolveReadableUrl(uploaded.file_url, DASHSCOPE_TEMP_URL_EXPIRES_SECONDS);
    const finalUrl = readableUrl || uploaded.file_url;
    if (/^https?:\/\//i.test(String(finalUrl || ''))) {
      return String(finalUrl);
    }
    return `data:${mimeType};base64,${file.base64}`;
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
      const message = error.message || 'unknown error';
      const causeMessage = this.resolveErrorCauseMessage(anyErr.cause);
      return causeMessage && causeMessage !== message ? `${message}: ${causeMessage}` : message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private resolveErrorCauseMessage(cause: unknown): string | null {
    if (!cause) {
      return null;
    }
    if (typeof cause === 'string') {
      return cause.trim() || null;
    }
    if (cause instanceof Error) {
      const anyCause = cause as any;
      const parts = [
        String(anyCause.code || '').trim(),
        String(cause.name || '').trim(),
        String(cause.message || '').trim(),
      ].filter(Boolean);
      const nested = this.resolveErrorCauseMessage(anyCause.cause);
      if (nested) {
        parts.push(nested);
      }
      return Array.from(new Set(parts)).join(': ') || null;
    }
    if (typeof cause === 'object') {
      const record = cause as Record<string, unknown>;
      const parts = [
        String(record.code || '').trim(),
        String(record.name || '').trim(),
        String(record.message || '').trim(),
      ].filter(Boolean);
      const nested = this.resolveErrorCauseMessage(record.cause);
      if (nested) {
        parts.push(nested);
      }
      return Array.from(new Set(parts)).join(': ') || null;
    }
    return String(cause);
  }

  private async forwardToUpstream(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const upstreamPayload = this.withStreamUsageOptions(route, payload);
    if (!this.isStreamingRequest(upstreamPayload) && this.shouldUseOfficialOpenAiSdkProxy(route)) {
      return this.forwardViaOfficialOpenAiSdkProxy(route, upstreamPayload, context);
    }

    const startedAt = Date.now();
    const isStreamRequest = this.isStreamingRequest(upstreamPayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.source.api_key}`,
      ...(isStreamRequest
        ? {
            Accept: 'text/event-stream',
            'Accept-Encoding': 'identity',
          }
        : {}),
      ...route.source.custom_headers,
    };
    const body = JSON.stringify(upstreamPayload);
    const upstreamTimeoutMs = this.resolveDirectUpstreamTimeoutMs(route);

    const release = await this.aiGatewayThrottle.acquire(route, context);
    let upstreamFailureRecorded = false;
    try {
      const upstreamResult = await this.dispatchUpstreamRequest(route, async (endpointUrl) => {
        return this.aiUpstreamClient.fetch(route, endpointUrl, {
          method: 'POST',
          headers,
          body,
        }, {
          stream: isStreamRequest,
          ...(upstreamTimeoutMs ? { timeoutMs: upstreamTimeoutMs } : {}),
        });
      });
      const upstreamResp = upstreamResult.response;

      if (!upstreamResp.ok) {
        const errorBody = await this.aiUpstreamClient.readText(upstreamResp);
        this.aiGatewayThrottle.recordFailure(route, upstreamResp.status, errorBody);
        upstreamFailureRecorded = true;
        this.logUsageSafe(route, payload, context, {
          success: false,
          is_stream: upstreamPayload.stream === true || upstreamPayload.stream === 'true',
          usage: {},
          latency_ms: Date.now() - startedAt,
          error_message: `HTTP ${upstreamResp.status}: ${this.truncate(String(errorBody || ''), 900)}`,
        });
        this.logger.error(
          `AI upstream failed capability=${route.capability} model=${route.model_key} source=${route.source.name} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 600)}`,
        );
        const attemptedEndpointsSuffix = this.buildAttemptedEndpointsSuffix(upstreamResult.attemptedEndpoints);
        throw new BadGatewayException(
          `AI upstream error (${upstreamResp.status}): ${errorBody || upstreamResp.statusText || 'request failed'}${attemptedEndpointsSuffix}`,
        );
      }

      this.aiGatewayThrottle.recordSuccess(route);
      return this.buildSuccessfulForwardedResponse(route, upstreamPayload, context, startedAt, upstreamResp, release);
    } catch (error: any) {
      if (!upstreamFailureRecorded) {
        this.aiGatewayThrottle.recordFailure(route, this.numberOrNull(error?.status) ?? null, error?.message || null);
      }
      release();
      throw error;
    }
  }

  private async forwardMultipartToUpstream(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    multipart: MultipartInstruction,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const headers = this.normalizeMultipartHeaders({
      Authorization: `Bearer ${route.source.api_key}`,
      ...route.source.custom_headers,
    });
    const upstreamTimeoutMs = this.resolveDirectUpstreamTimeoutMs(route);

    const release = await this.aiGatewayThrottle.acquire(route, context);
    let upstreamFailureRecorded = false;
    try {
      const upstreamResult = await this.dispatchUpstreamRequest(route, async (endpointUrl) => {
        const form = this.buildMultipartForm(payload, multipart);
        return this.aiUpstreamClient.fetch(route, endpointUrl, {
          method: 'POST',
          headers,
          body: form,
        }, upstreamTimeoutMs ? { timeoutMs: upstreamTimeoutMs } : {});
      });
      const upstreamResp = upstreamResult.response;

      if (!upstreamResp.ok) {
        const errorBody = await this.aiUpstreamClient.readText(upstreamResp);
        this.aiGatewayThrottle.recordFailure(route, upstreamResp.status, errorBody);
        upstreamFailureRecorded = true;
        this.logUsageSafe(route, payload, context, {
          success: false,
          is_stream: false,
          usage: {},
          latency_ms: Date.now() - startedAt,
          error_message: `HTTP ${upstreamResp.status}: ${this.truncate(String(errorBody || ''), 900)}`,
        });
        this.logger.error(
          `AI upstream multipart failed capability=${route.capability} model=${route.model_key} source=${route.source.name} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 600)}`,
        );
        const attemptedEndpointsSuffix = this.buildAttemptedEndpointsSuffix(upstreamResult.attemptedEndpoints);
        throw new BadGatewayException(
          `AI upstream error (${upstreamResp.status}): ${errorBody || upstreamResp.statusText || 'request failed'}${attemptedEndpointsSuffix}`,
        );
      }

      this.aiGatewayThrottle.recordSuccess(route);
      return this.buildSuccessfulForwardedResponse(route, payload, context, startedAt, upstreamResp, release);
    } catch (error: any) {
      if (!upstreamFailureRecorded) {
        this.aiGatewayThrottle.recordFailure(route, this.numberOrNull(error?.status) ?? null, error?.message || null);
      }
      release();
      throw error;
    }
  }

  private shouldUseOfficialOpenAiSdkProxy(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'chat') {
      return false;
    }
    if (!this.isOpenAiCompatibleSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }
    const endpointPath = this.normalizeEndpointPath(route.endpoint_path || '/chat/completions');
    return endpointPath === '/chat/completions'
      || endpointPath === '/v1/chat/completions'
      || endpointPath === '/responses'
      || endpointPath === '/v1/responses';
  }

  private isOpenAiCompatibleSource(providerType: string, baseUrl: string): boolean {
    if (this.isGeminiSource(providerType, baseUrl)) {
      return false;
    }
    if (this.isAnthropicSource(providerType, baseUrl)) {
      return false;
    }
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    if (provider.includes('openai') || provider.includes('compat') || provider.includes('openrouter')) {
      return true;
    }
    if (provider.includes('deepseek') || provider.includes('moonshot') || provider.includes('siliconflow')) {
      return true;
    }
    if (this.isMinimaxSource(providerType)) {
      return false;
    }
    return /\/v1$/i.test(url) && !this.isDashscopeSource(providerType, baseUrl);
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

  private isAnthropicSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('anthropic')
      || url.includes('api.anthropic.com')
      || url.includes('/anthropic');
  }

  private isGeminiSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('gemini')
      || provider.includes('google')
      || provider.includes('vertex')
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

  private createOfficialOpenAiClient(route: ResolvedAiRoute): OpenAI {
    return new OpenAI({
      apiKey: route.source.api_key,
      baseURL: this.resolveAiSdkBaseUrl(route),
      defaultHeaders: route.source.custom_headers,
      fetch: this.buildRouteFetch(route),
      maxRetries: 0,
    });
  }

  private buildRouteFetch(route: ResolvedAiRoute): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => (
      this.outboundHttp.fetch(input, init || {}, { proxyId: route.source.outbound_proxy_id })
    )) as typeof fetch;
  }

  private async forwardViaOfficialOpenAiSdkProxy(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const client = this.createOfficialOpenAiClient(route);
    const endpointPath = this.normalizeEndpointPath(route.endpoint_path || '/chat/completions');
    const operation = endpointPath === '/responses' || endpointPath === '/v1/responses'
      ? 'responses'
      : 'chat.completions';
    const upstreamPayload = this.withStreamUsageOptions(route, payload);

    const release = await this.aiGatewayThrottle.acquire(route, context);
    try {
      const request = operation === 'responses'
        ? client.responses.create(upstreamPayload as any)
        : client.chat.completions.create(upstreamPayload as any);
      const upstreamResp = await request.asResponse();
      this.aiGatewayThrottle.recordSuccess(route);
      return this.buildSuccessfulForwardedResponse(route, upstreamPayload, context, startedAt, upstreamResp, release);
    } catch (error: any) {
      const message = this.resolveOfficialOpenAiSdkErrorMessage(error);
      this.aiGatewayThrottle.recordFailure(route, this.numberOrNull(error?.status) ?? null, message);
      release();
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: upstreamPayload.stream === true || upstreamPayload.stream === 'true',
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(message, 900),
      });
      throw new BadGatewayException(`OpenAI SDK ${operation} failed: ${message}`);
    }
  }

  private withStreamUsageOptions(route: ResolvedAiRoute, payload: Record<string, unknown>): Record<string, unknown> {
    return this.aiProtocolAdapter.withOpenAiStreamUsageOptions(route, payload);
  }

  private async fetchUpstream(
    route: ResolvedAiRoute,
    endpointUrl: string,
    init: RequestInit,
    context: AiInvocationContext = {},
    options: { stream?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    const release = await this.aiGatewayThrottle.acquire(route, context);
    try {
      const response = await this.aiUpstreamClient.fetch(route, endpointUrl, init, options);
      if (response.ok) {
        this.aiGatewayThrottle.recordSuccess(route);
      } else {
        this.aiGatewayThrottle.recordFailure(route, response.status, response.statusText);
      }
      return response;
    } catch (error: any) {
      this.aiGatewayThrottle.recordFailure(route, this.numberOrNull(error?.status) ?? null, error?.message || null);
      throw error;
    } finally {
      release();
    }
  }

  private async forwardAliyunIceVideoTranslationAsync(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const requestPayload = this.buildAliyunIceVideoTranslationPayload(route, payload);
    const release = await this.aiGatewayThrottle.acquire(route, context);
    try {
      const sdk = await this.loadAliyunIceSdk();
      const client = this.createAliyunIceClient(route, sdk);
      const request = new sdk.SubmitVideoTranslationJobRequest({
        inputConfig: this.stringOrUndefined(requestPayload.InputConfig),
        outputConfig: this.stringOrUndefined(requestPayload.OutputConfig),
        editingConfig: this.stringOrUndefined(requestPayload.EditingConfig),
        title: this.stringOrUndefined(requestPayload.Title),
        description: this.stringOrUndefined(requestPayload.Description),
        userData: this.stringOrUndefined(requestPayload.UserData),
        clientToken: this.stringOrUndefined(requestPayload.ClientToken),
      });
      const response = await client.submitVideoTranslationJob(request);
      const data = this.normalizeAliyunIceSdkResponse(response);
      const success = data.success !== false;
      const jobId = this.extractAliyunIceVideoTranslationJobId(data);
      if (!success || !jobId) {
        this.aiGatewayThrottle.recordFailure(route, null, this.extractAliyunIceVideoTranslationErrorMessage(data));
        this.logUsageSafe(route, requestPayload, context, {
          success: false,
          is_stream: false,
          usage: {},
          request_id: this.stringOrUndefined(data.request_id),
          latency_ms: Date.now() - startedAt,
          error_message: this.truncate(this.extractAliyunIceVideoTranslationErrorMessage(data) || 'Aliyun ICE did not return JobId', 900),
          billable: false,
        });
        throw new BadGatewayException(this.extractAliyunIceVideoTranslationErrorMessage(data) || 'Aliyun ICE video translation did not return JobId');
      }
      this.aiGatewayThrottle.recordSuccess(route);
      return {
        stream: false,
        data: {
          ...data,
          task_id: jobId,
          provider_task_id: jobId,
          task_status: 'PENDING',
        },
      };
    } catch (error: any) {
      this.aiGatewayThrottle.recordFailure(route, this.numberOrNull(error?.status) ?? null, error?.message || null);
      if (!(error instanceof BadGatewayException)) {
        this.logUsageSafe(route, requestPayload, context, {
          success: false,
          is_stream: false,
          usage: {},
          latency_ms: Date.now() - startedAt,
          error_message: this.truncate(String(error?.message || 'Aliyun ICE request failed'), 900),
          billable: false,
        });
      }
      throw error;
    } finally {
      release();
    }
  }

  private async fetchAliyunIceVideoTranslationTaskData(
    route: ResolvedAiRoute,
    providerTaskId: string,
  ): Promise<Record<string, unknown>> {
    const taskId = this.stringOrUndefined(providerTaskId);
    if (!taskId) {
      throw new BadRequestException('provider task id is required');
    }
    const release = await this.aiGatewayThrottle.acquire(route, {});
    try {
      const sdk = await this.loadAliyunIceSdk();
      const client = this.createAliyunIceClient(route, sdk);
      const request = new sdk.GetSmartHandleJobRequest({ jobId: taskId });
      const response = await client.getSmartHandleJob(request);
      const data = this.normalizeAliyunIceSdkResponse(response);
      this.aiGatewayThrottle.recordSuccess(route);
      return data;
    } catch (error: any) {
      this.aiGatewayThrottle.recordFailure(route, this.numberOrNull(error?.status) ?? null, error?.message || null);
      throw new BadGatewayException(`Aliyun ICE task query failed: ${error?.message || 'request failed'}`);
    } finally {
      release();
    }
  }

  private async loadAliyunIceSdk(): Promise<any> {
    const sdk = await import('@alicloud/ice20201109');
    return sdk;
  }

  private createAliyunIceClient(route: ResolvedAiRoute, sdk: any): any {
    const accessKeyId = this.stringOrUndefined(route.source.api_key);
    const config = this.normalizeObject(route.source.custom_headers);
    const accessKeySecret =
      this.stringOrUndefined(config.access_key_secret)
      || this.stringOrUndefined(config.accessKeySecret)
      || this.stringOrUndefined(config.secret)
      || this.stringOrUndefined(config.secret_key)
      || this.stringOrUndefined(config.access_key);
    if (!accessKeyId || !accessKeySecret) {
      throw new BadRequestException('Aliyun ICE source requires api_key as AccessKeyId and custom_headers.access_key_secret');
    }
    const regionId =
      this.stringOrUndefined(config.region_id)
      || this.stringOrUndefined(config.regionId)
      || this.extractAliyunRegionFromEndpoint(route.source.base_url)
      || ALIYUN_ICE_DEFAULT_REGION;
    const endpoint =
      this.normalizeAliyunIceEndpoint(
        this.stringOrUndefined(config.endpoint)
        || this.stringOrUndefined(route.source.base_url)
        || ALIYUN_ICE_DEFAULT_ENDPOINT,
      );
    const Client = sdk.default || sdk.Client || sdk;
    return new Client({
      accessKeyId,
      accessKeySecret,
      regionId,
      endpoint,
      protocol: 'HTTPS',
      readTimeout: 30_000,
      connectTimeout: 10_000,
    });
  }

  private normalizeAliyunIceEndpoint(value: string): string {
    return String(value || ALIYUN_ICE_DEFAULT_ENDPOINT)
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '') || ALIYUN_ICE_DEFAULT_ENDPOINT;
  }

  private extractAliyunRegionFromEndpoint(value: string): string | null {
    const endpoint = String(value || '').trim().toLowerCase();
    const match = endpoint.match(/(?:^|\.)(cn-[a-z0-9-]+|ap-[a-z0-9-]+|us-[a-z0-9-]+|eu-[a-z0-9-]+)\.aliyuncs\.com/);
    return match?.[1] || null;
  }

  private normalizeAliyunIceSdkResponse(response: any): Record<string, unknown> {
    const rawBody = response?.body;
    const body = this.normalizeObject(typeof rawBody?.toMap === 'function' ? rawBody.toMap() : rawBody);
    const data = this.normalizeObject(body.Data ?? body.data);
    const normalized: Record<string, unknown> = {
      raw: body,
      request_id: this.stringOrUndefined(body.RequestId) || this.stringOrUndefined(body.requestId),
      success: body.Success ?? body.success,
      job_id:
        this.stringOrUndefined(body.JobId)
        || this.stringOrUndefined(body.jobId)
        || this.stringOrUndefined(data.JobId)
        || this.stringOrUndefined(data.jobId),
      state: this.stringOrUndefined(body.State) || this.stringOrUndefined(body.state),
      error_code: this.stringOrUndefined(body.ErrorCode) || this.stringOrUndefined(body.errorCode),
      error_message: this.stringOrUndefined(body.ErrorMessage) || this.stringOrUndefined(body.errorMessage),
      output: body.Output ?? body.output,
      user_data: body.UserData ?? body.userData,
      job_result: body.JobResult ?? body.jobResult,
      smart_job_info: body.SmartJobInfo ?? body.smartJobInfo,
    };
    Object.keys(normalized).forEach((key) => {
      if (normalized[key] === undefined) {
        delete normalized[key];
      }
    });
    return normalized;
  }

  private async buildSuccessfulForwardedResponse(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    startedAt: number,
    upstreamResp: Response,
    release?: AiGatewayRelease,
  ): Promise<ForwardedAiResponse> {
    const isStream = payload.stream === true || payload.stream === 'true';
    if (isStream) {
      const wrapped = this.wrapSseStreamWithUsageLogging(
        route,
        payload,
        context,
        upstreamResp.body,
        startedAt,
        release,
      );
      return {
        stream: true,
        status: upstreamResp.status,
        headers: {
          ...this.aiUpstreamClient.filterResponseHeaders(upstreamResp.headers, 'text/event-stream; charset=utf-8'),
          connection: upstreamResp.headers.get('connection') || 'keep-alive',
          'x-accel-buffering': upstreamResp.headers.get('x-accel-buffering') || 'no',
        },
        body: wrapped,
      };
    }

    try {
      const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const data = (await upstreamResp.json()) as Record<string, unknown>;
        const usage = this.extractUsageMetrics(data);
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage,
          request_id: usage.request_id || this.stringOrUndefined(data.id),
          latency_ms: Date.now() - startedAt,
        });
        return {
          stream: false,
          data,
        };
      }

      if (contentType.startsWith('audio/') || contentType.includes('application/octet-stream')) {
        const buffer = Buffer.from(await upstreamResp.arrayBuffer());
        const audioResponse = this.normalizeOpenRouterGeminiTtsAudioResponse(route, payload, contentType, buffer);
        const responseHeaders = this.aiUpstreamClient.filterResponseHeaders(upstreamResp.headers, audioResponse.contentType);
        responseHeaders['content-type'] = audioResponse.contentType;
        if (audioResponse.fileExtension) {
          responseHeaders['content-disposition'] =
            upstreamResp.headers.get('content-disposition') ||
            `inline; filename="openrouter-gemini-tts.${audioResponse.fileExtension}"`;
        }
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage: {},
          latency_ms: Date.now() - startedAt,
        });
        return {
          stream: false,
          binary: true,
          status: upstreamResp.status,
          headers: responseHeaders,
          body: audioResponse.body,
        };
      }

      const raw = await upstreamResp.text();
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
      });
      if (this.isTextLikeUpstreamContentType(contentType)) {
        return {
          stream: false,
          binary: true,
          status: upstreamResp.status,
          headers: this.aiUpstreamClient.filterResponseHeaders(upstreamResp.headers, 'text/plain; charset=utf-8'),
          body: Buffer.from(raw, 'utf8'),
        };
      }
      return {
        stream: false,
        data: {
          raw,
        },
      };
    } finally {
      release?.();
    }
  }

  private normalizeOpenRouterGeminiTtsAudioResponse(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    contentType: string,
    buffer: Buffer,
  ): { body: Buffer; contentType: string; fileExtension?: string } {
    const fallbackContentType = contentType || 'application/octet-stream';
    const responseFormat = (
      this.stringOrUndefined(payload.response_format) ||
      this.stringOrUndefined(payload.format) ||
      ''
    ).toLowerCase();
    const shouldWrapPcm = this.isOpenRouterGeminiTtsRoute(route)
      && responseFormat === 'pcm'
      && (
        fallbackContentType.includes('pcm') ||
        fallbackContentType.includes('application/octet-stream')
      );
    if (!shouldWrapPcm) {
      return {
        body: buffer,
        contentType: fallbackContentType,
      };
    }

    const sampleRate = this.resolveGoogleTtsSampleRate(payload);
    const channels = this.resolveGoogleTtsChannels(payload);
    return {
      body: this.wrapPcm16AsWav(buffer, sampleRate, channels),
      contentType: 'audio/wav',
      fileExtension: 'wav',
    };
  }

  private isTextLikeUpstreamContentType(contentType: string): boolean {
    const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
    return normalized.startsWith('text/')
      || normalized === 'application/srt'
      || normalized === 'application/x-subrip'
      || normalized === 'application/vtt'
      || normalized === 'application/webvtt';
  }

  private resolveOfficialOpenAiSdkErrorMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return this.resolveAiSdkErrorMessage(error);
    }
    const anyErr = error as Record<string, unknown>;
    if (anyErr.error && typeof anyErr.error === 'object') {
      try {
        return JSON.stringify(anyErr.error);
      } catch {
        // ignore
      }
    }
    if (anyErr.body && typeof anyErr.body === 'object') {
      try {
        return JSON.stringify(anyErr.body);
      } catch {
        // ignore
      }
    }
    return this.resolveAiSdkErrorMessage(error);
  }

  private buildMultipartForm(payload: Record<string, unknown>, multipart: MultipartInstruction): FormData {
    const form = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
      if (key === '__multipart' || value === undefined || value === null) {
        return;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        form.append(key, String(value));
        return;
      }
      form.append(key, JSON.stringify(value));
    });

    const fileBase64 = this.stringOrUndefined(multipart.file_base64);
    if (fileBase64) {
      const parsedDataUrl = this.parseDataUrl(fileBase64);
      const normalizedBase64 = parsedDataUrl ? parsedDataUrl.base64 : fileBase64.replace(/\s+/g, '');
      const fileBuffer = Buffer.from(normalizedBase64, 'base64');
      const fileFieldName = this.stringOrUndefined(multipart.file_field_name) || 'file';
      const fileName = this.stringOrUndefined(multipart.file_name) || 'audio.wav';
      const fileMimeType = this.stringOrUndefined(multipart.file_mime_type) || parsedDataUrl?.mimeType || 'application/octet-stream';
      const fileBlob = new Blob([fileBuffer], { type: fileMimeType });
      form.append(fileFieldName, fileBlob, fileName);
    }

    return form;
  }

  private async dispatchUpstreamRequest(
    route: ResolvedAiRoute,
    sender: (endpointUrl: string) => Promise<Response>,
  ): Promise<UpstreamDispatchResult> {
    const endpointCandidates = this.resolveUpstreamEndpointCandidates(route);
    const attemptedEndpoints: string[] = [];
    let lastResponse: Response | null = null;

    for (let i = 0; i < endpointCandidates.length; i += 1) {
      const endpointPath = endpointCandidates[i];
      const endpointUrl = this.joinUrl(route.source.base_url, endpointPath);
      attemptedEndpoints.push(endpointUrl);

      const response = await sender(endpointUrl);
      if (response.ok) {
        return {
          response,
          attemptedEndpoints,
        };
      }

      lastResponse = response;
      if (!this.shouldRetryWithFallbackEndpoint(route, response.status, i, endpointCandidates.length)) {
        return {
          response,
          attemptedEndpoints,
        };
      }

      const errorPreview = this.truncate(await this.aiUpstreamClient.readText(response), 240);
      this.logger.warn(
        `AI upstream fallback retry capability=${route.capability} model=${route.model_key} source=${route.source.name} status=${response.status} endpoint=${endpointPath} body=${errorPreview}`,
      );
    }

    if (!lastResponse) {
      throw new BadGatewayException('AI upstream request failed without response');
    }

    return {
      response: lastResponse,
      attemptedEndpoints,
    };
  }

  private resolveUpstreamEndpointCandidates(route: ResolvedAiRoute): string[] {
    const primaryEndpoint = this.normalizeEndpointPath(route.endpoint_path || '/chat/completions');
    const shouldUseDashscopeImageFallback =
      route.capability === 'image'
      && this.isDashscopeSource(route.source.provider_type, route.source.base_url);
    if (!shouldUseDashscopeImageFallback) {
      return [primaryEndpoint];
    }

    const extra = DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS
      .map((item) => this.normalizeEndpointPath(item))
      .filter((item) => item !== primaryEndpoint);
    return [primaryEndpoint, ...extra];
  }

  private shouldRetryWithFallbackEndpoint(
    route: ResolvedAiRoute,
    status: number,
    attemptIndex: number,
    totalAttempts: number,
  ): boolean {
    if (attemptIndex >= totalAttempts - 1) {
      return false;
    }
    const isDashscopeImage =
      route.capability === 'image'
      && this.isDashscopeSource(route.source.provider_type, route.source.base_url);
    if (!isDashscopeImage) {
      return false;
    }
    return status === 404 || status === 405;
  }

  private buildAttemptedEndpointsSuffix(attemptedEndpoints: string[]): string {
    if (attemptedEndpoints.length <= 1) {
      return '';
    }
    return ` attempted endpoints: ${attemptedEndpoints.join(', ')}`;
  }

  private shouldUseDashscopeNative(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'image' && route.capability !== 'stt' && route.capability !== 'video') {
      return false;
    }
    if (this.shouldUseAliyunIceVideoTranslation(route)) {
      return false;
    }
    if (this.isDashscopeNativeApiType(route.api_type)) {
      return true;
    }
    if (this.isDashscopeNativeEndpointPath(route.endpoint_path || '')) {
      return true;
    }
    if (!this.isDashscopeSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }

    // DashScope sources always use native protocol for stt/image.
    return true;
  }

  private shouldUseAliyunIceVideoTranslation(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'video') {
      return false;
    }
    const apiType = this.normalizeApiType(String(route.api_type || ''));
    const providerType = this.normalizeApiType(route.source.provider_type);
    return apiType === ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE
      || providerType === ALIYUN_ICE_PROVIDER_TYPE;
  }

  private shouldUseDashscopeCompatibleStt(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'stt' || !this.isDashscopeSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }
    const model = `${route.model_key || ''} ${route.upstream_model || ''}`.toLowerCase();
    return model.includes('qwen3-asr-flash') && !model.includes('filetrans');
  }

  private shouldUseRunningHub(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'image' && route.capability !== 'video') {
      return false;
    }
    if (isRunningHubTaskApiType(route.api_type)) {
      return true;
    }
    return isRunningHubSource(route.source.provider_type, route.source.base_url);
  }

  private async forwardRunningHubImage(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const schema = resolveRunningHubSchema(route.request_overrides, route.endpoint_path);
    let taskId: string | null = null;
    const reservation = await this.reserveSyncImagePoints(route, payload, context);
    try {
      const normalizedInput = await this.normalizeRunningHubImageInput(route, payload, schema, context);
      const submitPath = this.resolveRunningHubSubmitPath(route, schema, normalizedInput.input_kind);
      const submitUrl = this.joinUrl(route.source.base_url, submitPath);
      const requestBody = this.buildRunningHubImageRequestPayload(schema, normalizedInput);
      const submitData = await this.fetchRunningHubJson(route, submitUrl, requestBody, context);
      taskId = extractRunningHubTaskId(submitData);
      if (!taskId) {
        const submitError = extractRunningHubTaskErrorMessage(submitData) || this.truncate(JSON.stringify(submitData), 500);
        throw new BadGatewayException(
          `RunningHub submit 响应未返回 taskId: ${submitError}`,
        );
      }
      if (reservation) {
        await this.aiPointsService.attachReservationTask({
          app_id: route.app_id,
          user_id: reservation.user_id,
          reservation_key: reservation.reservation_key,
          external_task_id: taskId,
          usage_reference_id: this.buildAiUsageReferenceId(route, taskId),
          metadata: {
            request_id: taskId,
          },
        });
      }

      const initialStatus = extractRunningHubTaskStatus(submitData);
      let finalData = submitData;
      if (!initialStatus || !isRunningHubTaskTerminalSuccess(initialStatus)) {
        if (initialStatus && isRunningHubTaskTerminalFailure(initialStatus)) {
          const errorMessage = extractRunningHubTaskErrorMessage(submitData) || `task_status=${initialStatus}`;
          throw new BadGatewayException(`RunningHub task failed: ${errorMessage}`);
        }
        finalData = await this.pollRunningHubTask(route, taskId, {
          ...schema,
          poll_timeout_ms: Math.min(schema.poll_timeout_ms, RUNNINGHUB_SYNC_IMAGE_POLL_TIMEOUT_MS),
        });
      }

      const imageUrls = extractRunningHubResultUrls(finalData);
      if (imageUrls.length === 0) {
        throw new BadGatewayException(
          `RunningHub task completed but returned no image url: ${this.truncate(JSON.stringify(finalData), 900)}`,
        );
      }

      const usage: AiUsageMetrics = {
        ...this.extractUsageMetrics(finalData),
        image_count: imageUrls.length,
        request_id: taskId,
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: taskId,
        latency_ms: Date.now() - startedAt,
        billable: reservation ? false : undefined,
      });
      if (reservation) {
        const usageReferenceId = this.buildAiUsageReferenceId(route, taskId);
        const billing = this.resolveBillingMetrics(route, payload, {
          prompt_tokens: usage.prompt_tokens ?? null,
          completion_tokens: usage.completion_tokens ?? null,
          total_tokens: usage.total_tokens ?? null,
          uncached_input_tokens: usage.uncached_input_tokens ?? null,
          cached_input_tokens: usage.cached_input_tokens ?? null,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
          cache_creation_5m_input_tokens: usage.cache_creation_5m_input_tokens ?? null,
          cache_creation_1h_input_tokens: usage.cache_creation_1h_input_tokens ?? null,
          duration_seconds: usage.duration_seconds ?? null,
          image_count: usage.image_count ?? null,
          video_resolution: usage.video_resolution ?? null,
        }, 'actual');
        const settings = await this.aiPointsService.getSettingsByAppId(route.app_id);
        const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
        const pointCharge = this.resolvePointsCharge(route, billing, pointsPerYuan);
        await this.aiPointsService.settleReservation({
          app_id: route.app_id,
          user_id: reservation.user_id,
          external_task_id: taskId,
          success: true,
          settled_points: pointCharge.points,
          usage_reference_id: usageReferenceId,
          request_id: taskId,
          metadata: {
            model_id: route.model_id,
            model_key: route.model_key,
            upstream_model: route.upstream_model,
            capability: route.capability,
            billed_units: billing.billed_units,
            billed_unit_label: billing.billed_unit_label,
            estimated_cost_rmb: billing.estimated_cost_rmb,
            points_pricing_source: pointCharge.source,
            points_per_yuan: pointsPerYuan,
            request_path: context.request_path || '',
          },
        });
        await this.aiRoutingService.updateUsagePointsSettlement({
          usage_reference_id: usageReferenceId,
          points_cost: pointCharge.points,
          points_pricing_source: pointCharge.source,
        });
      }
      return {
        stream: false,
        data: {
          created: Math.floor(Date.now() / 1000),
          data: imageUrls.map((url) => ({ url })),
        },
      };
    } catch (error: any) {
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        request_id: taskId,
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(this.normalizeRunningHubSyncImageErrorMessage(error, taskId), 900),
        billable: reservation ? false : undefined,
      });
      if (reservation) {
        await this.releaseSyncImageReservation(route, reservation, taskId, context, error);
      }
      throw error;
    }
  }

  private async forwardRunningHubVideo(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const schema = resolveRunningHubSchema(route.request_overrides, route.endpoint_path);
    let taskId: string | null = null;
    try {
      const normalizedInput = await this.normalizeRunningHubVideoInput(route, payload, schema, context);
      const submitPath = this.resolveRunningHubSubmitPath(route, schema, normalizedInput.input_kind);
      const submitUrl = this.joinUrl(route.source.base_url, submitPath);
      const requestBody = this.buildRunningHubVideoRequestPayload(schema, normalizedInput);
      const submitData = await this.fetchRunningHubJson(route, submitUrl, requestBody, context);
      taskId = extractRunningHubTaskId(submitData);
      if (!taskId) {
        const submitError = extractRunningHubTaskErrorMessage(submitData) || this.truncate(JSON.stringify(submitData), 500);
        throw new BadGatewayException(`RunningHub submit 响应未返回 taskId: ${submitError}`);
      }

      const initialStatus = extractRunningHubTaskStatus(submitData);
      let finalData = submitData;
      if (!initialStatus || !isRunningHubTaskTerminalSuccess(initialStatus)) {
        if (initialStatus && isRunningHubTaskTerminalFailure(initialStatus)) {
          const errorMessage = extractRunningHubTaskErrorMessage(submitData) || `task_status=${initialStatus}`;
          throw new BadGatewayException(`RunningHub task failed: ${errorMessage}`);
        }
        finalData = await this.pollRunningHubTask(route, taskId, {
          ...schema,
          poll_timeout_ms: RUNNINGHUB_VIDEO_POLL_TIMEOUT_MS,
        });
      }

      const videoUrls = extractRunningHubResultUrls(finalData);
      if (videoUrls.length === 0) {
        throw new BadGatewayException(
          `RunningHub task completed but returned no video url: ${this.truncate(JSON.stringify(finalData), 900)}`,
        );
      }

      const usage: AiUsageMetrics = {
        ...this.extractUsageMetrics(finalData),
        duration_seconds: this.extractRunningHubVideoDurationSeconds(finalData)
          ?? this.resolveDurationSecondsFromPayload(payload),
        video_resolution: this.extractVideoResolutionFromData(finalData)
          || normalizedInput.resolution?.toUpperCase()
          || null,
        request_id: taskId,
      };
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: taskId,
        latency_ms: Date.now() - startedAt,
      });

      return {
        stream: false,
        data: await this.buildRunningHubVideoTaskResponseWithProxy(route, finalData, {
          includeVideoUrls: true,
          fallbackTaskId: taskId,
          proxyWaitTimeoutMs: 120_000,
        }),
      };
    } catch (error: any) {
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        request_id: taskId,
        latency_ms: Date.now() - startedAt,
        error_message: this.truncate(String(error?.message || 'unknown error'), 900),
      });
      throw error;
    }
  }

  private async forwardRunningHubVideoAsync(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const schema = resolveRunningHubSchema(route.request_overrides, route.endpoint_path);
    const normalizedInput = await this.normalizeRunningHubVideoInput(route, payload, schema, context);
    const submitPath = this.resolveRunningHubSubmitPath(route, schema, normalizedInput.input_kind);
    const submitUrl = this.joinUrl(route.source.base_url, submitPath);
    const requestBody = this.buildRunningHubVideoRequestPayload(schema, normalizedInput);
    const submitData = await this.fetchRunningHubJson(route, submitUrl, requestBody, context);
    const taskId = extractRunningHubTaskId(submitData);
    if (!taskId) {
      const submitError = extractRunningHubTaskErrorMessage(submitData) || this.truncate(JSON.stringify(submitData), 500);
      throw new BadGatewayException(`RunningHub async video accepted but no taskId returned: ${submitError}`);
    }
    return {
      stream: false,
      data: this.buildRunningHubVideoTaskResponse(submitData, {
        includeVideoUrls: false,
        fallbackTaskId: taskId,
      }),
    };
  }

  private normalizeRunningHubSyncImageErrorMessage(error: unknown, taskId: string | null): string {
    const rawMessage = String((error as any)?.message || 'unknown error');
    const taskSuffix = taskId ? ` task_id=${taskId}` : '';
    const normalized = rawMessage.toLowerCase();
    if (normalized.includes('aborted') || normalized.includes('client closed') || normalized.includes('user aborted')) {
      return `RunningHub image request aborted before task completed.${taskSuffix} upstream_message=${rawMessage}`;
    }
    if (normalized.includes('polling timeout')) {
      return `RunningHub image task polling timeout.${taskSuffix} upstream_message=${rawMessage}`;
    }
    return taskSuffix ? `${rawMessage}${taskSuffix}` : rawMessage;
  }

  private async normalizeRunningHubImageInput(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    schema: ReturnType<typeof resolveRunningHubSchema>,
    context: AiInvocationContext,
  ): Promise<{
    prompt: string;
    input_kind: 'text-to-image' | 'image-to-image';
    input_images: string[];
    quality: string | null;
    resolution: string | null;
    aspect_ratio: string | null;
    output_format: string | null;
    webhook_url: string | null;
  }> {
    const prompt =
      this.stringOrUndefined(payload.prompt)
      || this.stringOrUndefined(this.normalizeObject(payload.input).prompt)
      || this.normalizePromptToText(payload.input)
      || this.normalizePromptToText(payload.messages)
      || this.normalizePromptToText(payload.content)
      || '';
    if (!prompt) {
      throw new BadRequestException('RunningHub 图片请求缺少 prompt');
    }

    const rawImages = this.collectRunningHubImageInputs(payload);
    const inputImages: string[] = [];
    const maxUploadBytes = this.resolveRunningHubMaxUploadBytes(schema);
    for (const rawImage of rawImages) {
      const uploaded = await this.uploadRunningHubAssetIfNeeded(route, rawImage, schema.upload_path, context, {
        kind: 'image',
        keyHint: 'image',
        maxBytes: maxUploadBytes,
      });
      if (uploaded && !inputImages.includes(uploaded)) {
        inputImages.push(uploaded);
      }
    }

    if (inputImages.length > schema.max_input_images) {
      throw new BadRequestException(`RunningHub 输入图片最多支持 ${schema.max_input_images} 张`);
    }
    const rawInputKind = schema.input_kind === 'auto'
      ? (inputImages.length > 0 ? 'image-to-image' : 'text-to-image')
      : schema.input_kind;
    if (rawInputKind !== 'text-to-image' && rawInputKind !== 'image-to-image') {
      throw new BadRequestException(`RunningHub 图片请求不支持 input_kind=${rawInputKind}`);
    }
    const resolvedInputKind = rawInputKind;
    if (resolvedInputKind === 'image-to-image' && inputImages.length === 0) {
      throw new BadRequestException('RunningHub 图生图模型需要至少一张输入图片');
    }

    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    const quality =
      this.stringOrUndefined(payload.quality)
      || this.stringOrUndefined(inputObject.quality)
      || this.stringOrUndefined(parameters.quality)
      || null;
    const aspectRatio =
      this.stringOrUndefined(payload.aspect_ratio)
      || this.stringOrUndefined(payload.aspectRatio)
      || this.stringOrUndefined(payload.ratio)
      || this.stringOrUndefined(inputObject.aspect_ratio)
      || this.stringOrUndefined(inputObject.aspectRatio)
      || this.stringOrUndefined(inputObject.ratio)
      || this.stringOrUndefined(parameters.aspect_ratio)
      || this.stringOrUndefined(parameters.aspectRatio)
      || this.stringOrUndefined(parameters.ratio)
      || null;
    const explicitResolution =
      this.stringOrUndefined(payload.resolution)
      || this.stringOrUndefined(payload.image_size)
      || this.stringOrUndefined(payload.imageSize)
      || this.stringOrUndefined(inputObject.resolution)
      || this.stringOrUndefined(inputObject.image_size)
      || this.stringOrUndefined(inputObject.imageSize)
      || this.stringOrUndefined(parameters.resolution)
      || this.stringOrUndefined(parameters.image_size)
      || this.stringOrUndefined(parameters.imageSize)
      || null;
    const fromOpenAiSize = this.mapOpenAiSizeToRunningHubImageConfig(this.stringOrUndefined(payload.size));
    const outputFormat =
      this.stringOrUndefined(payload.output_format)
      || this.stringOrUndefined(payload.format)
      || this.stringOrUndefined(inputObject.output_format)
      || this.stringOrUndefined(inputObject.format)
      || null;
    const webhookUrl =
      this.stringOrUndefined(payload.webhook_url)
      || this.stringOrUndefined(payload.webhookUrl)
      || this.stringOrUndefined(inputObject.webhook_url)
      || this.stringOrUndefined(inputObject.webhookUrl)
      || null;

    return {
      prompt,
      input_kind: resolvedInputKind,
      input_images: inputImages,
      quality: this.normalizeRunningHubQuality(quality),
      resolution: this.normalizeRunningHubResolution(explicitResolution || fromOpenAiSize.imageSize || null),
      aspect_ratio: this.normalizeRunningHubAspectRatio(aspectRatio || fromOpenAiSize.aspectRatio || null),
      output_format: outputFormat,
      webhook_url: webhookUrl,
    };
  }

  private buildRunningHubImageRequestPayload(
    schema: ReturnType<typeof resolveRunningHubSchema>,
    input: {
      prompt: string;
      input_kind: 'text-to-image' | 'image-to-image';
      input_images: string[];
      quality: string | null;
      resolution: string | null;
      aspect_ratio: string | null;
      output_format: string | null;
      webhook_url: string | null;
    },
  ): Record<string, unknown> {
    const fieldMap = {
      prompt: 'prompt',
      input_images: 'imageUrls',
      quality: 'quality',
      resolution: 'resolution',
      aspect_ratio: 'aspectRatio',
      output_format: 'outputFormat',
      webhook_url: 'webhookUrl',
      ...schema.field_map,
    };
    const body: Record<string, unknown> = {
      ...schema.defaults,
    };
    const assignMapped = (key: string, value: unknown) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      const targetKey = fieldMap[key] || key;
      body[targetKey] = value;
    };
    const assignDefaultIfBlank = (key: string, value: unknown) => {
      const targetKey = fieldMap[key] || key;
      if (body[targetKey] === undefined || body[targetKey] === null || body[targetKey] === '') {
        body[targetKey] = value;
      }
    };

    assignMapped('prompt', input.prompt);
    if (input.input_kind === 'image-to-image') {
      assignMapped('input_images', input.input_images);
    }
    if (input.quality) {
      assignMapped('quality', input.quality);
    }
    if (input.resolution) {
      assignMapped('resolution', input.resolution);
    }
    if (input.aspect_ratio) {
      assignMapped('aspect_ratio', input.aspect_ratio);
    }
    if (input.output_format) {
      assignMapped('output_format', input.output_format);
    }
    if (input.webhook_url) {
      assignMapped('webhook_url', input.webhook_url);
    }
    assignDefaultIfBlank('quality', 'low');
    assignDefaultIfBlank('resolution', '1k');
    return body;
  }

  private async normalizeRunningHubVideoInput(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    schema: ReturnType<typeof resolveRunningHubSchema>,
    context: AiInvocationContext,
  ): Promise<{
    prompt: string;
    input_kind: 'text-to-video' | 'image-to-video' | 'reference-to-video';
    first_frame_url: string | null;
    last_frame_url: string | null;
    reference_images: string[];
    reference_videos: string[];
    reference_audios: string[];
    reference_audios_explicit: boolean;
    resolution: string | null;
    duration: string | null;
    generate_audio: boolean | null;
    ratio: string | null;
    web_search: boolean | null;
    return_last_frame: boolean | null;
    real_person_mode: boolean | null;
    conversion_slots: string[] | null;
    seed: number | null;
    webhook_url: string | null;
  }> {
    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    const maxUploadBytes = this.resolveRunningHubMaxUploadBytes(schema);
    const prompt =
      this.stringOrUndefined(payload.prompt)
      || this.stringOrUndefined(inputObject.prompt)
      || this.stringOrUndefined(parameters.prompt)
      || this.normalizePromptToText(payload.input)
      || this.normalizePromptToText(payload.messages)
      || this.normalizePromptToText(payload.content)
      || '';

    const frameInputs = this.collectRunningHubVideoFrameInputs(payload);
    const firstFrameRaw = this.pickFirstString(
      payload.firstFrameUrl,
      payload.first_frame_url,
      payload.first_frame,
      inputObject.firstFrameUrl,
      inputObject.first_frame_url,
      inputObject.first_frame,
      parameters.firstFrameUrl,
      parameters.first_frame_url,
      parameters.first_frame,
    ) || frameInputs[0] || null;
    const lastFrameRaw = this.pickFirstString(
      payload.lastFrameUrl,
      payload.last_frame_url,
      payload.last_frame,
      inputObject.lastFrameUrl,
      inputObject.last_frame_url,
      inputObject.last_frame,
      parameters.lastFrameUrl,
      parameters.last_frame_url,
      parameters.last_frame,
    );
    const firstFrameUrl = firstFrameRaw
      ? await this.uploadRunningHubAssetIfNeeded(route, firstFrameRaw, schema.upload_path, context, {
        kind: 'image',
        keyHint: 'first_frame',
        maxBytes: maxUploadBytes,
      })
      : null;
    const lastFrameUrl = lastFrameRaw
      ? await this.uploadRunningHubAssetIfNeeded(route, lastFrameRaw, schema.upload_path, context, {
        kind: 'image',
        keyHint: 'last_frame',
        maxBytes: maxUploadBytes,
      })
      : null;

    const referenceImages: string[] = [];
    const rawReferenceImages = this.collectRunningHubVideoReferenceImageInputs(payload);
    if (schema.input_kind === 'reference-to-video' && rawReferenceImages.length === 0) {
      rawReferenceImages.push(...frameInputs);
    }
    for (const rawImage of rawReferenceImages) {
      const uploaded = await this.uploadRunningHubAssetIfNeeded(route, rawImage, schema.upload_path, context, {
        kind: 'image',
        keyHint: 'reference_image',
        maxBytes: maxUploadBytes,
      });
      if (uploaded && !referenceImages.includes(uploaded)) {
        referenceImages.push(uploaded);
      }
    }
    const referenceVideos: string[] = [];
    for (const rawVideo of this.collectRunningHubVideoReferenceVideoInputs(payload)) {
      const uploaded = await this.uploadRunningHubAssetIfNeeded(route, rawVideo, schema.upload_path, context, {
        kind: 'video',
        keyHint: 'reference_video',
        maxBytes: maxUploadBytes,
      });
      if (uploaded && !referenceVideos.includes(uploaded)) {
        referenceVideos.push(uploaded);
      }
    }
    const referenceAudios: string[] = [];
    for (const rawAudio of this.collectRunningHubVideoReferenceAudioInputs(payload)) {
      const uploaded = await this.uploadRunningHubAssetIfNeeded(route, rawAudio, schema.upload_path, context, {
        kind: 'audio',
        keyHint: 'reference_audio',
        maxBytes: maxUploadBytes,
      });
      if (uploaded && !referenceAudios.includes(uploaded)) {
        referenceAudios.push(uploaded);
      }
    }
    const referenceAudiosExplicit = this.hasRunningHubVideoReferenceAudioInput(payload);

    const rawInputKind = schema.input_kind === 'auto'
      ? (referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0
        ? 'reference-to-video'
        : (firstFrameUrl || lastFrameUrl ? 'image-to-video' : 'text-to-video'))
      : schema.input_kind;
    if (
      rawInputKind !== 'text-to-video'
      && rawInputKind !== 'image-to-video'
      && rawInputKind !== 'reference-to-video'
    ) {
      throw new BadRequestException(`RunningHub 视频请求不支持 input_kind=${rawInputKind}`);
    }
    const resolvedInputKind = rawInputKind;
    if (resolvedInputKind === 'text-to-video' && !prompt) {
      throw new BadRequestException('RunningHub 文生视频请求缺少 prompt');
    }
    if (resolvedInputKind === 'image-to-video' && !firstFrameUrl) {
      throw new BadRequestException('RunningHub 图生视频模型需要首帧图片');
    }
    if (
      resolvedInputKind === 'reference-to-video'
      && referenceImages.length === 0
      && referenceVideos.length === 0
      && referenceAudios.length === 0
    ) {
      throw new BadRequestException('RunningHub 参考生视频模型需要参考素材');
    }

    const resolution =
      this.pickFirstString(payload.resolution, payload.size, inputObject.resolution, inputObject.size)
      || this.pickFirstString(parameters.resolution, parameters.size)
      || null;
    const duration = this.pickNumber(
      payload.duration,
      payload.seconds,
      payload.duration_seconds,
      payload.video_duration_seconds,
      inputObject.duration,
      inputObject.seconds,
      inputObject.duration_seconds,
      inputObject.video_duration_seconds,
      parameters.duration,
      parameters.seconds,
      parameters.duration_seconds,
      parameters.video_duration_seconds,
    );
    const ratio =
      this.pickFirstString(payload.ratio, payload.aspect_ratio, payload.aspectRatio, inputObject.ratio, inputObject.aspect_ratio, inputObject.aspectRatio)
      || this.pickFirstString(parameters.ratio, parameters.aspect_ratio, parameters.aspectRatio)
      || null;

    return {
      prompt,
      input_kind: resolvedInputKind,
      first_frame_url: firstFrameUrl,
      last_frame_url: lastFrameUrl,
      reference_images: referenceImages,
      reference_videos: referenceVideos,
      reference_audios: referenceAudios,
      reference_audios_explicit: referenceAudiosExplicit,
      resolution: this.normalizeRunningHubVideoResolution(resolution),
      duration: this.normalizeRunningHubVideoDuration(duration),
      generate_audio: this.booleanOrNull(
        payload.generateAudio
        ?? payload.generate_audio
        ?? inputObject.generateAudio
        ?? inputObject.generate_audio
        ?? parameters.generateAudio
        ?? parameters.generate_audio,
      ),
      ratio: this.normalizeRunningHubVideoRatio(ratio),
      web_search: this.booleanOrNull(
        payload.webSearch ?? payload.web_search ?? inputObject.webSearch ?? inputObject.web_search ?? parameters.webSearch ?? parameters.web_search,
      ),
      return_last_frame: this.booleanOrNull(
        payload.returnLastFrame
        ?? payload.return_last_frame
        ?? inputObject.returnLastFrame
        ?? inputObject.return_last_frame
        ?? parameters.returnLastFrame
        ?? parameters.return_last_frame,
      ),
      real_person_mode: this.booleanOrNull(
        payload.realPersonMode
        ?? payload.real_person_mode
        ?? inputObject.realPersonMode
        ?? inputObject.real_person_mode
        ?? parameters.realPersonMode
        ?? parameters.real_person_mode,
      ),
      conversion_slots: this.normalizeRunningHubConversionSlots(
        payload.conversionSlots
        ?? payload.conversion_slots
        ?? inputObject.conversionSlots
        ?? inputObject.conversion_slots
        ?? parameters.conversionSlots
        ?? parameters.conversion_slots,
      ),
      seed: this.pickNumber(payload.seed, inputObject.seed, parameters.seed),
      webhook_url: this.stringOrUndefined(payload.webhook_url)
        || this.stringOrUndefined(payload.webhookUrl)
        || this.stringOrUndefined(inputObject.webhook_url)
        || this.stringOrUndefined(inputObject.webhookUrl)
        || this.stringOrUndefined(parameters.webhook_url)
        || this.stringOrUndefined(parameters.webhookUrl)
        || null,
    };
  }

  private buildRunningHubVideoRequestPayload(
    schema: ReturnType<typeof resolveRunningHubSchema>,
    input: {
      prompt: string;
      input_kind: 'text-to-video' | 'image-to-video' | 'reference-to-video';
      first_frame_url: string | null;
      last_frame_url: string | null;
      reference_images: string[];
      reference_videos: string[];
      reference_audios: string[];
      reference_audios_explicit: boolean;
      resolution: string | null;
      duration: string | null;
      generate_audio: boolean | null;
      ratio: string | null;
      web_search: boolean | null;
      return_last_frame: boolean | null;
      real_person_mode: boolean | null;
      conversion_slots: string[] | null;
      seed: number | null;
      webhook_url: string | null;
    },
  ): Record<string, unknown> {
    const fieldMap = {
      prompt: 'prompt',
      resolution: 'resolution',
      duration: 'duration',
      generate_audio: 'generateAudio',
      ratio: 'ratio',
      web_search: 'webSearch',
      return_last_frame: 'returnLastFrame',
      first_frame_url: 'firstFrameUrl',
      last_frame_url: 'lastFrameUrl',
      real_person_mode: 'realPersonMode',
      conversion_slots: 'conversionSlots',
      reference_images: 'imageUrls',
      reference_videos: 'videoUrls',
      reference_audios: 'audioUrls',
      seed: 'seed',
      webhook_url: 'webhookUrl',
      ...schema.field_map,
    };
    const body: Record<string, unknown> = {
      ...schema.defaults,
    };
    const assignMapped = (key: string, value: unknown) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      if (Array.isArray(value) && value.length === 0) {
        return;
      }
      const targetKey = fieldMap[key] || key;
      body[targetKey] = value;
    };
    const assignDefaultIfBlank = (key: string, value: unknown) => {
      const targetKey = fieldMap[key] || key;
      if (body[targetKey] === undefined || body[targetKey] === null || body[targetKey] === '') {
        body[targetKey] = value;
      }
    };

    assignMapped('prompt', input.prompt);
    assignMapped('resolution', input.resolution);
    assignMapped('duration', input.duration);
    assignDefaultIfBlank('duration', '5');
    assignMapped('generate_audio', input.generate_audio);
    assignMapped('ratio', input.ratio);
    assignMapped('web_search', input.web_search);
    assignMapped('return_last_frame', input.return_last_frame);
    assignMapped('seed', input.seed);
    assignMapped('webhook_url', input.webhook_url);
    if (input.input_kind === 'image-to-video') {
      assignMapped('first_frame_url', input.first_frame_url);
      assignMapped('last_frame_url', input.last_frame_url);
      assignMapped('real_person_mode', input.real_person_mode);
      assignMapped('conversion_slots', input.conversion_slots);
    }
    if (input.input_kind === 'reference-to-video') {
      assignMapped('reference_images', input.reference_images);
      assignMapped('reference_videos', input.reference_videos);
      if (input.reference_audios.length > 0) {
        assignMapped('reference_audios', input.reference_audios);
      } else if (input.reference_audios_explicit) {
        body[fieldMap.reference_audios] = [];
      }
      assignMapped('real_person_mode', input.real_person_mode);
      assignMapped('conversion_slots', input.conversion_slots);
    }
    return body;
  }

  private resolveRunningHubSubmitPath(
    route: ResolvedAiRoute,
    schema: ReturnType<typeof resolveRunningHubSchema>,
    inputKind: 'text-to-image' | 'image-to-image' | 'text-to-video' | 'image-to-video' | 'reference-to-video',
  ): string {
    if (isRunningHubKnownSubmitPath(schema.submit_path)) {
      return schema.submit_path;
    }
    const submitPath = resolveRunningHubSubmitPathForInput(
      schema.submit_path || route.endpoint_path || resolveRunningHubModelRootPath('', route.upstream_model),
      route.upstream_model,
      inputKind,
      schema.submit_action,
    );
    if (!submitPath) {
      throw new BadRequestException('RunningHub 模型缺少模型名或 submit_path，无法自动生成 submit 路径');
    }
    return submitPath;
  }

  private resolveRunningHubMaxUploadBytes(schema: ReturnType<typeof resolveRunningHubSchema>): number {
    const limits = this.normalizeObject(schema.limits);
    const raw =
      limits.max_upload_bytes
      ?? limits.max_asset_bytes
      ?? limits.max_file_bytes
      ?? limits.max_upload_size_bytes;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return RUNNINGHUB_DEFAULT_MAX_UPLOAD_BYTES;
    }
    return Math.max(1, Math.round(parsed));
  }

  private async uploadRunningHubAssetIfNeeded(
    route: ResolvedAiRoute,
    rawAsset: string,
    uploadPath: string,
    context: AiInvocationContext,
    options: {
      kind?: RunningHubUploadAssetKind;
      keyHint?: string;
      maxBytes?: number;
    } = {},
  ): Promise<string | null> {
    const text = this.stringOrUndefined(rawAsset);
    if (!text) {
      return null;
    }
    if (/^https?:\/\//i.test(text)) {
      return text;
    }

    const parsedDataUrl = this.parseDataUrl(text);
    const normalizedBase64 = parsedDataUrl
      ? parsedDataUrl.base64
      : this.isLikelyBase64(text.replace(/\s+/g, ''))
        ? text.replace(/\s+/g, '')
        : '';
    if (!normalizedBase64) {
      throw new BadRequestException(
        `RunningHub ${this.runningHubAssetKindLabel(options.kind)}输入必须是公网 URL、data URL 或 base64`,
      );
    }

    const mimeType = parsedDataUrl?.mimeType || this.inferRunningHubUploadMimeType(
      normalizedBase64,
      options.kind || 'image',
      options.keyHint,
    );
    const extension = this.extensionByMimeType(mimeType);
    const endpointUrl = this.joinUrl(route.source.base_url, uploadPath || RUNNINGHUB_DEFAULT_UPLOAD_PATH);
    const fileBuffer = Buffer.from(normalizedBase64, 'base64');
    const maxBytes = options.maxBytes || RUNNINGHUB_DEFAULT_MAX_UPLOAD_BYTES;
    if (fileBuffer.length > maxBytes) {
      throw new BadRequestException(
        `RunningHub ${this.runningHubAssetKindLabel(options.kind)}输入不能超过 ${this.formatByteSize(maxBytes)}`,
      );
    }
    const fileName = `runninghub-${this.sanitizeFileName(route.model_key || options.kind || 'asset')}-${options.kind || 'image'}-${Date.now()}${extension}`;
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);

    const response = await this.fetchUpstream(route, endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: form,
    }, context);
    const raw = await response.text();
    const data = this.tryParseJsonObject(raw);
    const uploadedUrl = this.stringOrUndefined(this.normalizeObject(data.data).download_url);
    if (!response.ok || !isRunningHubUploadSuccess(data) || !uploadedUrl) {
      throw new BadGatewayException(
        `RunningHub upload failed (${response.status}): ${this.truncate(this.safeJsonPreview(raw), 400)}`,
      );
    }
    return uploadedUrl;
  }

  private runningHubAssetKindLabel(kind?: RunningHubUploadAssetKind): string {
    if (kind === 'video') return '视频';
    if (kind === 'audio') return '音频';
    return '图片';
  }

  private inferRunningHubUploadMimeType(
    base64Text: string,
    kind: RunningHubUploadAssetKind,
    keyHint?: string,
  ): string {
    if (kind === 'video') {
      return this.inferVideoMimeTypeFromBase64(base64Text, keyHint);
    }
    if (kind === 'audio') {
      return this.inferAudioMimeTypeFromBase64(base64Text, keyHint);
    }
    return this.inferImageMimeTypeFromBase64(base64Text, keyHint);
  }

  private inferVideoMimeTypeFromBase64(base64Text: string, keyHint?: string): string {
    const normalizedKeyHint = String(keyHint || '').trim().toLowerCase();
    if (normalizedKeyHint.includes('webm')) return 'video/webm';
    if (normalizedKeyHint.includes('mov') || normalizedKeyHint.includes('quicktime')) return 'video/quicktime';
    if (normalizedKeyHint.includes('avi')) return 'video/x-msvideo';
    if (normalizedKeyHint.includes('m4v') || normalizedKeyHint.includes('mp4')) return 'video/mp4';
    try {
      const sample = Buffer.from(base64Text.slice(0, 256), 'base64');
      if (
        sample.length >= 4
        && sample[0] === 0x1a
        && sample[1] === 0x45
        && sample[2] === 0xdf
        && sample[3] === 0xa3
      ) {
        return 'video/webm';
      }
      if (sample.length >= 12 && sample.toString('ascii', 4, 8) === 'ftyp') {
        const brand = sample.toString('ascii', 8, 12).toLowerCase();
        return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
      }
      if (sample.length >= 12 && sample.toString('ascii', 0, 4) === 'RIFF' && sample.toString('ascii', 8, 12) === 'AVI ') {
        return 'video/x-msvideo';
      }
    } catch {
      // fallback to mp4
    }
    return 'video/mp4';
  }

  private inferAudioMimeTypeFromBase64(base64Text: string, keyHint?: string): string {
    const normalizedKeyHint = String(keyHint || '').trim().toLowerCase();
    if (normalizedKeyHint.includes('wav')) return 'audio/wav';
    if (normalizedKeyHint.includes('ogg')) return 'audio/ogg';
    if (normalizedKeyHint.includes('flac')) return 'audio/flac';
    if (normalizedKeyHint.includes('m4a') || normalizedKeyHint.includes('mp4')) return 'audio/mp4';
    if (normalizedKeyHint.includes('mp3') || normalizedKeyHint.includes('mpeg')) return 'audio/mpeg';
    try {
      const sample = Buffer.from(base64Text.slice(0, 256), 'base64');
      if (sample.length >= 12 && sample.toString('ascii', 0, 4) === 'RIFF' && sample.toString('ascii', 8, 12) === 'WAVE') {
        return 'audio/wav';
      }
      if (sample.length >= 3 && sample.toString('ascii', 0, 3) === 'ID3') {
        return 'audio/mpeg';
      }
      if (sample.length >= 2 && sample[0] === 0xff && (sample[1] & 0xe0) === 0xe0) {
        return 'audio/mpeg';
      }
      if (sample.length >= 4 && sample.toString('ascii', 0, 4) === 'OggS') {
        return 'audio/ogg';
      }
      if (sample.length >= 4 && sample.toString('ascii', 0, 4) === 'fLaC') {
        return 'audio/flac';
      }
      if (sample.length >= 12 && sample.toString('ascii', 4, 8) === 'ftyp') {
        return 'audio/mp4';
      }
    } catch {
      // fallback to mp3
    }
    return 'audio/mpeg';
  }

  private formatByteSize(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${Math.floor(bytes / 1024 / 1024)}MB`;
    }
    if (bytes >= 1024) {
      return `${Math.floor(bytes / 1024)}KB`;
    }
    return `${bytes}B`;
  }

  private collectRunningHubImageInputs(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushCandidate = (raw: unknown, keyHint?: string) => {
      const normalized = this.normalizeRunningHubImageInputValue(raw, keyHint);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    };

    ['image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url', 'mask']
      .forEach((key) => pushCandidate(payload[key], key));

    const inputObject = this.normalizeObject(payload.input);
    ['image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url', 'mask']
      .forEach((key) => pushCandidate(inputObject[key], key));

    const images = Array.isArray(payload.images) ? payload.images : [];
    images.forEach((item) => {
      if (typeof item === 'string') {
        pushCandidate(item, 'images');
        return;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        pushCandidate(record.image, 'image');
        pushCandidate(record.url, 'url');
        pushCandidate(record.b64_json, 'b64_json');
      }
    });

    const messages = Array.isArray(inputObject.messages) ? inputObject.messages : [];
    messages.forEach((message) => {
      const messageObj = this.normalizeObject(message);
      const content = Array.isArray(messageObj.content) ? messageObj.content : [];
      content.forEach((part) => {
        const partObj = this.normalizeObject(part);
        pushCandidate(partObj.image, 'image');
        pushCandidate(partObj.url, 'url');
        pushCandidate(partObj.b64_json, 'b64_json');
        pushCandidate(partObj.image_url, 'image_url');
      });
    });

    const multipart = this.extractMultipartInstruction(payload);
    if (multipart) {
      pushCandidate(this.stringOrUndefined(multipart.file_base64), 'file_base64');
    }

    return values;
  }

  private collectRunningHubVideoFrameInputs(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushCandidate = (raw: unknown, keyHint?: string) => {
      const normalized = this.normalizeRunningHubImageInputValue(raw, keyHint);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    };

    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    ['image', 'image_url', 'img_url', 'first_frame', 'first_frame_url', 'firstFrameUrl']
      .forEach((key) => pushCandidate(payload[key], key));
    ['image', 'image_url', 'img_url', 'first_frame', 'first_frame_url', 'firstFrameUrl']
      .forEach((key) => pushCandidate(inputObject[key], key));
    ['image', 'image_url', 'img_url', 'first_frame', 'first_frame_url', 'firstFrameUrl']
      .forEach((key) => pushCandidate(parameters[key], key));

    const images = Array.isArray(payload.images) ? payload.images : [];
    const inputImages = Array.isArray(inputObject.images) ? inputObject.images : [];
    const parameterImages = Array.isArray(parameters.images) ? parameters.images : [];
    [...images, ...inputImages, ...parameterImages].forEach((item) => {
      if (typeof item === 'string') {
        pushCandidate(item, 'images');
        return;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        pushCandidate(record.image, 'image');
        pushCandidate(record.url, 'url');
        pushCandidate(record.image_url, 'image_url');
        pushCandidate(record.b64_json, 'b64_json');
      }
    });

    return values;
  }

  private collectRunningHubVideoReferenceImageInputs(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushCandidate = (raw: unknown, keyHint?: string) => {
      const normalized = this.normalizeRunningHubImageInputValue(raw, keyHint);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    };
    const pushArray = (raw: unknown, keyHint: string) => {
      const rows = Array.isArray(raw) ? raw : [];
      rows.forEach((item) => {
        if (typeof item === 'string') {
          pushCandidate(item, keyHint);
          return;
        }
        const row = this.normalizeObject(item);
        pushCandidate(row.url || row.image_url || row.image || row.b64_json || row.base64, keyHint);
      });
    };

    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    ['reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushCandidate(payload[key], key));
    ['reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushCandidate(inputObject[key], key));
    ['reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushCandidate(parameters[key], key));
    pushArray(payload.imageUrls, 'imageUrls');
    pushArray(payload.image_urls, 'image_urls');
    pushArray(payload.reference_images, 'reference_images');
    pushArray(payload.reference_image_urls, 'reference_image_urls');
    pushArray(inputObject.imageUrls, 'imageUrls');
    pushArray(inputObject.image_urls, 'image_urls');
    pushArray(inputObject.reference_images, 'reference_images');
    pushArray(inputObject.reference_image_urls, 'reference_image_urls');
    pushArray(parameters.imageUrls, 'imageUrls');
    pushArray(parameters.image_urls, 'image_urls');
    pushArray(parameters.reference_images, 'reference_images');
    pushArray(parameters.reference_image_urls, 'reference_image_urls');
    return values;
  }

  private collectRunningHubVideoReferenceVideoInputs(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushCandidate = (raw: unknown, keyHint?: string) => {
      const normalized = this.normalizeRunningHubMediaInputValue(raw, 'video', keyHint);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    };
    const pushArray = (raw: unknown, keyHint: string) => {
      const rows = Array.isArray(raw) ? raw : [];
      rows.forEach((item) => {
        if (typeof item === 'string') {
          pushCandidate(item, keyHint);
          return;
        }
        const row = this.normalizeObject(item);
        pushCandidate(row.url || row.file_url || row.video_url || row.video || row.b64_json || row.base64 || row.data, keyHint);
      });
    };

    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    ['reference_video', 'reference_video_url', 'ref_video', 'ref_video_url']
      .forEach((key) => pushCandidate(payload[key], key));
    ['reference_video', 'reference_video_url', 'ref_video', 'ref_video_url']
      .forEach((key) => pushCandidate(inputObject[key], key));
    ['reference_video', 'reference_video_url', 'ref_video', 'ref_video_url']
      .forEach((key) => pushCandidate(parameters[key], key));
    pushArray(payload.videoUrls, 'videoUrls');
    pushArray(payload.video_urls, 'video_urls');
    pushArray(payload.reference_videos, 'reference_videos');
    pushArray(payload.reference_video_urls, 'reference_video_urls');
    pushArray(inputObject.videoUrls, 'videoUrls');
    pushArray(inputObject.video_urls, 'video_urls');
    pushArray(inputObject.reference_videos, 'reference_videos');
    pushArray(inputObject.reference_video_urls, 'reference_video_urls');
    pushArray(parameters.videoUrls, 'videoUrls');
    pushArray(parameters.video_urls, 'video_urls');
    pushArray(parameters.reference_videos, 'reference_videos');
    pushArray(parameters.reference_video_urls, 'reference_video_urls');
    return values;
  }

  private collectRunningHubVideoReferenceAudioInputs(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushCandidate = (raw: unknown, keyHint?: string) => {
      const normalized = this.normalizeRunningHubMediaInputValue(raw, 'audio', keyHint);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    };
    const pushArray = (raw: unknown, keyHint: string) => {
      const rows = Array.isArray(raw) ? raw : [];
      rows.forEach((item) => {
        if (typeof item === 'string') {
          pushCandidate(item, keyHint);
          return;
        }
        const row = this.normalizeObject(item);
        pushCandidate(row.url || row.file_url || row.audio_url || row.audio || row.b64_json || row.base64 || row.data, keyHint);
      });
    };

    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    ['audio', 'audio_url', 'reference_audio', 'reference_audio_url', 'ref_audio', 'ref_audio_url']
      .forEach((key) => pushCandidate(payload[key], key));
    ['audio', 'audio_url', 'reference_audio', 'reference_audio_url', 'ref_audio', 'ref_audio_url']
      .forEach((key) => pushCandidate(inputObject[key], key));
    ['audio', 'audio_url', 'reference_audio', 'reference_audio_url', 'ref_audio', 'ref_audio_url']
      .forEach((key) => pushCandidate(parameters[key], key));
    pushArray(payload.audioUrls, 'audioUrls');
    pushArray(payload.audio_urls, 'audio_urls');
    pushArray(payload.reference_audios, 'reference_audios');
    pushArray(payload.reference_audio_urls, 'reference_audio_urls');
    pushArray(inputObject.audioUrls, 'audioUrls');
    pushArray(inputObject.audio_urls, 'audio_urls');
    pushArray(inputObject.reference_audios, 'reference_audios');
    pushArray(inputObject.reference_audio_urls, 'reference_audio_urls');
    pushArray(parameters.audioUrls, 'audioUrls');
    pushArray(parameters.audio_urls, 'audio_urls');
    pushArray(parameters.reference_audios, 'reference_audios');
    pushArray(parameters.reference_audio_urls, 'reference_audio_urls');
    return values;
  }

  private hasRunningHubVideoReferenceAudioInput(payload: Record<string, unknown>): boolean {
    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    const keys = [
      'audio',
      'audio_url',
      'audioUrls',
      'audio_urls',
      'reference_audio',
      'reference_audio_url',
      'reference_audios',
      'reference_audio_urls',
      'ref_audio',
      'ref_audio_url',
    ];
    return keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key)
      || Object.prototype.hasOwnProperty.call(inputObject, key)
      || Object.prototype.hasOwnProperty.call(parameters, key));
  }

  private normalizeRunningHubImageInputValue(raw: unknown, keyHint?: string): string | null {
    const resolvedUrl = this.resolveOpenAiImagePartUrl(raw);
    if (resolvedUrl) {
      return resolvedUrl;
    }
    const text = this.stringOrUndefined(raw);
    if (!text) {
      return null;
    }
    const dataUrl = this.parseDataUrl(text);
    if (dataUrl) {
      return `data:${dataUrl.mimeType};base64,${dataUrl.base64}`;
    }
    const normalizedBase64 = text.replace(/\s+/g, '');
    if (!this.isLikelyBase64(normalizedBase64)) {
      return null;
    }
    const mimeType = this.inferImageMimeTypeFromBase64(normalizedBase64, keyHint);
    return `data:${mimeType};base64,${normalizedBase64}`;
  }

  private normalizeRunningHubMediaInputValue(
    raw: unknown,
    kind: RunningHubUploadAssetKind,
    keyHint?: string,
  ): string | null {
    const text = this.stringOrUndefined(raw);
    if (!text) {
      return null;
    }
    if (/^https?:\/\//i.test(text)) {
      return text;
    }
    const dataUrl = this.parseDataUrl(text);
    if (dataUrl) {
      return `data:${dataUrl.mimeType};base64,${dataUrl.base64}`;
    }
    const normalizedBase64 = text.replace(/\s+/g, '');
    if (!this.isLikelyBase64(normalizedBase64)) {
      return null;
    }
    const mimeType = this.inferRunningHubUploadMimeType(normalizedBase64, kind, keyHint);
    return `data:${mimeType};base64,${normalizedBase64}`;
  }

  private normalizeRunningHubQuality(raw: string | null): string | null {
    const text = String(raw || '').trim();
    return text || null;
  }

  private normalizeRunningHubResolution(raw: string | null): string | null {
    const text = String(raw || '').trim().toLowerCase();
    if (!text) {
      return null;
    }
    if (text === '1k' || text === '2k' || text === '4k') {
      return text;
    }
    return null;
  }

  private normalizeRunningHubVideoResolution(raw: string | null): string | null {
    const text = String(raw || '').trim().toLowerCase();
    if (!text) {
      return null;
    }
    const allowed = new Set(['480p', '720p', '1080p', '2k', '4k']);
    if (allowed.has(text)) {
      return text;
    }
    return null;
  }

  private normalizeRunningHubVideoDuration(raw: unknown): string | null {
    const parsed = this.pickNumber(raw);
    if (!parsed) {
      return null;
    }
    const bounded = Math.max(4, Math.min(15, parsed));
    return String(bounded);
  }

  private normalizeRunningHubVideoRatio(raw: string | null): string | null {
    const text = String(raw || '').trim();
    if (!text) {
      return null;
    }
    const allowed = new Set(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);
    if (allowed.has(text)) {
      return text;
    }
    return null;
  }

  private normalizeRunningHubConversionSlots(raw: unknown): string[] | null {
    const values = Array.isArray(raw) ? raw : (this.stringOrUndefined(raw) ? [raw] : []);
    const normalized = values
      .map((item) => String(item || '').trim())
      .filter((item) => ['all', 'firstFrameUrl', 'lastFrameUrl'].includes(item));
    return normalized.length > 0 ? Array.from(new Set(normalized)) : null;
  }

  private normalizeRunningHubAspectRatio(raw: string | null): string | null {
    const text = String(raw || '').trim();
    if (!text) {
      return null;
    }
    const allowed = new Set(['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
    if (allowed.has(text)) {
      return text;
    }
    return null;
  }

  private mapOpenAiSizeToRunningHubImageConfig(sizeRaw?: string): { aspectRatio?: string; imageSize?: string } {
    const mapped = this.mapOpenAiSizeToGoogleImageConfig(sizeRaw);
    return {
      aspectRatio: mapped.aspectRatio,
      imageSize: mapped.imageSize,
    };
  }

  private async fetchRunningHubJson(
    route: ResolvedAiRoute,
    endpointUrl: string,
    body: Record<string, unknown>,
    context: AiInvocationContext = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchUpstream(route, endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: JSON.stringify(body),
    }, context);
    const raw = await response.text();
    const data = this.tryParseJsonObject(raw);
    if (!response.ok) {
      throw new BadGatewayException(
        `RunningHub request failed (${response.status}): ${this.truncate(this.safeJsonPreview(raw), 500)}`,
      );
    }
    return data;
  }

  private async pollRunningHubTask(
    route: ResolvedAiRoute,
    taskId: string,
    schema: ReturnType<typeof resolveRunningHubSchema>,
  ): Promise<Record<string, unknown>> {
    const queryUrl = this.joinUrl(route.source.base_url, schema.query_path);
    const pollAttempts = Math.max(1, Math.ceil(schema.poll_timeout_ms / schema.poll_interval_ms));
    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      try {
        const data = await this.fetchRunningHubJson(route, queryUrl, { taskId });
        const status = extractRunningHubTaskStatus(data);
        if (status && isRunningHubTaskTerminalSuccess(status)) {
          return data;
        }
        if (status && isRunningHubTaskTerminalFailure(status)) {
          const errorMessage = extractRunningHubTaskErrorMessage(data) || `task_status=${status}`;
          throw new BadGatewayException(`RunningHub task failed: ${errorMessage}`);
        }
      } catch (error: any) {
        if (!this.isRetryableRunningHubPollingError(error)) {
          throw error;
        }
        const message = this.truncate(String(error?.message || error || 'unknown error'), 240);
        if (attempt >= pollAttempts) {
          throw new BadGatewayException(
            `RunningHub task polling failed after ${pollAttempts} attempts. taskId=${taskId} upstream_message=${message}`,
          );
        }
        this.logger.warn(
          `RunningHub task polling transient error model=${route.model_key} taskId=${taskId} attempt=${attempt}/${pollAttempts}: ${message}`,
        );
      }
      if (attempt < pollAttempts) {
        await this.sleep(schema.poll_interval_ms);
      }
    }
    throw new BadGatewayException(`RunningHub task polling timeout after ${pollAttempts} attempts`);
  }

  private isRetryableRunningHubPollingError(error: unknown): boolean {
    const anyError = error as any;
    const message = String(anyError?.message || error || '').trim();
    if (!message) {
      return false;
    }
    if (anyError?.name === 'AbortError' || /aborted|abort/i.test(message)) {
      return false;
    }
    const statusMatch = message.match(/RunningHub request failed \((\d{3})\)/i);
    if (statusMatch) {
      const status = Number(statusMatch[1]);
      return status === 408 || status === 429 || status >= 500;
    }
    return /SocksClient|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|proxy|TLS/i.test(message);
  }

  private async fetchRunningHubTaskData(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    taskId: string,
    context: AiInvocationContext = {},
  ): Promise<Record<string, unknown>> {
    const schema = resolveRunningHubSchema(route.request_overrides, route.endpoint_path);
    const queryPath =
      this.stringOrUndefined(payload.query_path)
      || this.stringOrUndefined(payload.queryPath)
      || schema.query_path
      || RUNNINGHUB_DEFAULT_QUERY_PATH;
    const queryUrl = this.joinUrl(route.source.base_url, queryPath);
    return this.fetchRunningHubJson(route, queryUrl, { taskId }, context);
  }

  private async buildRunningHubVideoTaskResponseWithProxy(
    route: ResolvedAiRoute,
    data: Record<string, unknown>,
    options: { includeVideoUrls: boolean; fallbackTaskId?: string | null; proxyWaitTimeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const taskStatus = extractRunningHubTaskStatus(data) || null;
    if (!options.includeVideoUrls || !taskStatus || !isRunningHubTaskTerminalSuccess(taskStatus)) {
      return this.buildRunningHubVideoTaskResponse(data, options);
    }

    const taskId = extractRunningHubTaskId(data) || options.fallbackTaskId || null;
    const videoUrls = extractRunningHubResultUrls(data);
    if (!taskId || videoUrls.length === 0) {
      return this.buildRunningHubVideoTaskResponse(data, options);
    }

    const proxied = await this.aiVideoResultProxy.resolveVideoUrls({
      appId: route.app_id,
      appSlug: route.app_slug,
      provider: 'runninghub',
      providerTaskId: String(taskId),
      sourceUrls: videoUrls,
      outboundProxyId: route.source.outbound_proxy_id,
      waitTimeoutMs: options.proxyWaitTimeoutMs || 0,
    });
    if (!proxied.enabled) {
      return this.buildRunningHubVideoTaskResponse(data, options);
    }
    if (!proxied.ready) {
      return this.buildRunningHubVideoTaskResponse(data, {
        ...options,
        includeVideoUrls: false,
        taskStatusOverride: 'RUNNING',
      });
    }
    return this.buildRunningHubVideoTaskResponse(data, {
      ...options,
      overrideVideoUrls: proxied.urls,
    });
  }

  private buildRunningHubVideoTaskResponse(
    data: Record<string, unknown>,
    options: {
      includeVideoUrls: boolean;
      fallbackTaskId?: string | null;
      overrideVideoUrls?: string[];
      taskStatusOverride?: string | null;
    },
  ): Record<string, unknown> {
    const taskId = extractRunningHubTaskId(data) || options.fallbackTaskId || null;
    const taskStatus = options.taskStatusOverride || extractRunningHubTaskStatus(data) || null;
    const response: Record<string, unknown> = {
      created: Math.floor(Date.now() / 1000),
      task_id: taskId,
      task_status: taskStatus,
      request_id: taskId,
    };
    if (taskStatus && isRunningHubTaskTerminalFailure(taskStatus)) {
      const message = extractRunningHubTaskErrorMessage(data);
      if (message) {
        response.message = message;
      }
    }
    if (options.includeVideoUrls && taskStatus && isRunningHubTaskTerminalSuccess(taskStatus)) {
      const videoUrls = options.overrideVideoUrls || extractRunningHubResultUrls(data);
      response.data = videoUrls.map((url) => ({
        url,
        mime_type: 'video/mp4',
      }));
      if (videoUrls[0]) {
        response.video_url = videoUrls[0];
      }
      const usage = this.extractUsageMetrics(data);
      const durationSeconds = this.extractRunningHubVideoDurationSeconds(data);
      const resolution = this.extractVideoResolutionFromData(data);
      if (usage.request_id || durationSeconds !== null || resolution) {
        response.usage = {
          ...(durationSeconds !== null ? { duration: durationSeconds } : {}),
          ...(resolution ? { resolution } : {}),
          ...(usage.request_id ? { request_id: usage.request_id } : {}),
        };
      }
    }
    return response;
  }

  private extractRunningHubVideoDurationSeconds(data: Record<string, unknown>): number | null {
    return this.numberOrNull(
      this.getNestedObject(data, ['usage'])?.duration,
      this.getNestedObject(data, ['usage'])?.duration_seconds,
      this.getNestedObject(data, ['usage'])?.taskCostTime,
      this.getNestedObject(data, ['data'])?.duration,
      data.duration,
    );
  }

  private isDashscopeNativeEndpointPath(endpointPath: string): boolean {
    const normalized = this.normalizeEndpointPath(endpointPath || '');
    if (normalized === DASHSCOPE_NATIVE_STT_ENDPOINT) {
      return true;
    }
    if (normalized.startsWith('/api/v1/services/aigc/')) {
      return true;
    }
    if (normalized.startsWith('/api/v1/services/audio/asr/')) {
      return true;
    }
    return false;
  }

  private isDashscopeNativeApiType(apiType: string): boolean {
    const normalized = this.normalizeApiType(apiType);
    return normalized === DASHSCOPE_NATIVE_IMAGE_API_TYPE
      || normalized === DASHSCOPE_NATIVE_STT_API_TYPE
      || normalized === DASHSCOPE_NATIVE_VIDEO_API_TYPE
      || normalized === DASHSCOPE_VIDEORETALK_API_TYPE
      || normalized.startsWith('dashscope-native')
      || normalized.startsWith('aliyun-native');
  }

  private resolveDashscopeNativeImageEndpointCandidates(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): string[] {
    const openAiStylePaths = new Set(['/images/generations', '/v1/images/generations']);
    const configured = this.normalizeEndpointPath(route.endpoint_path || '/images/generations');
    if (this.isDashscopeQwenImageRoute(route)) {
      const candidates = [DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS[2]];
      if (!openAiStylePaths.has(configured)) {
        const normalizedConfigured = this.normalizeDashscopeNativeEndpointPath(configured);
        if (!candidates.includes(normalizedConfigured)) {
          candidates.push(normalizedConfigured);
        }
      }
      return candidates;
    }
    const wanImageInputs = this.isDashscopeWanBase64DirectRoute(route)
      ? this.collectDashscopeWanImageInputs(payload)
      : [];
    if (this.isDashscopeWanBase64DirectRoute(route)) {
      const wanCandidates: string[] = [];
      const configuredNormalized = !openAiStylePaths.has(configured)
        ? this.normalizeDashscopeNativeEndpointPath(configured)
        : '';
      const allowConfiguredWanEndpoint =
        configuredNormalized === DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS[0]
        || configuredNormalized === DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS[2];
      if (allowConfiguredWanEndpoint && !wanCandidates.includes(configuredNormalized)) {
        wanCandidates.push(configuredNormalized);
      }
      const asyncImageEndpoint = DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS[0];
      if (!wanCandidates.includes(asyncImageEndpoint)) {
        wanCandidates.unshift(asyncImageEndpoint);
      }
      if (wanImageInputs.length > 0) {
        const multimodalEndpoint = DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS[2];
        if (!wanCandidates.includes(multimodalEndpoint)) {
          wanCandidates.push(multimodalEndpoint);
        }
      }
      return wanCandidates;
    }
    const candidates: string[] = [];
    const preferMultimodal = this.shouldPreferDashscopeMultimodalEndpoint(route, payload);

    if (!openAiStylePaths.has(configured)) {
      const normalizedConfigured = this.normalizeDashscopeNativeEndpointPath(configured);
      const configuredIsMultimodal = normalizedConfigured.includes('/multimodal-generation/');
      // text-to-image requests should not be forced to multimodal endpoints.
      if (!(configuredIsMultimodal && !preferMultimodal)) {
        candidates.push(normalizedConfigured);
      }
    }

    DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS.forEach((item) => {
      const normalized = this.normalizeDashscopeNativeEndpointPath(item);
      if (!candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    });

    const finalCandidates = candidates.length > 0 ? candidates : [...DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS];
    if (!preferMultimodal) {
      return finalCandidates;
    }
    const multimodalEndpoint = DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS[2];
    if (!finalCandidates.includes(multimodalEndpoint)) {
      return [multimodalEndpoint, ...finalCandidates];
    }
    return [multimodalEndpoint, ...finalCandidates.filter((item) => item !== multimodalEndpoint)];
  }

  private shouldPreferDashscopeMultimodalEndpoint(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): boolean {
    if (this.isDashscopeQwenImageRoute(route)) {
      return true;
    }
    if (!this.isDashscopeWanBase64DirectRoute(route)) {
      return false;
    }
    // Wan2.6 multimodal is only required for img2img style requests.
    return this.collectDashscopeWanImageInputs(payload).length > 0;
  }

  private isDashscopeWanBase64DirectRoute(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'image') {
      return false;
    }
    if (!this.isDashscopeSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }
    const modelHints = `${String(route.model_key || '')} ${String(route.upstream_model || '')}`.toLowerCase();
    const compact = modelHints.replace(/[^a-z0-9]/g, '');
    return compact.includes('wan26');
  }

  private isDashscopeQwenImageRoute(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'image') {
      return false;
    }
    if (!this.isDashscopeSource(route.source.provider_type, route.source.base_url)) {
      return false;
    }
    const modelHints = `${String(route.model_key || '')} ${String(route.upstream_model || '')}`.toLowerCase();
    const compact = modelHints.replace(/[^a-z0-9]/g, '');
    return compact.includes('qwenimage');
  }

  private isDashscopeQwenSingleEditRoute(route: ResolvedAiRoute): boolean {
    if (!this.isDashscopeQwenImageRoute(route)) {
      return false;
    }
    const modelHints = `${String(route.model_key || '')} ${String(route.upstream_model || '')}`.toLowerCase();
    const compact = modelHints.replace(/[^a-z0-9]/g, '');
    return compact.includes('qwenimageedit') && !compact.includes('max') && !compact.includes('plus');
  }

  private resolveDashscopeNativeSttEndpoint(route: ResolvedAiRoute): string {
    const configured = this.normalizeEndpointPath(route.endpoint_path || '/audio/transcriptions');
    if (configured === '/audio/transcriptions' || configured === '/v1/audio/transcriptions') {
      return DASHSCOPE_NATIVE_STT_ENDPOINT;
    }
    return this.normalizeDashscopeNativeEndpointPath(configured);
  }

  private resolveDashscopeNativeVideoEndpoint(route: ResolvedAiRoute): string {
    const configured = this.normalizeEndpointPath(route.endpoint_path || '/videos/generations');
    if (this.isDashscopeVideoRetalkRoute(route)) {
      if (configured === '/videos/generations' || configured === '/v1/videos/generations') {
        return DASHSCOPE_VIDEORETALK_ENDPOINT;
      }
    }
    if (configured === '/videos/generations' || configured === '/v1/videos/generations') {
      return DASHSCOPE_NATIVE_VIDEO_ENDPOINT;
    }
    return this.normalizeDashscopeNativeEndpointPath(configured);
  }

  private normalizeDashscopeNativeEndpointPath(endpointPath: string): string {
    const normalized = this.normalizeEndpointPath(endpointPath);
    if (normalized === '/audio/transcriptions' || normalized === '/v1/audio/transcriptions') {
      return DASHSCOPE_NATIVE_STT_ENDPOINT;
    }
    if (normalized === '/images/generations' || normalized === '/v1/images/generations') {
      return DASHSCOPE_IMAGE_ENDPOINT_FALLBACKS[0];
    }
    if (normalized === '/videos/generations' || normalized === '/v1/videos/generations') {
      return DASHSCOPE_NATIVE_VIDEO_ENDPOINT;
    }
    return normalized;
  }

  private isDashscopeVideoRetalkRoute(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'video') {
      return false;
    }
    const apiType = this.normalizeApiType(String(route.api_type || ''));
    const modelHints = `${String(route.model_key || '')} ${String(route.upstream_model || '')}`.toLowerCase();
    return apiType === DASHSCOPE_VIDEORETALK_API_TYPE
      || modelHints.replace(/[^a-z0-9]/g, '').includes(DASHSCOPE_VIDEORETALK_MODEL_KEY);
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

  private buildDashscopeEndpointUrl(baseUrl: string, endpointPath: string): string {
    if (/^https?:\/\//i.test(endpointPath)) {
      return endpointPath;
    }
    const normalizedBaseUrl = this.normalizeDashscopeNativeBaseUrl(baseUrl);
    let normalizedEndpoint = this.normalizeDashscopeNativeEndpointPath(endpointPath);
    if (
      normalizedBaseUrl.toLowerCase().endsWith('/api/v1')
      && normalizedEndpoint.toLowerCase().startsWith('/api/v1/')
    ) {
      normalizedEndpoint = normalizedEndpoint.slice('/api/v1'.length);
    }
    return this.joinUrl(normalizedBaseUrl, normalizedEndpoint);
  }

  private async forwardDashscopeNativeImage(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const headersBase: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.source.api_key}`,
      ...route.source.custom_headers,
    };
    const endpointCandidates = this.resolveDashscopeNativeImageEndpointCandidates(route, payload);
    const attemptedEndpoints: string[] = [];
    const tempFileRefs = this.extractDashscopeTempFileRefs(payload);
    let lastStatus = 502;
    let lastErrorBody = 'request failed';

    try {
      for (let i = 0; i < endpointCandidates.length; i += 1) {
        const endpointPath = endpointCandidates[i];
        const endpointUrl = this.buildDashscopeEndpointUrl(route.source.base_url, endpointPath);
        attemptedEndpoints.push(endpointUrl);

        const headers: Record<string, string> = { ...headersBase };
        if (!endpointPath.includes('/multimodal-generation/')) {
          headers['X-DashScope-Async'] = 'enable';
        }

        const requestPayload = this.buildDashscopeNativeImagePayload(route, payload, endpointPath);
        let response = await this.fetchUpstream(route, endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestPayload),
        }, context);

        if (!response.ok) {
          let errorBody = await response.text();

          if (
            this.shouldRetryDashscopeImageWithSanitizedPayload(
              response.status,
              errorBody,
              endpointPath,
              requestPayload,
            )
          ) {
            const sanitizedPayload = this.buildDashscopeSanitizedImagePayload(requestPayload);
            if (sanitizedPayload) {
              this.logger.warn(
                `DashScope image retry with sanitized payload model=${route.model_key} endpoint=${endpointPath} reason=${this.truncate(errorBody, 200)}`,
              );
              response = await this.fetchUpstream(route, endpointUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(sanitizedPayload),
              }, context);
              if (!response.ok) {
                errorBody = await response.text();
              } else {
                errorBody = '';
              }
            }
          }

          lastStatus = response.status;
          lastErrorBody = errorBody || response.statusText || 'request failed';
        }

        if (!response.ok) {
          if (this.shouldRetryDashscopeImageOnErrorResponse(response.status, lastErrorBody, i, endpointCandidates.length)) {
            this.logger.warn(
              `DashScope image endpoint retry status=${response.status} endpoint=${endpointPath} model=${route.model_key} body=${this.truncate(lastErrorBody, 240)}`,
            );
            continue;
          }
          break;
        }

        const initialData = await this.parseJsonObjectFromResponse(response);
        let finalData: Record<string, unknown>;
        try {
          finalData = await this.resolveDashscopeTaskResultIfNeeded(route, payload, initialData, headersBase);
        } catch (error: any) {
          const errorMessage = String(error?.message || 'request failed');
          lastStatus = Number(error?.status) || 502;
          lastErrorBody = errorMessage;
          if (this.shouldRetryDashscopeImageOnTaskFailure(errorMessage, i, endpointCandidates.length)) {
            this.logger.warn(
              `DashScope image task failed, retry next endpoint model=${route.model_key} endpoint=${endpointPath} message=${this.truncate(errorMessage, 240)}`,
            );
            continue;
          }
          throw error;
        }
        const imageUrls = this.extractDashscopeImageUrls(finalData);
        if (imageUrls.length === 0) {
          lastStatus = 502;
          lastErrorBody = `DashScope returned no image url, response=${this.truncate(JSON.stringify(finalData), 900)}`;
          if (i < endpointCandidates.length - 1) {
            this.logger.warn(
              `DashScope image response has no image url, retry next endpoint model=${route.model_key} endpoint=${endpointPath}`,
            );
            continue;
          }
          break;
        }

        const usage = {
          ...this.extractUsageMetrics(finalData),
          image_count: imageUrls.length,
        };
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage,
          request_id: usage.request_id || this.stringOrUndefined(finalData.request_id) || null,
          latency_ms: Date.now() - startedAt,
        });
        return {
          stream: false,
          data: {
            created: Math.floor(Date.now() / 1000),
            data: imageUrls.map((url) => ({ url })),
          },
        };
      }

      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `HTTP ${lastStatus}: ${this.truncate(lastErrorBody, 900)}`,
      });
      const attemptedEndpointsSuffix = this.buildAttemptedEndpointsSuffix(attemptedEndpoints);
      throw new BadGatewayException(
        `DashScope image generation failed (${lastStatus}): ${lastErrorBody}${attemptedEndpointsSuffix}`,
      );
    } finally {
      await this.cleanupDashscopeTempFiles(tempFileRefs);
    }
  }

  private async forwardDashscopeNativeStt(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const endpointPath = this.resolveDashscopeNativeSttEndpoint(route);
    const endpointUrl = this.buildDashscopeEndpointUrl(route.source.base_url, endpointPath);
    const tempFileRefs = this.extractDashscopeTempFileRefs(payload);
    let usageLogged = false;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.source.api_key}`,
      'X-DashScope-Async': 'enable',
      ...route.source.custom_headers,
    };

    try {
      const requestPayload = this.buildDashscopeNativeSttPayload(route, payload);
      const response = await this.fetchUpstream(route, endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload),
      }, context);

      if (!response.ok) {
        const errorBody = await response.text();
        usageLogged = true;
        this.logUsageSafe(route, payload, context, {
          success: false,
          is_stream: false,
          usage: {},
          latency_ms: Date.now() - startedAt,
          error_message: `HTTP ${response.status}: ${this.truncate(String(errorBody || ''), 900)}`,
        });
        throw new BadGatewayException(
          `DashScope transcription failed (${response.status}): ${errorBody || response.statusText || 'request failed'}`,
        );
      }

      const initialData = await this.parseJsonObjectFromResponse(response);
      const finalData = await this.resolveDashscopeTaskResultIfNeeded(route, payload, initialData, headers);
      const text = await this.extractDashscopeTranscriptionText(finalData, route);
      if (!text) {
        usageLogged = true;
        this.logUsageSafe(route, payload, context, {
          success: false,
          is_stream: false,
          usage: {},
          latency_ms: Date.now() - startedAt,
          error_message: `DashScope returned empty transcription: ${this.truncate(JSON.stringify(finalData), 900)}`,
        });
        throw new BadGatewayException('DashScope transcription completed but no text returned');
      }

      const usage = {
        ...this.extractUsageMetrics(finalData),
        duration_seconds:
          this.extractDurationSecondsFromData(finalData)
          ?? this.resolveDurationSecondsFromPayload(payload),
      };
      usageLogged = true;
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage,
        request_id: usage.request_id || this.stringOrUndefined(finalData.request_id) || null,
        latency_ms: Date.now() - startedAt,
      });

      const responseFormat = this.stringOrUndefined(payload.response_format) || 'json';
      if (responseFormat === 'text') {
        return {
          stream: false,
          binary: true,
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
          body: Buffer.from(text, 'utf8'),
        };
      }
      if (responseFormat === 'srt' || responseFormat === 'vtt') {
        const subtitle = this.isSubtitleText(text, responseFormat)
          ? this.normalizeSubtitleText(text)
          : this.buildSubtitleOutput(finalData, text, responseFormat);
        return {
          stream: false,
          binary: true,
          status: 200,
          headers: {
            'content-type': responseFormat === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
            'cache-control': 'no-cache',
          },
          body: Buffer.from(subtitle, 'utf8'),
        };
      }
      if (responseFormat === 'verbose_json' || payload.include_raw_response === true) {
        return {
          stream: false,
          data: {
            text,
            raw: finalData,
          },
        };
      }
      return {
        stream: false,
        data: {
          text,
        },
      };
    } catch (error: any) {
      if (!usageLogged) {
        this.logUsageSafe(route, payload, context, {
          success: false,
          is_stream: false,
          usage: {},
          latency_ms: Date.now() - startedAt,
          error_message: this.truncate(String(error?.message || 'unknown error'), 900),
        });
      }
      throw error;
    } finally {
      await this.cleanupDashscopeTempFiles(tempFileRefs);
    }
  }

  private async forwardDashscopeCompatibleStt(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const endpointUrl = this.joinUrl(this.resolveAiSdkBaseUrl(route), '/chat/completions');
    const requestPayload = this.buildDashscopeCompatibleSttPayload(route, payload);
    const isStream = requestPayload.stream === true || requestPayload.stream === 'true';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.source.api_key}`,
      ...route.source.custom_headers,
    };
    if (isStream) {
      headers.Accept = 'text/event-stream';
    }

    const response = await this.fetchUpstream(route, endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
    }, context, { stream: isStream });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: isStream,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `HTTP ${response.status}: ${this.truncate(String(errorBody || ''), 900)}`,
      });
      throw new BadGatewayException(
        `DashScope Qwen ASR failed (${response.status}): ${errorBody || response.statusText || 'request failed'}`,
      );
    }

    if (isStream) {
      return this.buildSuccessfulForwardedResponse(route, { ...payload, stream: true }, context, startedAt, response);
    }

    const data = await this.parseJsonObjectFromResponse(response);
    const text = this.extractOpenAiChatText(data);
    if (!text) {
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `DashScope Qwen ASR returned empty text: ${this.truncate(JSON.stringify(data), 900)}`,
      });
      throw new BadGatewayException('DashScope Qwen ASR completed but no text returned');
    }

    const usage = {
      ...this.extractUsageMetrics(data),
      duration_seconds:
        this.extractDurationSecondsFromData(data)
        ?? this.resolveDurationSecondsFromPayload(payload),
    };
    this.logUsageSafe(route, payload, context, {
      success: true,
      is_stream: false,
      usage,
      request_id: usage.request_id || this.stringOrUndefined(data.id) || null,
      latency_ms: Date.now() - startedAt,
    });

    const responseFormat = this.normalizeTranscriptionResponseFormat(payload.response_format);
    if (responseFormat === 'text') {
      return {
        stream: false,
        binary: true,
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
        body: Buffer.from(text, 'utf8'),
      };
    }
    if (responseFormat === 'srt' || responseFormat === 'vtt') {
      const subtitle = this.isSubtitleText(text, responseFormat)
        ? this.normalizeSubtitleText(text)
        : this.buildSubtitleOutput(data, text, responseFormat);
      return {
        stream: false,
        binary: true,
        status: 200,
        headers: {
          'content-type': responseFormat === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
          'cache-control': 'no-cache',
        },
        body: Buffer.from(subtitle, 'utf8'),
      };
    }
    if (responseFormat === 'verbose_json' || payload.include_raw_response === true) {
      return {
        stream: false,
        data: {
          text,
          language: this.extractDashscopeAnnotationValue(data, 'language') || undefined,
          emotion: this.extractDashscopeAnnotationValue(data, 'emotion') || undefined,
          raw: data,
        },
      };
    }
    return {
      stream: false,
      data: { text },
    };
  }

  private async forwardDashscopeNativeVideo(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const endpointPath = this.resolveDashscopeNativeVideoEndpoint(route);
    const endpointUrl = this.buildDashscopeEndpointUrl(route.source.base_url, endpointPath);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.source.api_key}`,
      'X-DashScope-Async': 'enable',
      ...route.source.custom_headers,
    };

    const requestPayload = this.buildDashscopeNativeVideoPayload(route, payload);
    const response = await this.fetchUpstream(route, endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
    }, context);

    if (!response.ok) {
      const errorBody = await response.text();
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `HTTP ${response.status}: ${this.truncate(String(errorBody || ''), 900)}`,
      });
      throw new BadGatewayException(
        `DashScope video generation failed (${response.status}): ${errorBody || response.statusText || 'request failed'}`,
      );
    }

    const initialData = await this.parseJsonObjectFromResponse(response);
    const finalData = await this.resolveDashscopeTaskResultIfNeeded(route, payload, initialData, headers);
    const videoUrls = this.extractDashscopeVideoUrls(finalData);
    if (videoUrls.length === 0) {
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `DashScope returned empty video result: ${this.truncate(JSON.stringify(finalData), 900)}`,
      });
      throw new BadGatewayException('DashScope video generation completed but no video url returned');
    }

    const usage = {
      ...this.extractUsageMetrics(finalData),
      duration_seconds:
        this.extractDashscopeVideoDurationSeconds(finalData)
        ?? this.resolveDurationSecondsFromPayload(payload),
    };
    const taskId = this.extractDashscopeTaskId(finalData) || this.extractDashscopeTaskId(initialData);
    this.logUsageSafe(route, payload, context, {
      success: true,
      is_stream: false,
      usage,
      request_id: usage.request_id || this.stringOrUndefined(finalData.request_id) || null,
      latency_ms: Date.now() - startedAt,
    });

    return {
      stream: false,
      data: this.buildDashscopeVideoTaskResponse(finalData, {
        includeVideoUrls: true,
        fallbackTaskId: taskId,
      }),
    };
  }

  private async forwardDashscopeNativeVideoAsync(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Promise<ForwardedAiResponse> {
    const endpointPath = this.resolveDashscopeNativeVideoEndpoint(route);
    const endpointUrl = this.buildDashscopeEndpointUrl(route.source.base_url, endpointPath);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.source.api_key}`,
      'X-DashScope-Async': 'enable',
      ...route.source.custom_headers,
    };
    const requestPayload = this.buildDashscopeNativeVideoPayload(route, payload);
    const response = await this.fetchUpstream(route, endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new BadGatewayException(
        `DashScope async video generation failed (${response.status}): ${errorBody || response.statusText || 'request failed'}`,
      );
    }
    const data = await this.parseJsonObjectFromResponse(response);
    const taskId = this.extractDashscopeTaskId(data);
    if (!taskId) {
      throw new BadGatewayException('DashScope async video accepted but no task_id returned');
    }
    return {
      stream: false,
      data: this.buildDashscopeVideoTaskResponse(data, {
        includeVideoUrls: false,
        fallbackTaskId: taskId,
      }),
    };
  }

  private buildDashscopeNativeImagePayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    endpointPath: string,
  ): Record<string, unknown> {
    const inputObject = this.normalizeObject(payload.input);
    const parameters = {
      ...this.normalizeObject(payload.parameters),
    };

    const prompt =
      this.stringOrUndefined(payload.prompt)
      || this.stringOrUndefined(inputObject.prompt)
      || this.stringOrUndefined(inputObject.text)
      || this.normalizePromptToText(payload.input)
      || this.normalizePromptToText(payload.messages);
    if (!prompt) {
      throw new BadRequestException('image prompt is required');
    }

    const nCandidate = this.pickNumber(payload.n, parameters.n);

    const sizeCandidate =
      this.stringOrUndefined(payload.size)
      || this.stringOrUndefined(parameters.size)
      || '1024x1024';
    if (sizeCandidate && parameters.size === undefined) {
      parameters.size = this.normalizeDashscopeImageSize(sizeCandidate);
    }

    [
      'seed',
      'watermark',
      'prompt_extend',
      'enable_interleave',
      'max_images',
      'negative_prompt',
      'guidance_scale',
      'steps',
    ].forEach((key) => {
      if (payload[key] !== undefined && parameters[key] === undefined) {
        parameters[key] = payload[key];
      }
    });

    const isWanRoute = this.isDashscopeWanBase64DirectRoute(route);
    const isQwenRoute = this.isDashscopeQwenImageRoute(route);
    const imageInputs = isWanRoute
      ? this.collectDashscopeWanImageInputs(payload)
      : this.collectImageUrlsFromPayload(payload);
    if (isWanRoute) {
      const enableInterleave =
        parameters.enable_interleave === undefined
          ? imageInputs.length === 0
          : parameters.enable_interleave === true || parameters.enable_interleave === 'true';
      parameters.enable_interleave = enableInterleave;
      parameters.size = this.normalizeDashscopeWanImageSize(
        this.stringOrUndefined(parameters.size) || this.stringOrUndefined(payload.size) || '1024x1024',
        enableInterleave,
      );
      if (enableInterleave) {
        const maxImages = nCandidate !== null && nCandidate > 0
          ? Math.min(Math.max(nCandidate, 1), 5)
          : this.boundNumber(parameters.max_images, 1, 1, 5);
        parameters.n = 1;
        parameters.max_images = maxImages;
        delete parameters.prompt_extend;
      } else {
        if (nCandidate !== null && nCandidate > 0) {
          parameters.n = Math.min(Math.max(nCandidate, 1), 4);
        } else if (parameters.n === undefined) {
          parameters.n = 1;
        }
        if (parameters.prompt_extend === undefined) {
          parameters.prompt_extend = true;
        }
        delete parameters.max_images;
      }

      const content: Array<Record<string, unknown>> = [{ text: prompt }];
      imageInputs.forEach((item) => content.push({ image: item }));
      return {
        model: route.upstream_model,
        input: {
          messages: [
            {
              role: 'user',
              content,
            },
          ],
        },
        parameters,
      };
    }

    if (isQwenRoute) {
      const requestedCount = nCandidate !== null && nCandidate > 0
        ? nCandidate
        : this.pickNumber(parameters.n);
      parameters.n = this.isDashscopeQwenSingleEditRoute(route)
        ? 1
        : this.boundNumber(requestedCount, 1, 1, 6);
      if (this.isDashscopeQwenSingleEditRoute(route)) {
        delete parameters.size;
        delete parameters.prompt_extend;
      } else if (parameters.prompt_extend === undefined) {
        parameters.prompt_extend = true;
      }

      const content: Array<Record<string, unknown>> = imageInputs.map((item) => ({ image: item }));
      content.push({ text: prompt });
      return {
        model: route.upstream_model,
        input: {
          messages: [
            {
              role: 'user',
              content,
            },
          ],
        },
        parameters,
      };
    }

    if (nCandidate !== null && nCandidate > 0 && parameters.n === undefined) {
      parameters.n = Math.min(Math.max(nCandidate, 1), 4);
    }

    if (endpointPath.includes('/multimodal-generation/')) {
      const content: Array<Record<string, unknown>> = [{ text: prompt }];
      imageInputs.forEach((item) => content.push({ image: item }));
      return {
        model: route.upstream_model,
        input: {
          messages: [
            {
              role: 'user',
              content,
            },
          ],
        },
        parameters,
      };
    }

    const input: Record<string, unknown> = {
      prompt,
    };
    if (imageInputs[0]) {
      input.image_url = imageInputs[0];
    }
    return {
      model: route.upstream_model,
      input,
      parameters,
    };
  }

  private buildDashscopeNativeVideoPayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const inputObject = this.normalizeObject(payload.input);
    const promptFromScalarInput =
      typeof payload.input === 'string' ? this.normalizePromptToText(payload.input) : null;
    const parameters = {
      ...this.normalizeObject(payload.parameters),
    };

    const prompt =
      this.stringOrUndefined(payload.prompt)
      || this.stringOrUndefined(inputObject.prompt)
      || this.stringOrUndefined(inputObject.text)
      || promptFromScalarInput
      || this.normalizePromptToText(payload.messages);
    const negativePrompt =
      this.stringOrUndefined(payload.negative_prompt)
      || this.stringOrUndefined(inputObject.negative_prompt)
      || this.stringOrUndefined(parameters.negative_prompt);
    const requestedResolution =
      this.stringOrUndefined(payload.resolution)
      || this.stringOrUndefined(parameters.resolution)
      || this.stringOrUndefined(payload.size)
      || this.stringOrUndefined(inputObject.size);
    const requestedDuration = this.pickNumber(
      payload.duration,
      parameters.duration,
      payload.seconds,
      inputObject.seconds,
      payload.duration_seconds,
      inputObject.duration_seconds,
    );
    const requestedRatio =
      this.stringOrUndefined(payload.ratio)
      || this.stringOrUndefined(payload.aspect_ratio)
      || this.stringOrUndefined(payload.aspectRatio)
      || this.stringOrUndefined(inputObject.ratio)
      || this.stringOrUndefined(inputObject.aspect_ratio)
      || this.stringOrUndefined(inputObject.aspectRatio)
      || this.stringOrUndefined(parameters.ratio)
      || this.stringOrUndefined(parameters.aspect_ratio)
      || this.stringOrUndefined(parameters.aspectRatio);

    [
      'prompt_extend',
      'shot_type',
      'audio',
      'watermark',
      'seed',
    ].forEach((key) => {
      if (payload[key] !== undefined && parameters[key] === undefined) {
        parameters[key] = payload[key];
      }
    });
    if (requestedResolution && parameters.resolution === undefined) {
      parameters.resolution = this.normalizeDashscopeVideoResolution(requestedResolution);
    }
    if (requestedDuration !== null && parameters.duration === undefined) {
      parameters.duration = this.normalizeDashscopeVideoDuration(requestedDuration);
    }

    if (this.isDashscopeVideoRetalkRoute(route)) {
      return this.buildDashscopeVideoRetalkPayload(route, payload, inputObject, parameters);
    }

    const wan27Mode = this.resolveDashscopeWan27VideoMode(route);
    if (wan27Mode === 't2v') {
      if (!prompt) {
        throw new BadRequestException('wan2.7-t2v requires prompt');
      }
      const audioUrl =
        this.stringOrUndefined(payload.audio_url)
        || this.stringOrUndefined(inputObject.audio_url)
        || this.stringOrUndefined(payload.driving_audio_url)
        || this.stringOrUndefined(inputObject.driving_audio_url);
      const ratio =
        requestedRatio
        || this.inferDashscopeWan27VideoRatio(requestedResolution);
      if (ratio && parameters.ratio === undefined) {
        parameters.ratio = ratio;
      }

      const input: Record<string, unknown> = {
        prompt,
      };
      if (negativePrompt) {
        input.negative_prompt = negativePrompt;
        delete parameters.negative_prompt;
      }
      if (audioUrl) {
        input.audio_url = audioUrl;
      }
      return {
        model: route.upstream_model,
        input,
        parameters,
      };
    }

    if (wan27Mode === 'r2v') {
      if (!prompt) {
        throw new BadRequestException('wan2.7-r2v requires prompt');
      }
      const media = this.collectDashscopeWan27R2vMediaEntries(payload);
      this.assertDashscopeWan27R2vMedia(media);
      const ratio =
        requestedRatio
        || (media.some((item) => item.type === 'first_frame') ? null : this.inferDashscopeWan27VideoRatio(requestedResolution));
      if (ratio && parameters.ratio === undefined) {
        parameters.ratio = ratio;
      }

      const input: Record<string, unknown> = {
        prompt,
        media,
      };
      if (negativePrompt) {
        input.negative_prompt = negativePrompt;
        delete parameters.negative_prompt;
      }
      const referenceVoice =
        this.stringOrUndefined(payload.reference_voice)
        || this.stringOrUndefined(payload.reference_voice_url)
        || this.stringOrUndefined(inputObject.reference_voice)
        || this.stringOrUndefined(inputObject.reference_voice_url);
      if (referenceVoice) {
        input.reference_voice = referenceVoice;
      }
      return {
        model: route.upstream_model,
        input,
        parameters,
      };
    }

    if (wan27Mode === 'i2v') {
      const media = this.collectDashscopeWan27I2vMediaEntries(payload);
      this.assertDashscopeWan27I2vMedia(payload, media);
      const input: Record<string, unknown> = {
        media,
      };
      if (prompt) {
        input.prompt = prompt;
      }
      if (negativePrompt) {
        input.negative_prompt = negativePrompt;
        delete parameters.negative_prompt;
      }
      return {
        model: route.upstream_model,
        input,
        parameters,
      };
    }

    const template =
      this.stringOrUndefined(payload.template)
      || this.stringOrUndefined(inputObject.template);
    const imageInputs = this.collectDashscopeVideoImageInputs(payload);
    const imgUrl =
      this.stringOrUndefined(payload.img_url)
      || this.stringOrUndefined(inputObject.img_url)
      || imageInputs[0]
      || null;
    if (!imgUrl) {
      throw new BadRequestException('video generation requires a reference image (img_url, image, image_url, reference_image, or images[0])');
    }

    const audioUrl =
      this.stringOrUndefined(payload.audio_url)
      || this.stringOrUndefined(inputObject.audio_url)
      || this.extractDashscopeAudioUrl(payload);

    const input: Record<string, unknown> = {
      img_url: imgUrl,
    };
    if (prompt) {
      input.prompt = prompt;
    }
    if (negativePrompt) {
      input.negative_prompt = negativePrompt;
      delete parameters.negative_prompt;
    }
    if (template) {
      input.template = template;
    }
    if (audioUrl) {
      input.audio_url = audioUrl;
    }

    return {
      model: route.upstream_model,
      input,
      parameters,
    };
  }

  private buildDashscopeVideoRetalkPayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    inputObject: Record<string, unknown>,
    parameters: Record<string, unknown>,
  ): Record<string, unknown> {
    const videoUrl =
      this.stringOrUndefined(inputObject.video_url)
      || this.stringOrUndefined(inputObject.videoUrl)
      || this.stringOrUndefined(payload.video_url)
      || this.stringOrUndefined(payload.videoUrl)
      || this.stringOrUndefined(payload.video)
      || this.stringOrUndefined(payload.input_video_url)
      || this.stringOrUndefined(payload.inputVideoUrl);
    const audioUrl =
      this.stringOrUndefined(inputObject.audio_url)
      || this.stringOrUndefined(inputObject.audioUrl)
      || this.stringOrUndefined(payload.audio_url)
      || this.stringOrUndefined(payload.audioUrl)
      || this.stringOrUndefined(payload.audio)
      || this.stringOrUndefined(payload.driving_audio_url)
      || this.stringOrUndefined(payload.drivingAudioUrl);
    const refImageUrl =
      this.stringOrUndefined(inputObject.ref_image_url)
      || this.stringOrUndefined(inputObject.refImageUrl)
      || this.stringOrUndefined(payload.ref_image_url)
      || this.stringOrUndefined(payload.refImageUrl)
      || this.stringOrUndefined(payload.reference_image_url)
      || this.stringOrUndefined(payload.referenceImageUrl);

    if (!videoUrl) {
      throw new BadRequestException('VideoRetalk 需要 input.video_url 或 video_url');
    }
    if (!audioUrl) {
      throw new BadRequestException('VideoRetalk 需要 input.audio_url 或 audio_url');
    }
    this.assertDashscopeVideoRetalkDimensions(payload, inputObject);

    const retalkParameters: Record<string, unknown> = {
      ...parameters,
    };
    delete retalkParameters.resolution;
    delete retalkParameters.duration;
    delete retalkParameters.prompt_extend;
    delete retalkParameters.watermark;
    this.assignIfDefined(retalkParameters, 'video_extension', payload.video_extension ?? payload.videoExtension);
    this.assignIfDefined(retalkParameters, 'query_face_threshold', payload.query_face_threshold ?? payload.queryFaceThreshold);

    const input: Record<string, unknown> = {
      ...inputObject,
      video_url: videoUrl,
      audio_url: audioUrl,
    };
    if (refImageUrl) {
      input.ref_image_url = refImageUrl;
    }
    delete input.videoUrl;
    delete input.audioUrl;
    delete input.refImageUrl;
    delete input.video_width;
    delete input.videoWidth;
    delete input.video_height;
    delete input.videoHeight;
    delete input.width;
    delete input.height;

    return {
      model: route.upstream_model || DASHSCOPE_VIDEORETALK_MODEL_KEY,
      input,
      parameters: retalkParameters,
    };
  }

  private assertDashscopeVideoRetalkDimensions(
    payload: Record<string, unknown>,
    inputObject: Record<string, unknown>,
  ): void {
    const width = this.numberOrNull(
      inputObject.video_width,
      inputObject.videoWidth,
      inputObject.width,
      payload.video_width,
      payload.videoWidth,
      payload.width,
    );
    const height = this.numberOrNull(
      inputObject.video_height,
      inputObject.videoHeight,
      inputObject.height,
      payload.video_height,
      payload.videoHeight,
      payload.height,
    );
    if (width === null && height === null) {
      return;
    }
    if (width === null || height === null) {
      throw new BadRequestException('VideoRetalk 需要同时提供 video_width 和 video_height，或不提供尺寸字段');
    }
    if (width < 640 || width > 2048 || height < 640 || height > 2048) {
      throw new BadRequestException('VideoRetalk 输入视频宽高必须在 640 到 2048 之间；推荐 720x1280、1280x720 或 1024x1024');
    }
  }

  private normalizeDashscopeVideoResolution(value: string): '720P' | '1080P' {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return '720P';
    }
    if (normalized === '1080p') {
      return '1080P';
    }
    if (normalized === '720p') {
      return '720P';
    }
    const matched = normalized.match(/^(\d{3,4})\s*[x*]\s*(\d{3,4})$/);
    if (matched) {
      const width = Number(matched[1]);
      const height = Number(matched[2]);
      if (Math.max(width, height) >= 1700 || (width >= 1000 && height >= 1700)) {
        return '1080P';
      }
    }
    return '720P';
  }

  private normalizeDashscopeVideoDuration(value: number): number {
    const normalized = Math.round(Number(value) || 5);
    return Math.max(2, Math.min(15, normalized));
  }

  private resolveDashscopeWan27VideoMode(route: ResolvedAiRoute): 't2v' | 'i2v' | 'r2v' | null {
    if (route.capability !== 'video') {
      return null;
    }
    if (!this.isDashscopeSource(route.source.provider_type, route.source.base_url)) {
      return null;
    }
    const modelHints = `${String(route.model_key || '')} ${String(route.upstream_model || '')}`.toLowerCase();
    const compact = modelHints.replace(/[^a-z0-9]/g, '');
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

  private normalizeDashscopeVideoMediaType(
    raw: unknown,
  ): 'first_frame' | 'last_frame' | 'driving_audio' | 'first_clip' | 'reference_image' | 'reference_video' | null {
    const normalized = String(raw || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!normalized) {
      return null;
    }
    if (normalized === 'first_frame' || normalized === 'image' || normalized === 'image_url') {
      return 'first_frame';
    }
    if (normalized === 'last_frame' || normalized === 'last_image' || normalized === 'last_image_url') {
      return 'last_frame';
    }
    if (normalized === 'driving_audio' || normalized === 'audio' || normalized === 'audio_url') {
      return 'driving_audio';
    }
    if (normalized === 'first_clip' || normalized === 'video' || normalized === 'video_url' || normalized === 'clip') {
      return 'first_clip';
    }
    if (normalized === 'reference_image' || normalized === 'reference_images' || normalized === 'reference_image_url') {
      return 'reference_image';
    }
    if (normalized === 'reference_video' || normalized === 'reference_videos' || normalized === 'reference_video_url') {
      return 'reference_video';
    }
    return null;
  }

  private extractDashscopeVideoMediaValue(record: Record<string, unknown>): string | null {
    return (
      this.stringOrUndefined(record.url)
      || this.stringOrUndefined(record.uri)
      || this.stringOrUndefined(record.file_url)
      || this.stringOrUndefined(record.image_url)
      || this.stringOrUndefined(record.audio_url)
      || this.stringOrUndefined(record.video_url)
      || this.stringOrUndefined(record.data)
      || this.stringOrUndefined(record.b64_json)
      || this.stringOrUndefined(record.base64)
      || null
    );
  }

  private resolveDashscopeCompatibleVideoMode(
    payload: Record<string, unknown>,
  ): 'first_frame' | 'first_last_frame' | 'continuation' | null {
    const inputObject = this.normalizeObject(payload.input);
    const videoObject = this.normalizeObject(payload.video);
    const inputVideoObject = this.normalizeObject(inputObject.video);
    const rawMode =
      this.stringOrUndefined(payload.video_mode)
      || this.stringOrUndefined(payload.mode)
      || this.stringOrUndefined(inputObject.video_mode)
      || this.stringOrUndefined(inputObject.mode)
      || this.stringOrUndefined(videoObject.mode)
      || this.stringOrUndefined(inputVideoObject.mode);
    const normalized = String(rawMode || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!normalized) {
      return null;
    }
    if (normalized === 'first_frame' || normalized === 'image_to_video' || normalized === 'i2v') {
      return 'first_frame';
    }
    if (normalized === 'first_last_frame' || normalized === 'first_and_last_frame' || normalized === 'start_end_frame') {
      return 'first_last_frame';
    }
    if (normalized === 'continuation' || normalized === 'video_continuation' || normalized === 'extend') {
      return 'continuation';
    }
    return null;
  }

  private collectDashscopeWan27I2vMediaEntries(payload: Record<string, unknown>): Array<{ type: string; url: string }> {
    const mediaEntries: Array<{ type: string; url: string }> = [];
    const push = (typeRaw: unknown, urlRaw: unknown) => {
      const type = this.normalizeDashscopeVideoMediaType(typeRaw);
      const url = this.stringOrUndefined(urlRaw);
      if (!type || !url || !['first_frame', 'last_frame', 'driving_audio', 'first_clip'].includes(type)) {
        return;
      }
      if (mediaEntries.some((item) => item.type === type)) {
        return;
      }
      mediaEntries.push({ type, url });
    };

    const payloadMedia = Array.isArray(payload.media) ? payload.media : [];
    const inputMedia = Array.isArray(this.normalizeObject(payload.input).media)
      ? this.normalizeObject(payload.input).media as unknown[]
      : [];
    const payloadInputMedia = Array.isArray(payload.input_media) ? payload.input_media : [];
    const inputInputMedia = Array.isArray(this.normalizeObject(payload.input).input_media)
      ? this.normalizeObject(payload.input).input_media as unknown[]
      : [];
    const videoObject = this.normalizeObject(payload.video);
    const inputVideoObject = this.normalizeObject(this.normalizeObject(payload.input).video);
    const videoMedia = Array.isArray(videoObject.media) ? videoObject.media : [];
    const inputVideoMedia = Array.isArray(inputVideoObject.media) ? inputVideoObject.media : [];
    [...payloadMedia, ...inputMedia, ...payloadInputMedia, ...inputInputMedia, ...videoMedia, ...inputVideoMedia].forEach((item) => {
      if (!item || typeof item !== 'object') {
        return;
      }
      const record = item as Record<string, unknown>;
      push(record.type, this.extractDashscopeVideoMediaValue(record));
    });

    const inputObject = this.normalizeObject(payload.input);
    const firstFrame =
      this.stringOrUndefined(payload.img_url)
      || this.stringOrUndefined(inputObject.img_url)
      || this.collectDashscopeVideoImageInputs(payload)[0];
    const lastFrame =
      this.stringOrUndefined(payload.last_frame_url)
      || this.stringOrUndefined(payload.last_frame)
      || this.stringOrUndefined(payload.last_image_url)
      || this.stringOrUndefined(payload.last_image)
      || this.stringOrUndefined(inputObject.last_frame_url)
      || this.stringOrUndefined(inputObject.last_frame)
      || this.stringOrUndefined(inputObject.last_image_url)
      || this.stringOrUndefined(inputObject.last_image);
    const drivingAudio =
      this.stringOrUndefined(payload.driving_audio_url)
      || this.stringOrUndefined(payload.driving_audio)
      || this.stringOrUndefined(payload.audio_url)
      || this.stringOrUndefined(inputObject.driving_audio_url)
      || this.stringOrUndefined(inputObject.driving_audio)
      || this.stringOrUndefined(inputObject.audio_url);
    const firstClip =
      this.stringOrUndefined(payload.first_clip_url)
      || this.stringOrUndefined(payload.first_clip)
      || this.stringOrUndefined(payload.video_url)
      || this.stringOrUndefined(payload.video)
      || this.stringOrUndefined(inputObject.first_clip_url)
      || this.stringOrUndefined(inputObject.first_clip)
      || this.stringOrUndefined(inputObject.video_url)
      || this.stringOrUndefined(inputObject.video);

    push('first_frame', firstFrame);
    push('last_frame', lastFrame);
    push('driving_audio', drivingAudio);
    push('first_clip', firstClip);

    return mediaEntries;
  }

  private collectDashscopeWan27R2vMediaEntries(payload: Record<string, unknown>): Array<{ type: string; url: string }> {
    const mediaEntries: Array<{ type: string; url: string }> = [];
    const push = (typeRaw: unknown, urlRaw: unknown) => {
      const type = this.normalizeDashscopeVideoMediaType(typeRaw);
      const url = this.stringOrUndefined(urlRaw);
      if (!type || !url || !['reference_image', 'reference_video', 'first_frame'].includes(type)) {
        return;
      }
      if (type === 'first_frame' && mediaEntries.some((item) => item.type === type)) {
        return;
      }
      mediaEntries.push({ type, url });
    };

    const inputObject = this.normalizeObject(payload.input);
    const videoObject = this.normalizeObject(payload.video);
    const inputVideoObject = this.normalizeObject(inputObject.video);
    const candidateMedia = [
      ...(Array.isArray(payload.media) ? payload.media : []),
      ...(Array.isArray(inputObject.media) ? (inputObject.media as unknown[]) : []),
      ...(Array.isArray(videoObject.media) ? (videoObject.media as unknown[]) : []),
      ...(Array.isArray(inputVideoObject.media) ? (inputVideoObject.media as unknown[]) : []),
    ];
    candidateMedia.forEach((item) => {
      if (!item || typeof item !== 'object') {
        return;
      }
      const record = item as Record<string, unknown>;
      push(record.type, this.extractDashscopeVideoMediaValue(record));
    });

    const pushArray = (raw: unknown, type: 'reference_image' | 'reference_video') => {
      if (!Array.isArray(raw)) {
        return;
      }
      raw.forEach((item) => push(type, item));
    };

    pushArray(payload.reference_images, 'reference_image');
    pushArray(payload.reference_image_urls, 'reference_image');
    pushArray(inputObject.reference_images, 'reference_image');
    pushArray(inputObject.reference_image_urls, 'reference_image');
    pushArray(payload.reference_videos, 'reference_video');
    pushArray(payload.reference_video_urls, 'reference_video');
    pushArray(inputObject.reference_videos, 'reference_video');
    pushArray(inputObject.reference_video_urls, 'reference_video');

    const scalarReferenceImage =
      this.stringOrUndefined(payload.reference_image)
      || this.stringOrUndefined(payload.reference_image_url)
      || this.stringOrUndefined(inputObject.reference_image)
      || this.stringOrUndefined(inputObject.reference_image_url);
    const scalarReferenceVideo =
      this.stringOrUndefined(payload.reference_video)
      || this.stringOrUndefined(payload.reference_video_url)
      || this.stringOrUndefined(inputObject.reference_video)
      || this.stringOrUndefined(inputObject.reference_video_url);
    const firstFrame =
      this.stringOrUndefined(payload.first_frame_url)
      || this.stringOrUndefined(payload.first_frame)
      || this.stringOrUndefined(inputObject.first_frame_url)
      || this.stringOrUndefined(inputObject.first_frame);

    push('reference_image', scalarReferenceImage);
    push('reference_video', scalarReferenceVideo);
    push('first_frame', firstFrame);

    return mediaEntries;
  }

  private assertDashscopeWan27I2vMedia(payload: Record<string, unknown>, media: Array<{ type: string; url: string }>) {
    if (media.length === 0) {
      throw new BadRequestException(
        'wan2.7-i2v requires media input. Use OpenAI-compatible extensions: media[] or aliases image/image_url, last_frame_url, driving_audio_url, first_clip_url.',
      );
    }
    const typeSet = new Set(media.map((item) => item.type));
    const hasFirstClip = typeSet.has('first_clip');
    const hasFirstFrame = typeSet.has('first_frame');
    const hasLastFrame = typeSet.has('last_frame');
    const hasDrivingAudio = typeSet.has('driving_audio');
    const explicitMode = this.resolveDashscopeCompatibleVideoMode(payload);

    if (hasFirstClip && hasFirstFrame) {
      throw new BadRequestException('wan2.7 video continuation mode cannot combine first_clip with first_frame');
    }
    if (!hasFirstClip && !hasFirstFrame) {
      throw new BadRequestException('wan2.7 video generation requires first_frame or first_clip');
    }
    if (hasLastFrame && !hasFirstFrame) {
      if (!hasFirstClip) {
        throw new BadRequestException('last_frame requires first_frame or first_clip');
      }
    }

    if (explicitMode === 'continuation') {
      if (!hasFirstClip || hasFirstFrame || hasDrivingAudio) {
        throw new BadRequestException('video_mode=continuation requires first_clip and does not support first_frame or driving_audio');
      }
      return;
    }

    if (explicitMode === 'first_last_frame') {
      if (!hasFirstFrame || !hasLastFrame || hasFirstClip) {
        throw new BadRequestException('video_mode=first_last_frame requires first_frame + last_frame and does not support first_clip');
      }
      return;
    }

    if (explicitMode === 'first_frame') {
      if (!hasFirstFrame || hasLastFrame || hasFirstClip) {
        throw new BadRequestException('video_mode=first_frame requires first_frame and does not support last_frame or first_clip');
      }
      return;
    }
  }

  private assertDashscopeWan27R2vMedia(media: Array<{ type: string; url: string }>) {
    if (media.length === 0) {
      throw new BadRequestException(
        'wan2.7-r2v requires reference media. Use media[] or aliases reference_images/reference_videos/reference_image/reference_video.',
      );
    }
    const referenceCount = media.filter((item) => item.type === 'reference_image' || item.type === 'reference_video').length;
    const firstFrameCount = media.filter((item) => item.type === 'first_frame').length;
    if (referenceCount < 1) {
      throw new BadRequestException('wan2.7-r2v requires at least one reference_image or reference_video');
    }
    if (referenceCount > 5) {
      throw new BadRequestException('wan2.7-r2v supports at most 5 reference_image/reference_video media items');
    }
    if (firstFrameCount > 1) {
      throw new BadRequestException('wan2.7-r2v supports at most one first_frame');
    }
  }

  private inferDashscopeWan27VideoRatio(value: string | null | undefined): '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | null {
    const raw = String(value || '').trim();
    if (!raw) {
      return null;
    }
    const normalized = raw.toLowerCase();
    if (normalized === '16:9' || normalized === '9:16' || normalized === '1:1' || normalized === '4:3' || normalized === '3:4') {
      return normalized.toUpperCase() as '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
    }
    const matched = normalized.match(/^(\d{2,5})\s*[x*]\s*(\d{2,5})$/);
    if (!matched) {
      return null;
    }
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    const supportedRatios = [
      { label: '16:9' as const, value: 16 / 9 },
      { label: '9:16' as const, value: 9 / 16 },
      { label: '1:1' as const, value: 1 },
      { label: '4:3' as const, value: 4 / 3 },
      { label: '3:4' as const, value: 3 / 4 },
    ];
    const ratio = width / height;
    return supportedRatios.reduce((best, current) => {
      if (!best) {
        return current;
      }
      return Math.abs(current.value - ratio) < Math.abs(best.value - ratio) ? current : best;
    }, supportedRatios[0]).label;
  }

  private normalizeDashscopeWanImageSize(value: string, enableInterleave: boolean): string {
    const normalized = this.normalizeDashscopeImageSize(value);
    if (enableInterleave) {
      return normalized === '1K' ? '1280*1280' : normalized;
    }
    return normalized === '1024*1024' ? '1K' : normalized;
  }

  private buildDashscopeNativeSttPayload(route: ResolvedAiRoute, payload: Record<string, unknown>): Record<string, unknown> {
    const parameters = {
      ...this.normalizeObject(payload.parameters),
      ...this.normalizeObject(this.normalizeObject(payload.parameters).asr_options),
      ...this.normalizeObject(payload.asr_options),
    };
    delete parameters.asr_options;
    const audioUrl = this.extractDashscopeAudioUrl(payload);
    if (!audioUrl) {
      throw new BadRequestException('stt requires audio url (file_url/audio_url/url)');
    }

    const language = this.stringOrUndefined(payload.language);
    if (language) {
      if (this.isDashscopeFileTranscriptionModel(route.upstream_model)) {
        if (parameters.language === undefined) {
          parameters.language = language;
        }
      } else if (parameters.language_hints === undefined) {
        parameters.language_hints = [language];
      }
    }

    [
      'language_hints',
      'vocabulary_id',
      'disfluency_removal_enabled',
      'enable_words',
      'enable_itn',
      'enable_lid',
      'enable_timestamp',
      'channel_id',
      'speaker_count',
      'enable_speaker_diarization',
      'speaker_diarization',
      'diarization',
    ].forEach((key) => {
      if (payload[key] !== undefined && parameters[key] === undefined) {
        parameters[key] = payload[key];
      }
    });

    const input = this.isDashscopeFileTranscriptionModel(route.upstream_model)
      ? { file_url: audioUrl }
      : { file_urls: [audioUrl] };

    return {
      model: route.upstream_model,
      input,
      parameters,
    };
  }

  private isDashscopeFileTranscriptionModel(model: unknown): boolean {
    return String(model || '').toLowerCase().includes('filetrans');
  }

  private buildDashscopeCompatibleSttPayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const audio = this.extractDashscopeCompatibleAudioInput(payload);
    if (!audio) {
      throw new BadRequestException('qwen3-asr-flash requires audio input (multipart file, file_base64, file_url, or audio_url)');
    }

    const systemText = this.stringOrUndefined(payload.prompt)
      || this.stringOrUndefined(payload.context)
      || this.stringOrUndefined(payload.asr_context)
      || this.stringOrUndefined(payload.hotwords);
    const messages: Array<Record<string, unknown>> = [];
    if (systemText) {
      messages.push({
        role: 'system',
        content: [{ type: 'text', text: systemText }],
      });
    }
    messages.push({
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: { data: audio },
        },
      ],
    });

    return {
      model: route.upstream_model,
      messages,
      stream: payload.stream === true || payload.stream === 'true',
      asr_options: this.buildDashscopeAsrOptions(payload),
    };
  }

  private buildDashscopeAsrOptions(payload: Record<string, unknown>): Record<string, unknown> {
    const options: Record<string, unknown> = {
      ...this.normalizeObject(payload.parameters),
      ...this.normalizeObject(this.normalizeObject(payload.parameters).asr_options),
      ...this.normalizeObject(payload.asr_options),
    };
    delete options.asr_options;

    [
      'language',
      'enable_itn',
      'enable_lid',
      'enable_words',
      'enable_timestamp',
      'channel_id',
      'speaker_count',
      'enable_speaker_diarization',
      'speaker_diarization',
      'diarization',
      'disfluency_removal_enabled',
      'vocabulary_id',
    ].forEach((key) => {
      if (payload[key] !== undefined && options[key] === undefined) {
        options[key] = payload[key];
      }
    });

    const responseFormat = this.normalizeTranscriptionResponseFormat(payload.response_format);
    if (responseFormat !== 'json' && options.response_format === undefined) {
      options.response_format = responseFormat;
    }
    return options;
  }

  private extractDashscopeCompatibleAudioInput(payload: Record<string, unknown>): string | null {
    const multipart = this.extractMultipartInstruction(payload);
    const multipartBase64 = this.stringOrUndefined(multipart?.file_base64);
    if (multipartBase64) {
      const parsed = this.parseDataUrl(multipartBase64);
      const base64 = parsed ? parsed.base64 : multipartBase64.replace(/\s+/g, '');
      const mimeType = this.stringOrUndefined(multipart?.file_mime_type) || parsed?.mimeType || 'application/octet-stream';
      return `data:${mimeType};base64,${base64}`;
    }

    const fileBase64 = this.stringOrUndefined(payload.file_base64);
    if (fileBase64) {
      const parsed = this.parseDataUrl(fileBase64);
      if (parsed) {
        return `data:${parsed.mimeType};base64,${parsed.base64}`;
      }
      const mimeType = this.stringOrUndefined(payload.file_mime_type) || this.stringOrUndefined(payload.mime_type) || 'application/octet-stream';
      return `data:${mimeType};base64,${fileBase64.replace(/\s+/g, '')}`;
    }

    return this.extractDashscopeAudioUrl(payload);
  }

  private extractDashscopeAudioUrl(payload: Record<string, unknown>): string | null {
    const directCandidates = [
      this.stringOrUndefined(payload.file_url),
      this.stringOrUndefined(payload.audio_url),
      this.stringOrUndefined(payload.url),
      this.stringOrUndefined(payload.audio),
    ].filter((item): item is string => !!item);
    for (const candidate of directCandidates) {
      if (/^https?:\/\//i.test(candidate)) {
        return candidate;
      }
    }

    const inputObject = this.normalizeObject(payload.input);
    const inputCandidates = [
      this.stringOrUndefined(inputObject.file_url),
      this.stringOrUndefined(inputObject.audio_url),
      this.stringOrUndefined(inputObject.url),
      this.stringOrUndefined(inputObject.audio),
    ].filter((item): item is string => !!item);
    for (const candidate of inputCandidates) {
      if (/^https?:\/\//i.test(candidate)) {
        return candidate;
      }
    }

    const fileUrls = Array.isArray(inputObject.file_urls) ? inputObject.file_urls : [];
    for (const item of fileUrls) {
      const value = this.stringOrUndefined(item);
      if (value && /^https?:\/\//i.test(value)) {
        return value;
      }
    }

    const directFileUrls = Array.isArray(payload.file_urls) ? payload.file_urls : [];
    for (const item of directFileUrls) {
      const value = this.stringOrUndefined(item);
      if (value && /^https?:\/\//i.test(value)) {
        return value;
      }
    }

    return null;
  }

  private collectDashscopeVideoImageInputs(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushCandidate = (raw: unknown) => {
      const text = this.stringOrUndefined(raw);
      if (text && !values.includes(text)) {
        values.push(text);
      }
    };

    ['img_url', 'image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushCandidate(payload[key]));

    const inputObject = this.normalizeObject(payload.input);
    ['img_url', 'image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushCandidate(inputObject[key]));

    const images = Array.isArray(payload.images) ? payload.images : [];
    images.forEach((item) => {
      if (typeof item === 'string') {
        pushCandidate(item);
        return;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        pushCandidate(record.img_url);
        pushCandidate(record.image);
        pushCandidate(record.url);
      }
    });

    return values;
  }

  private collectImageUrlsFromPayload(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushIfUrl = (raw: unknown) => {
      const text = this.stringOrUndefined(raw);
      if (text && /^https?:\/\//i.test(text) && !values.includes(text)) {
        values.push(text);
      }
    };

    ['image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushIfUrl(payload[key]));

    const inputObject = this.normalizeObject(payload.input);
    ['image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushIfUrl(inputObject[key]));

    const images = Array.isArray(payload.images) ? payload.images : [];
    images.forEach((item) => {
      if (typeof item === 'string') {
        pushIfUrl(item);
        return;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        pushIfUrl(record.image);
        pushIfUrl(record.url);
      }
    });

    const messages = Array.isArray(inputObject.messages) ? inputObject.messages : [];
    messages.forEach((message) => {
      const messageObj = this.normalizeObject(message);
      const content = Array.isArray(messageObj.content) ? messageObj.content : [];
      content.forEach((part) => {
        const partObj = this.normalizeObject(part);
        pushIfUrl(partObj.image);
        pushIfUrl(partObj.url);
      });
    });

    return values;
  }

  private collectDashscopeWanImageInputs(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    const pushCandidate = (raw: unknown, keyHint?: string) => {
      const normalized = this.normalizeDashscopeWanImageInput(raw, keyHint);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    };

    ['image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushCandidate(payload[key], key));

    const inputObject = this.normalizeObject(payload.input);
    ['image', 'image_url', 'reference_image', 'reference_image_url', 'ref_image', 'ref_image_url']
      .forEach((key) => pushCandidate(inputObject[key], key));

    const images = Array.isArray(payload.images) ? payload.images : [];
    images.forEach((item) => {
      if (typeof item === 'string') {
        pushCandidate(item, 'images');
        return;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        pushCandidate(record.image, 'image');
        pushCandidate(record.url, 'url');
        pushCandidate(record.b64_json, 'b64_json');
      }
    });

    const messages = Array.isArray(inputObject.messages) ? inputObject.messages : [];
    messages.forEach((message) => {
      const messageObj = this.normalizeObject(message);
      const content = Array.isArray(messageObj.content) ? messageObj.content : [];
      content.forEach((part) => {
        const partObj = this.normalizeObject(part);
        pushCandidate(partObj.image, 'image');
        pushCandidate(partObj.url, 'url');
        pushCandidate(partObj.b64_json, 'b64_json');
      });
    });

    const multipart = this.extractMultipartInstruction(payload);
    if (multipart) {
      pushCandidate(this.stringOrUndefined(multipart.file_base64), 'file_base64');
    }

    return values;
  }

  private normalizeDashscopeWanImageInput(raw: unknown, keyHint?: string): string | null {
    const text = this.stringOrUndefined(raw);
    if (!text) {
      return null;
    }
    if (/^https?:\/\//i.test(text)) {
      return text;
    }
    const dataUrl = this.parseDataUrl(text);
    if (dataUrl) {
      return `data:${dataUrl.mimeType};base64,${dataUrl.base64}`;
    }
    const normalizedBase64 = text.replace(/\s+/g, '');
    if (!this.isLikelyBase64(normalizedBase64)) {
      return null;
    }
    const mimeType = this.inferImageMimeTypeFromBase64(normalizedBase64, keyHint);
    return `data:${mimeType};base64,${normalizedBase64}`;
  }

  private inferImageMimeTypeFromBase64(base64Text: string, keyHint?: string): string {
    const normalizedKeyHint = String(keyHint || '').trim().toLowerCase();
    if (normalizedKeyHint.includes('jpeg') || normalizedKeyHint.includes('jpg')) {
      return 'image/jpeg';
    }
    if (normalizedKeyHint.includes('webp')) {
      return 'image/webp';
    }
    if (normalizedKeyHint.includes('gif')) {
      return 'image/gif';
    }
    try {
      const sample = Buffer.from(base64Text.slice(0, 256), 'base64');
      if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
        return 'image/jpeg';
      }
      if (
        sample.length >= 8
        && sample[0] === 0x89
        && sample[1] === 0x50
        && sample[2] === 0x4e
        && sample[3] === 0x47
      ) {
        return 'image/png';
      }
      if (
        sample.length >= 6
        && sample[0] === 0x47
        && sample[1] === 0x49
        && sample[2] === 0x46
        && sample[3] === 0x38
      ) {
        return 'image/gif';
      }
      if (
        sample.length >= 12
        && sample[0] === 0x52
        && sample[1] === 0x49
        && sample[2] === 0x46
        && sample[3] === 0x46
        && sample[8] === 0x57
        && sample[9] === 0x45
        && sample[10] === 0x42
        && sample[11] === 0x50
      ) {
        return 'image/webp';
      }
    } catch {
      // fallback to png
    }
    return 'image/png';
  }

  private normalizeDashscopeImageSize(value: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return '1024*1024';
    }
    if (/^[12]k$/i.test(normalized)) {
      return normalized.toUpperCase();
    }
    const match = normalized.match(/^(\d{2,5})\s*[xX*]\s*(\d{2,5})$/);
    if (match) {
      return `${match[1]}*${match[2]}`;
    }
    return normalized.replace(/x/gi, '*');
  }

  private shouldRetryDashscopeImageOnStatus(status: number, attemptIndex: number, total: number): boolean {
    if (attemptIndex >= total - 1) {
      return false;
    }
    return status === 404 || status === 405;
  }

  private shouldRetryDashscopeImageOnErrorResponse(
    status: number,
    errorBody: string,
    attemptIndex: number,
    total: number,
  ): boolean {
    if (this.shouldRetryDashscopeImageOnStatus(status, attemptIndex, total)) {
      return true;
    }
    if (attemptIndex >= total - 1 || status !== 400) {
      return false;
    }
    const normalized = String(errorBody || '').toLowerCase();
    // multimodal endpoint without reference images should fallback to text2image endpoint.
    return normalized.includes('last message must contain')
      || normalized.includes('got 0 images')
      || normalized.includes('enable_interleave');
  }

  private shouldRetryDashscopeImageOnTaskFailure(errorMessage: string, attemptIndex: number, total: number): boolean {
    if (attemptIndex >= total - 1) {
      return false;
    }
    const normalized = String(errorMessage || '').toLowerCase();
    return normalized.includes('input.messages')
      || normalized.includes('field required')
      || normalized.includes('dashscope task failed');
  }

  private shouldRetryDashscopeImageWithSanitizedPayload(
    status: number,
    errorBody: string,
    endpointPath: string,
    requestPayload: Record<string, unknown>,
  ): boolean {
    if (status !== 400) {
      return false;
    }
    if (endpointPath.includes('/multimodal-generation/')) {
      return false;
    }
    if (!this.containsDashscopeUrlErrorMessage(errorBody)) {
      return false;
    }
    return this.hasDashscopeUrlLikeFields(requestPayload);
  }

  private containsDashscopeUrlErrorMessage(errorBody: string): boolean {
    const normalized = String(errorBody || '').toLowerCase();
    return normalized.includes('url error')
      || normalized.includes('check url')
      || normalized.includes('error-url');
  }

  private hasDashscopeUrlLikeFields(payload: Record<string, unknown>): boolean {
    const input = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    const inputUrlKeys = ['image_url', 'image', 'reference_image_url', 'reference_image', 'ref_image_url', 'ref_image', 'mask_url'];
    if (inputUrlKeys.some((key) => this.stringOrUndefined(input[key]))) {
      return true;
    }
    return Object.keys(parameters).some((key) => key.toLowerCase().includes('url'));
  }

  private buildDashscopeSanitizedImagePayload(payload: Record<string, unknown>): Record<string, unknown> | null {
    const next = this.deepCloneObject(payload);
    let changed = false;

    const input = this.normalizeObject(next.input);
    const inputUrlKeys = ['image_url', 'image', 'reference_image_url', 'reference_image', 'ref_image_url', 'ref_image', 'mask_url'];
    inputUrlKeys.forEach((key) => {
      if (input[key] !== undefined) {
        delete input[key];
        changed = true;
      }
    });
    next.input = input;

    const parameters = this.normalizeObject(next.parameters);
    Object.keys(parameters).forEach((key) => {
      if (key.toLowerCase().includes('url')) {
        delete parameters[key];
        changed = true;
      }
    });
    next.parameters = parameters;

    return changed ? next : null;
  }

  private async parseJsonObjectFromResponse(response: Response): Promise<Record<string, unknown>> {
    const raw = await response.text();
    const trimmed = String(raw || '').trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: trimmed };
    }
  }

  private async resolveDashscopeTaskResultIfNeeded(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
    baseHeaders: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const taskId = this.extractDashscopeTaskId(data);
    if (!taskId) {
      return data;
    }

    const taskStatus = this.extractDashscopeTaskStatus(data);
    if (taskStatus && this.isDashscopeTaskTerminalSuccess(taskStatus)) {
      return data;
    }
    if (taskStatus && this.isDashscopeTaskTerminalFailure(taskStatus)) {
      const message = this.resolveDashscopeTaskErrorMessage(data) || `task_status=${taskStatus}`;
      throw new BadGatewayException(`DashScope task failed: ${message}`);
    }

    return this.pollDashscopeTask(route, payload, taskId, baseHeaders);
  }

  private async fetchDashscopeTaskData(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    taskId: string,
  ): Promise<Record<string, unknown>> {
    const queryEndpointPath = this.resolveDashscopeTaskQueryEndpointPath(payload, taskId);
    const queryUrl = this.buildDashscopeEndpointUrl(route.source.base_url, queryEndpointPath);
    const response = await this.fetchUpstream(route, queryUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${route.source.api_key}`,
        'X-DashScope-Async': 'enable',
        ...route.source.custom_headers,
      },
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new BadGatewayException(
        `DashScope task query failed (${response.status}): ${errorBody || response.statusText || 'request failed'}`,
      );
    }
    return this.parseJsonObjectFromResponse(response);
  }

  private extractDashscopeTaskId(data: Record<string, unknown>): string | null {
    return (
      this.getNestedString(data, ['output', 'task_id'])
      || this.getNestedString(data, ['task_id'])
      || this.getNestedString(data, ['output', 'taskId'])
      || this.getNestedString(data, ['taskId'])
      || null
    );
  }

  private extractDashscopeTaskStatus(data: Record<string, unknown>): string {
    const status =
      this.getNestedString(data, ['output', 'task_status'])
      || this.getNestedString(data, ['task_status'])
      || this.getNestedString(data, ['output', 'taskStatus'])
      || this.getNestedString(data, ['taskStatus'])
      || this.getNestedString(data, ['status'])
      || '';
    return status.toUpperCase();
  }

  private isDashscopeTaskTerminalFailure(status: string): boolean {
    const normalized = String(status || '').toUpperCase();
    return /FAILED|FAIL|ERROR|CANCEL|EXPIRED|REJECT/i.test(normalized);
  }

  private isDashscopeTaskTerminalSuccess(status: string): boolean {
    const normalized = String(status || '').toUpperCase();
    return /SUCCEEDED|SUCCESS|DONE|COMPLETED|FINISHED/i.test(normalized);
  }

  private resolveDashscopeTaskErrorMessage(data: Record<string, unknown>): string {
    return (
      this.getNestedString(data, ['message'])
      || this.getNestedString(data, ['output', 'message'])
      || this.getNestedString(data, ['error', 'message'])
      || this.getNestedString(data, ['output', 'error', 'message'])
      || ''
    );
  }

  private async pollDashscopeTask(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    taskId: string,
    baseHeaders: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const defaultPollAttempts = route.capability === 'video' ? 240 : 40;
    const defaultPollIntervalMs = route.capability === 'video' ? 15000 : 1200;
    const maxPollIntervalMs = route.capability === 'video' ? 30000 : 5000;
    const pollAttempts = this.boundNumber(
      payload.poll_max_attempts ?? payload.max_poll_attempts,
      defaultPollAttempts,
      1,
      route.capability === 'video' ? 240 : 120,
    );
    const pollIntervalMs = this.boundNumber(payload.poll_interval_ms, defaultPollIntervalMs, 300, maxPollIntervalMs);
    const queryEndpointPath = this.resolveDashscopeTaskQueryEndpointPath(payload, taskId);
    const queryUrl = this.buildDashscopeEndpointUrl(route.source.base_url, queryEndpointPath);

    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      const response = await this.fetchUpstream(route, queryUrl, {
        method: 'GET',
        headers: {
          ...baseHeaders,
          'X-DashScope-Async': 'enable',
        },
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new BadGatewayException(
          `DashScope task query failed (${response.status}): ${errorBody || response.statusText || 'request failed'}`,
        );
      }

      const data = await this.parseJsonObjectFromResponse(response);
      const status = this.extractDashscopeTaskStatus(data);
      if (status && this.isDashscopeTaskTerminalSuccess(status)) {
        return data;
      }
      if (status && this.isDashscopeTaskTerminalFailure(status)) {
        const message = this.resolveDashscopeTaskErrorMessage(data) || `task_status=${status}`;
        throw new BadGatewayException(`DashScope task failed: ${message}`);
      }

      if (attempt < pollAttempts) {
        await this.sleep(pollIntervalMs);
      }
    }

    throw new BadGatewayException(`DashScope task polling timeout after ${pollAttempts} attempts`);
  }

  private resolveDashscopeTaskQueryEndpointPath(payload: Record<string, unknown>, taskId: string): string {
    const override = this.stringOrUndefined(payload.query_endpoint_path ?? payload.query_endpoint);
    const encodedTaskId = encodeURIComponent(taskId);
    if (!override) {
      return `${DASHSCOPE_TASK_QUERY_ENDPOINT_PREFIX}${encodedTaskId}`;
    }
    if (/^https?:\/\//i.test(override)) {
      if (override.includes('{task_id}')) {
        return override.replace(/\{task_id\}/g, encodedTaskId);
      }
      if (override.endsWith(`/${encodedTaskId}`)) {
        return override;
      }
      return `${override.replace(/\/+$/, '')}/${encodedTaskId}`;
    }
    if (override.includes('{task_id}')) {
      return override.replace(/\{task_id\}/g, encodedTaskId);
    }

    const normalized = this.normalizeEndpointPath(override);
    const splitIndex = normalized.indexOf('?');
    if (splitIndex >= 0) {
      const pathPart = normalized.slice(0, splitIndex).replace(/\/+$/, '');
      const queryPart = normalized.slice(splitIndex);
      if (pathPart.endsWith(`/${encodedTaskId}`)) {
        return normalized;
      }
      return `${pathPart}/${encodedTaskId}${queryPart}`;
    }
    if (normalized.endsWith(`/${encodedTaskId}`)) {
      return normalized;
    }
    return `${normalized.replace(/\/+$/, '')}/${encodedTaskId}`;
  }

  private extractDashscopeImageUrls(data: Record<string, unknown>): string[] {
    const urls: string[] = [];
    const pushUrl = (value: unknown) => {
      const text = this.stringOrUndefined(value);
      if (text && /^https?:\/\//i.test(text) && !urls.includes(text)) {
        urls.push(text);
      }
    };

    const output = this.normalizeObject(data.output);
    pushUrl(output.image);
    pushUrl(output.image_url);
    pushUrl(output.url);

    const outputResults = Array.isArray(output.results) ? output.results : [];
    outputResults.forEach((item) => {
      const row = this.normalizeObject(item);
      pushUrl(row.image);
      pushUrl(row.image_url);
      pushUrl(row.url);
      const message = this.normalizeObject(row.message);
      const content = Array.isArray(message.content) ? message.content : [];
      content.forEach((part) => {
        const partObj = this.normalizeObject(part);
        pushUrl(partObj.image);
        pushUrl(partObj.image_url);
        pushUrl(partObj.url);
      });
    });

    const choices = Array.isArray(output.choices) ? output.choices : [];
    choices.forEach((choice) => {
      const choiceObj = this.normalizeObject(choice);
      const message = this.normalizeObject(choiceObj.message);
      const content = Array.isArray(message.content) ? message.content : [];
      content.forEach((part) => {
        const partObj = this.normalizeObject(part);
        pushUrl(partObj.image);
        pushUrl(partObj.url);
      });
    });

    const images = Array.isArray(output.images) ? output.images : [];
    images.forEach((item) => {
      if (typeof item === 'string') {
        pushUrl(item);
        return;
      }
      const row = this.normalizeObject(item);
      pushUrl(row.image);
      pushUrl(row.url);
    });

    return urls;
  }

  private extractDashscopeVideoUrls(data: Record<string, unknown>): string[] {
    const urls: string[] = [];
    const pushUrl = (value: unknown) => {
      const text = this.stringOrUndefined(value);
      if (text && /^https?:\/\//i.test(text) && !urls.includes(text)) {
        urls.push(text);
      }
    };

    const output = this.normalizeObject(data.output);
    pushUrl(output.video_url);
    pushUrl(output.video);
    pushUrl(output.url);

    const outputResults = Array.isArray(output.results) ? output.results : [];
    outputResults.forEach((item) => {
      const row = this.normalizeObject(item);
      pushUrl(row.video_url);
      pushUrl(row.video);
      pushUrl(row.url);
    });

    const videos = Array.isArray(output.videos) ? output.videos : [];
    videos.forEach((item) => {
      if (typeof item === 'string') {
        pushUrl(item);
        return;
      }
      const row = this.normalizeObject(item);
      pushUrl(row.video_url);
      pushUrl(row.video);
      pushUrl(row.url);
    });

    return urls;
  }

  private extractDashscopeVideoDurationSeconds(data: Record<string, unknown>): number | null {
    return this.numberOrNull(
      this.getNestedObject(data, ['usage'])?.duration,
      this.getNestedObject(data, ['usage'])?.output_video_duration,
      this.getNestedObject(data, ['usage'])?.video_duration,
      this.getNestedObject(data, ['output'])?.duration,
      this.getNestedObject(data, ['output'])?.output_video_duration,
    );
  }

  private normalizeTranscriptionResponseFormat(value: unknown): string {
    const normalized = String(this.stringOrUndefined(value) || 'json').trim().toLowerCase();
    if (['json', 'text', 'srt', 'vtt', 'verbose_json'].includes(normalized)) {
      return normalized;
    }
    return 'json';
  }

  private extractOpenAiChatText(data: Record<string, unknown>): string {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const fragments: string[] = [];
    choices.forEach((choice) => {
      const choiceObj = this.normalizeObject(choice);
      const message = this.normalizeObject(choiceObj.message);
      const delta = this.normalizeObject(choiceObj.delta);
      [message.content, delta.content].forEach((content) => {
        if (typeof content === 'string') {
          fragments.push(content);
          return;
        }
        if (Array.isArray(content)) {
          content.forEach((part) => {
            if (typeof part === 'string') {
              fragments.push(part);
              return;
            }
            const partObj = this.normalizeObject(part);
            const text = this.stringOrUndefined(partObj.text) || this.stringOrUndefined(partObj.content);
            if (text) {
              fragments.push(text);
            }
          });
        }
      });
    });
    return fragments.join('').trim();
  }

  private extractDashscopeAnnotationValue(data: Record<string, unknown>, key: string): string | null {
    const normalizedKey = key.toLowerCase();
    const choices = Array.isArray(data.choices) ? data.choices : [];
    for (const choice of choices) {
      const message = this.normalizeObject(this.normalizeObject(choice).message);
      const annotations = Array.isArray(message.annotations) ? message.annotations : [];
      for (const annotation of annotations) {
        const value = this.stringOrUndefined(this.normalizeObject(annotation)[normalizedKey]);
        if (value) {
          return value;
        }
      }
    }
    return null;
  }

  private buildSubtitleOutput(data: Record<string, unknown>, fallbackText: string, format: 'srt' | 'vtt'): string {
    const cues = this.extractSubtitleCues(data);
    if (cues.length === 0 && fallbackText.trim()) {
      cues.push({
        start: 0,
        end: this.extractDurationSecondsFromData(data) || 1,
        text: fallbackText.trim(),
      });
    }

    if (format === 'vtt') {
      const body = cues.map((cue) => {
        return `${this.formatSubtitleTime(cue.start, 'vtt')} --> ${this.formatSubtitleTime(cue.end, 'vtt')}\n${cue.text}`;
      }).join('\n\n');
      return `WEBVTT\n\n${body}\n`;
    }

    const body = cues.map((cue, index) => {
      return `${index + 1}\n${this.formatSubtitleTime(cue.start, 'srt')} --> ${this.formatSubtitleTime(cue.end, 'srt')}\n${cue.text}`;
    }).join('\n\n');
    return `${body}\n`;
  }

  private isSubtitleText(text: string, format: 'srt' | 'vtt'): boolean {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return false;
    }
    if (format === 'vtt' && /^WEBVTT\b/i.test(normalized)) {
      return true;
    }
    return /^\d+\s*\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/m.test(normalized);
  }

  private normalizeSubtitleText(text: string): string {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trimEnd();
    return `${normalized}\n`;
  }

  private extractSubtitleCues(value: unknown): Array<{ start: number; end: number; text: string }> {
    const cues: Array<{ start: number; end: number; text: string }> = [];
    const pushCue = (node: Record<string, unknown>) => {
      const text = this.stringOrUndefined(node.text)
        || this.stringOrUndefined(node.sentence)
        || this.stringOrUndefined(node.sentence_text)
        || this.stringOrUndefined(node.transcription);
      if (!text) {
        return;
      }
      const start = this.pickTimestampSeconds(node.start, node.start_time, node.begin_time, node.begin, node.from);
      const end = this.pickTimestampSeconds(node.end, node.end_time, node.finish_time, node.stop, node.to);
      if (start === null && end === null) {
        return;
      }
      const safeStart = start ?? 0;
      const safeEnd = Math.max(end ?? safeStart + 1, safeStart + 0.001);
      cues.push({ start: safeStart, end: safeEnd, text });
    };

    const visit = (node: unknown, depth: number) => {
      if (depth > 8 || node === null || node === undefined) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof node !== 'object') {
        return;
      }
      const record = node as Record<string, unknown>;
      pushCue(record);
      Object.values(record).forEach((child) => visit(child, depth + 1));
    };

    visit(value, 0);
    return cues
      .sort((left, right) => left.start - right.start)
      .filter((cue, index, arr) => index === 0 || cue.start !== arr[index - 1].start || cue.text !== arr[index - 1].text);
  }

  private pickTimestampSeconds(...values: unknown[]): number | null {
    for (const value of values) {
      if (value === null || value === undefined || value === '') {
        continue;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        continue;
      }
      return parsed > 1000 ? parsed / 1000 : parsed;
    }
    return null;
  }

  private formatSubtitleTime(seconds: number, format: 'srt' | 'vtt'): string {
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const ms = totalMs % 1000;
    const totalSeconds = Math.floor(totalMs / 1000);
    const sec = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const min = totalMinutes % 60;
    const hour = Math.floor(totalMinutes / 60);
    const separator = format === 'srt' ? ',' : '.';
    return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
  }

  private async extractDashscopeTranscriptionText(
    data: Record<string, unknown>,
    route: ResolvedAiRoute,
  ): Promise<string> {
    const directText =
      this.getNestedString(data, ['output', 'text'])
      || this.getNestedString(data, ['text'])
      || this.getNestedString(data, ['output', 'transcription']);
    if (directText) {
      return directText;
    }

    const output = this.normalizeObject(data.output);
    const extractedFromOutput = this.extractTextFromTranscriptionPayload(output.results || output.result || output);
    if (extractedFromOutput) {
      return extractedFromOutput;
    }

    const resultUrls = this.extractDashscopeTranscriptionResultUrls(data);
    const transcriptionPayloads: unknown[] = [];
    for (const url of resultUrls) {
      const fetched = await this.fetchDashscopeTranscriptionPayloadByUrl(url, route);
      if (fetched?.payload !== undefined) {
        transcriptionPayloads.push(fetched.payload);
      }
      if (fetched?.text) {
        if (transcriptionPayloads.length) {
          (data as Record<string, unknown>).transcription_payloads = transcriptionPayloads;
        }
        return fetched.text;
      }
    }
    if (transcriptionPayloads.length) {
      (data as Record<string, unknown>).transcription_payloads = transcriptionPayloads;
    }
    return '';
  }

  private extractDashscopeTranscriptionResultUrls(data: Record<string, unknown>): string[] {
    const urls: string[] = [];
    const pushUrl = (value: unknown) => {
      const text = this.stringOrUndefined(value);
      if (text && /^https?:\/\//i.test(text) && !urls.includes(text)) {
        urls.push(text);
      }
    };

    pushUrl(this.getNestedString(data, ['output', 'transcription_url']));
    pushUrl(this.getNestedString(data, ['output', 'result_url']));
    pushUrl(this.getNestedString(data, ['output', 'result', 'transcription_url']));
    pushUrl(this.getNestedString(data, ['output', 'result', 'result_url']));
    pushUrl(this.getNestedString(data, ['output', 'result', 'url']));
    pushUrl(this.getNestedString(data, ['data', 'output_result', 'output', 'result', 'transcription_url']));
    pushUrl(this.getNestedString(data, ['data', 'output_result', 'output', 'result', 'result_url']));
    pushUrl(this.getNestedString(data, ['data', 'output_result', 'output', 'result', 'url']));
    pushUrl(this.getNestedString(data, ['output_result', 'output', 'result', 'transcription_url']));
    pushUrl(this.getNestedString(data, ['output_result', 'output', 'result', 'result_url']));
    pushUrl(this.getNestedString(data, ['output_result', 'output', 'result', 'url']));
    pushUrl(this.getNestedString(data, ['transcription_url']));
    pushUrl(this.getNestedString(data, ['result_url']));

    const output = this.normalizeObject(data.output);
    const results = Array.isArray(output.results) ? output.results : [];
    results.forEach((item) => {
      const row = this.normalizeObject(item);
      pushUrl(row.transcription_url);
      pushUrl(row.result_url);
      pushUrl(row.url);
      const words = Array.isArray(row.words) ? row.words : [];
      words.forEach((word) => {
        const wordObj = this.normalizeObject(word);
        pushUrl(wordObj.url);
      });
    });
    const visit = (node: unknown, depth: number) => {
      if (depth > 8 || node === null || node === undefined) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof node !== 'object') {
        return;
      }
      Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === 'transcription_url' || normalizedKey === 'result_url') {
          pushUrl(value);
          return;
        }
        visit(value, depth + 1);
      });
    };
    visit(data, 0);
    return urls;
  }

  private async fetchDashscopeTranscriptionTextByUrl(url: string, route: ResolvedAiRoute): Promise<string> {
    const tryFetch = async (headers?: Record<string, string>): Promise<string> => {
      try {
        const response = await this.outboundHttp.fetch(url, { method: 'GET', headers }, {
          proxyId: route.source.outbound_proxy_id,
        });
        if (!response.ok) {
          return '';
        }
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          const body = (await response.json()) as Record<string, unknown>;
          return this.extractTextFromTranscriptionPayload(body);
        }
        const text = await response.text();
        return String(text || '').trim();
      } catch {
        return '';
      }
    };

    const withoutAuth = await tryFetch();
    if (withoutAuth) {
      return withoutAuth;
    }
    return tryFetch({
      Authorization: `Bearer ${route.source.api_key}`,
      ...route.source.custom_headers,
    });
  }

  private async fetchDashscopeTranscriptionPayloadByUrl(
    url: string,
    route: ResolvedAiRoute,
  ): Promise<{ payload: unknown; text: string } | null> {
    const tryFetch = async (headers?: Record<string, string>): Promise<{ payload: unknown; text: string } | null> => {
      try {
        const response = await this.outboundHttp.fetch(url, { method: 'GET', headers }, {
          proxyId: route.source.outbound_proxy_id,
        });
        if (!response.ok) {
          return null;
        }
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          const body = (await response.json()) as Record<string, unknown>;
          return { payload: body, text: this.extractTextFromTranscriptionPayload(body) };
        }
        const text = String(await response.text() || '').trim();
        const parsed = this.parseMaybeJson(text);
        if (parsed !== null) {
          return { payload: parsed, text: this.extractTextFromTranscriptionPayload(parsed) };
        }
        return { payload: text, text };
      } catch {
        return null;
      }
    };

    const withoutAuth = await tryFetch();
    if (withoutAuth?.text) {
      return withoutAuth;
    }
    const withAuth = await tryFetch({
      Authorization: `Bearer ${route.source.api_key}`,
      ...route.source.custom_headers,
    });
    return withAuth?.text ? withAuth : withAuth ?? withoutAuth;
  }

  private parseMaybeJson(value: string): unknown | null {
    const trimmed = String(value || '').trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private extractTextFromTranscriptionPayload(value: unknown): string {
    const fragments: string[] = [];
    const push = (raw: unknown) => {
      const text = this.stringOrUndefined(raw);
      if (!text) {
        return;
      }
      if (fragments.includes(text)) {
        return;
      }
      fragments.push(text);
    };

    const visit = (node: unknown, depth: number) => {
      if (depth > 8 || node === null || node === undefined) {
        return;
      }
      if (typeof node === 'string') {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof node !== 'object') {
        return;
      }
      Object.entries(node as Record<string, unknown>).forEach(([key, val]) => {
        const normalizedKey = key.toLowerCase();
        if (typeof val === 'string') {
          if (
            normalizedKey === 'text'
            || normalizedKey === 'transcription'
            || normalizedKey === 'sentence'
            || normalizedKey === 'sentence_text'
          ) {
            push(val);
          }
          return;
        }
        visit(val, depth + 1);
      });
    };

    visit(value, 0);
    return fragments.join('').trim();
  }

  private async forwardDashscopeCosyVoiceTts(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const endpointPath = this.normalizeEndpointPath(route.endpoint_path || DASHSCOPE_COSYVOICE_TTS_ENDPOINT);
    const endpointUrl = this.joinUrl(route.source.base_url, endpointPath);
    const requestPayload = this.buildDashscopeCosyVoiceTtsRequest(route, payload);
    const traceVoiceId = this.stringOrUndefined(requestPayload.input && (requestPayload.input as Record<string, unknown>).voice) || '-';

    this.logAiTrace(
      `[TTS_TRACE] stage=request provider=dashscope-cosyvoice model=${route.model_key} upstream_model=${route.upstream_model} endpoint=${endpointPath} voice_id=${traceVoiceId} text_len=${this.extractTtsTextLength(payload)} req_path=${context.request_path || '-'} user=${context.user_id || '-'}`,
    );

    const upstreamResp = await this.fetchUpstream(route, endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: JSON.stringify(requestPayload),
    }, context);

    if (!upstreamResp.ok) {
      const errorBody = await upstreamResp.text();
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `HTTP ${upstreamResp.status}: ${this.truncate(String(errorBody || ''), 900)}`,
      });
      this.warnAiTrace(
        `[TTS_TRACE] stage=failed provider=dashscope-cosyvoice model=${route.model_key} endpoint=${endpointPath} voice_id=${traceVoiceId} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 360)}`,
      );
      throw new BadGatewayException(
        `DashScope CosyVoice TTS error (${upstreamResp.status}): ${errorBody || upstreamResp.statusText || 'request failed'}`,
      );
    }

    const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
    if (contentType.startsWith('audio/') || contentType.includes('application/octet-stream')) {
      const buffer = Buffer.from(await upstreamResp.arrayBuffer());
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        binary: true,
        status: upstreamResp.status,
        headers: {
          'content-type': upstreamResp.headers.get('content-type') || 'application/octet-stream',
        },
        body: buffer,
      };
    }

    const rawText = await upstreamResp.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = { raw: rawText };
    }
    const usage = this.extractUsageMetrics(data);
    const wantBinary = payload.return_audio_binary === true || payload.return_audio_binary === 'true';
    if (wantBinary) {
      const audioUrl = this.extractDashscopeCosyVoiceAudioUrl(data);
      if (audioUrl) {
        const audio = await this.downloadAudioFromUrl(audioUrl, route.source.api_key, route.source.custom_headers, route.source.outbound_proxy_id);
        if (audio) {
          const audioFormat = this.extractDashscopeCosyVoiceAudioFormat(payload, requestPayload);
          this.logAiTrace(
            `[TTS_TRACE] stage=ok provider=dashscope-cosyvoice model=${route.model_key} endpoint=${endpointPath} voice_id=${traceVoiceId} bytes=${audio.buffer.length} format=${audioFormat}`,
          );
          this.logUsageSafe(route, payload, context, {
            success: true,
            is_stream: false,
            usage,
            request_id: usage.request_id || this.stringOrUndefined(data.request_id),
            latency_ms: Date.now() - startedAt,
          });
          return {
            stream: false,
            binary: true,
            status: 200,
            headers: {
              'content-type': audio.mimeType || this.contentTypeByAudioFormat(audioFormat),
              'content-disposition': `inline; filename="tts.${audioFormat}"`,
            },
            body: audio.buffer,
          };
        }
      }
      const previewRaw = JSON.stringify(data || {});
      throw new BadGatewayException(
        `DashScope CosyVoice TTS response does not contain downloadable audio (model=${route.model_key}, response=${this.truncate(previewRaw, 320)})`,
      );
    }

    this.logUsageSafe(route, payload, context, {
      success: true,
      is_stream: false,
      usage,
      request_id: usage.request_id || this.stringOrUndefined(data.request_id),
      latency_ms: Date.now() - startedAt,
    });
    return {
      stream: false,
      data,
    };
  }

  private async forwardMinimaxTts(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    asyncMode: boolean,
    context: AiInvocationContext,
  ): Promise<ForwardedAiResponse> {
    const startedAt = Date.now();
    const endpointPath = this.resolveMinimaxTtsEndpoint(route.endpoint_path, asyncMode);
    const endpointUrl = this.joinUrl(route.source.base_url, endpointPath);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.source.api_key}`,
      ...route.source.custom_headers,
    };

    const requestPayload = this.buildMinimaxTtsRequest(route, payload, asyncMode);
    const traceVoiceId = this.extractMinimaxVoiceId(requestPayload);
    const traceFormat = this.extractMinimaxAudioFormat(payload, requestPayload);
    const traceText = this.stringOrUndefined(requestPayload.text) || '';
    this.logAiTrace(
      `[TTS_TRACE] stage=request model=${route.model_key} upstream_model=${route.upstream_model} api_type=${route.api_type} endpoint=${endpointPath} async=${asyncMode} voice_id=${traceVoiceId || '-'} format=${traceFormat || '-'} language_boost=${this.stringOrUndefined(requestPayload.language_boost) || '-'} text_len=${traceText.length} req_path=${context.request_path || '-'} user=${context.user_id || '-'}`,
    );

    const upstreamResp = await this.runWithMinimaxTtsKeyQueue(route, () => this.fetchUpstream(route, endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
    }, context));

    if (!upstreamResp.ok) {
      const errorBody = await upstreamResp.text();
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
        error_message: `HTTP ${upstreamResp.status}: ${this.truncate(String(errorBody || ''), 900)}`,
      });
      this.logger.warn(
        `MiniMax TTS upstream failed model=${route.model_key} source=${route.source.name} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 600)}`,
      );
      this.warnAiTrace(
        `[TTS_TRACE] stage=failed model=${route.model_key} endpoint=${endpointPath} voice_id=${traceVoiceId || '-'} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 360)}`,
      );
      throw new BadGatewayException(
        `MiniMax TTS error (${upstreamResp.status}): ${errorBody || upstreamResp.statusText || 'request failed'}`,
      );
    }

    const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      if (contentType.startsWith('audio/') || contentType.includes('application/octet-stream')) {
        const buffer = Buffer.from(await upstreamResp.arrayBuffer());
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage: {},
          latency_ms: Date.now() - startedAt,
        });
        return {
          stream: false,
          binary: true,
          status: upstreamResp.status,
          headers: {
            'content-type': upstreamResp.headers.get('content-type') || 'application/octet-stream',
          },
          body: buffer,
        };
      }
      const rawText = await upstreamResp.text();
      let parsed: Record<string, unknown> = {};
      try {
        const maybeParsed = JSON.parse(rawText);
        if (maybeParsed && typeof maybeParsed === 'object' && !Array.isArray(maybeParsed)) {
          parsed = maybeParsed as Record<string, unknown>;
        }
      } catch {
        parsed = {};
      }
      if (Object.keys(parsed).length > 0) {
        const usage = this.extractUsageMetrics(parsed);
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage,
          request_id: usage.request_id || this.stringOrUndefined(parsed.id),
          latency_ms: Date.now() - startedAt,
        });
        return {
          stream: false,
          data: parsed,
        };
      }
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: false,
        usage: {},
        latency_ms: Date.now() - startedAt,
      });
      return {
        stream: false,
        data: {
          raw: rawText,
        },
      };
    }

    const data = (await upstreamResp.json()) as Record<string, unknown>;
    const usage = this.extractUsageMetrics(data);
    const wantBinary = payload.return_audio_binary === true || payload.return_audio_binary === 'true';

    if (wantBinary) {
      const resolved = await this.resolveMinimaxBinaryAudio(route, payload, requestPayload, data, asyncMode);
      if (resolved) {
        this.logAiTrace(
          `[TTS_TRACE] stage=ok model=${route.model_key} endpoint=${endpointPath} voice_id=${traceVoiceId || '-'} bytes=${resolved.audioBytes.length} format=${resolved.audioFormat}`,
        );
        this.logUsageSafe(route, payload, context, {
          success: true,
          is_stream: false,
          usage,
          request_id: usage.request_id || this.stringOrUndefined(data.id),
          latency_ms: Date.now() - startedAt,
        });
        return {
          stream: false,
          binary: true,
          status: 200,
          headers: {
            'content-type': this.contentTypeByAudioFormat(resolved.audioFormat),
            'content-disposition': `inline; filename="tts.${resolved.audioFormat}"`,
          },
          body: resolved.audioBytes,
        };
      }
      const previewRaw = JSON.stringify(data || {});
      const preview = previewRaw.length > 320 ? `${previewRaw.slice(0, 320)}...` : previewRaw;
      this.logUsageSafe(route, payload, context, {
        success: false,
        is_stream: false,
        usage,
        request_id: usage.request_id || this.stringOrUndefined(data.id),
        latency_ms: Date.now() - startedAt,
        error_message: `MiniMax no playable audio: ${this.truncate(preview, 900)}`,
      });
      this.warnAiTrace(
        `[TTS_TRACE] stage=no-audio model=${route.model_key} endpoint=${endpointPath} voice_id=${traceVoiceId || '-'} preview=${this.truncate(preview, 360)}`,
      );
      throw new BadGatewayException(
        `MiniMax TTS response does not contain playable audio (model=${route.model_key}, api_type=${route.api_type}, endpoint=${endpointPath}, response=${preview})`,
      );
    }

    this.logAiTrace(
      `[TTS_TRACE] stage=ok-json model=${route.model_key} endpoint=${endpointPath} voice_id=${traceVoiceId || '-'} keys=${Object.keys(data || {}).slice(0, 12).join(',')}`,
    );
    this.logUsageSafe(route, payload, context, {
      success: true,
      is_stream: false,
      usage,
      request_id: usage.request_id || this.stringOrUndefined(data.id),
      latency_ms: Date.now() - startedAt,
    });
    return {
      stream: false,
      data,
    };
  }

  async listAvailableModels(appSlug: string, capabilityInput?: string) {
    const capability = capabilityInput ? this.normalizeCapability(capabilityInput) : undefined;
    return this.aiRoutingService.listActiveModelsBySlug(appSlug, capability);
  }

  async listDefaultModelSlots(appSlug: string) {
    return this.aiRoutingService.listAppDefaultModelSlotsBySlug(appSlug);
  }

  async getChatHistory(_userId: string, _limit = 20) {
    return [];
  }

  private normalizeGeminiModelId(modelIdRaw: string): string {
    return String(modelIdRaw || '').trim().replace(/^models\//i, '');
  }

  private async getAvailableGeminiModel(appSlug: string, modelIdRaw: string) {
    const modelId = this.normalizeGeminiModelId(modelIdRaw);
    const models = await this.listAvailableModels(appSlug);
    const matched = models.find((item) => item.model_key === modelId);
    if (!matched) {
      throw new NotFoundException(`model not found: ${modelId}`);
    }
    return matched;
  }

  private serializeGeminiModel(item: Record<string, unknown>): Record<string, unknown> {
    const capability = String(item.capability || '');
    const methods =
      capability === 'embedding'
        ? ['embedContent']
        : capability === 'image'
          ? ['generateContent']
          : ['generateContent', 'streamGenerateContent'];
    return {
      name: `models/${String(item.model_key || '')}`,
      baseModelId: String(item.model_key || ''),
      displayName: String(item.display_name || item.model_key || ''),
      description: `${capability} model via OPG gateway`,
      supportedGenerationMethods: methods,
    };
  }

  private geminiRequestWantsImage(payload: Record<string, unknown>): boolean {
    const generationConfig = this.normalizeObject(payload.generationConfig ?? payload.config);
    const modalitiesRaw = Array.isArray(generationConfig.responseModalities)
      ? generationConfig.responseModalities
      : Array.isArray(payload.response_modalities)
        ? payload.response_modalities
        : [];
    return modalitiesRaw.some((item) => String(item || '').trim().toUpperCase() === 'IMAGE');
  }

  private buildGeminiEmbeddingInput(payload: Record<string, unknown>): string {
    const raw = payload.content ?? payload.contents ?? payload.input;
    const contents = this.normalizeGeminiContentList(raw);
    const text = contents
      .flatMap((item) => item.parts)
      .map((part) => this.stringOrUndefined(part.text))
      .filter((item): item is string => !!item)
      .join('\n')
      .trim();
    if (!text) {
      throw new BadRequestException('content is required');
    }
    return text;
  }

  private async buildGeminiChatInvocationPayload(
    modelId: string,
    payload: Record<string, unknown>,
    stream: boolean,
  ): Promise<Record<string, unknown>> {
    const contents = this.normalizeGeminiContentList(payload.contents ?? payload.input);
    if (contents.length === 0) {
      throw new BadRequestException('contents is required');
    }

    const messages = await Promise.all(contents.map(async (content) => ({
      role: content.role === 'model' ? 'assistant' : 'user',
      content: await this.convertGeminiPartsToOpenAiContent(content.parts),
    })));
    const generationConfig = this.normalizeObject(payload.generationConfig ?? payload.config);
    const request: Record<string, unknown> = {
      model: modelId,
      messages,
      stream,
    };
    this.applyGeminiGenerationConfigToOpenAiPayload(request, generationConfig);
    return request;
  }

  private async buildGeminiImageInvocationPayload(
    modelId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const contents = this.normalizeGeminiContentList(payload.contents ?? payload.input);
    if (contents.length === 0) {
      throw new BadRequestException('contents is required');
    }

    const prompt = contents
      .flatMap((item) => item.parts)
      .map((part) => this.stringOrUndefined(part.text))
      .filter((item): item is string => !!item)
      .join('\n')
      .trim();
    if (!prompt) {
      throw new BadRequestException('Gemini image request requires text prompt');
    }

    const images: string[] = [];
    for (const content of contents) {
      for (const part of content.parts) {
        const normalized = this.normalizeGeminiImagePartToValue(part);
        if (normalized && !images.includes(normalized)) {
          images.push(normalized);
        }
      }
    }

    const generationConfig = this.normalizeObject(payload.generationConfig ?? payload.config);
    const imageConfig = this.normalizeObject(generationConfig.imageConfig ?? generationConfig.image_config);
    const candidateCount = this.pickNumber(generationConfig.candidateCount, payload.candidateCount, payload.n) || 1;
    const mappedSize = this.mapGeminiImageConfigToOpenAiSize(imageConfig);

    const request: Record<string, unknown> = {
      model: modelId,
      prompt,
      n: candidateCount,
      response_format: 'b64_json',
    };
    if (mappedSize) {
      request.size = mappedSize;
    }
    const aspectRatio = this.stringOrUndefined(imageConfig.aspectRatio ?? imageConfig.aspect_ratio);
    if (aspectRatio) {
      request.aspect_ratio = aspectRatio;
    }
    const imageSize = this.stringOrUndefined(imageConfig.imageSize ?? imageConfig.image_size);
    if (imageSize) {
      request.image_size = imageSize;
    }
    if (images[0]) {
      request.image = images[0];
    }
    if (images.length > 1) {
      request.images = images;
    }
    return request;
  }

  private normalizeGeminiContentList(raw: unknown): Array<{ role: 'user' | 'model'; parts: Part[] }> {
    if (typeof raw === 'string') {
      const text = raw.trim();
      return text ? [{ role: 'user', parts: [{ text }] }] : [];
    }

    const array = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const output: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
    for (const item of array) {
      if (!item || typeof item !== 'object') {
        const text = this.normalizePromptToText(item);
        if (text) {
          output.push({ role: 'user', parts: [{ text }] });
        }
        continue;
      }
      const record = item as Record<string, unknown>;
      const roleRaw = String(record.role || 'user').trim().toLowerCase();
      const role: 'user' | 'model' = roleRaw === 'model' ? 'model' : 'user';
      const partsRaw = Array.isArray(record.parts) ? record.parts : record.text ? [{ text: record.text }] : [];
      const parts = partsRaw
        .map((part) => this.normalizeGeminiPart(part))
        .filter((part): part is Part => !!part);
      if (parts.length > 0) {
        output.push({ role, parts });
      }
    }
    return output;
  }

  private normalizeGeminiPart(raw: unknown): Part | null {
    if (typeof raw === 'string') {
      const text = raw.trim();
      return text ? { text } : null;
    }
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const text = this.stringOrUndefined(record.text);
    if (text) {
      return { text };
    }
    const inlineData = this.normalizeObject(record.inlineData ?? record.inline_data);
    const inlineMime = this.stringOrUndefined(inlineData.mimeType ?? inlineData.mime_type);
    const inlineDataValue = this.stringOrUndefined(inlineData.data);
    if (inlineMime && inlineDataValue) {
      return {
        inlineData: {
          mimeType: inlineMime,
          data: inlineDataValue,
        },
      };
    }
    const fileData = this.normalizeObject(record.fileData ?? record.file_data);
    const fileUri = this.stringOrUndefined(fileData.fileUri ?? fileData.file_uri);
    if (fileUri) {
      return {
        fileData: {
          fileUri,
          mimeType: this.stringOrUndefined(fileData.mimeType ?? fileData.mime_type) || 'application/octet-stream',
        },
      };
    }
    return null;
  }

  private async convertGeminiPartsToOpenAiContent(parts: Part[]): Promise<string | Array<Record<string, unknown>>> {
    const textParts = parts
      .map((part) => this.stringOrUndefined(part.text))
      .filter((item): item is string => !!item);
    const imageParts = parts
      .map((part) => this.normalizeGeminiImagePartToValue(part))
      .filter((item): item is string => !!item);

    if (imageParts.length === 0) {
      return textParts.join('\n').trim();
    }

    const content: Array<Record<string, unknown>> = [];
    textParts.forEach((text) => {
      content.push({ type: 'text', text });
    });
    imageParts.forEach((image) => {
      content.push({ type: 'image_url', image_url: { url: image } });
    });
    return content;
  }

  private normalizeGeminiImagePartToValue(part: Part): string | null {
    const inlineMime = this.stringOrUndefined(part.inlineData?.mimeType);
    const inlineData = this.stringOrUndefined(part.inlineData?.data);
    if (inlineMime && inlineData) {
      return `data:${inlineMime};base64,${inlineData}`;
    }
    const fileUri = this.stringOrUndefined(part.fileData?.fileUri);
    if (fileUri) {
      return fileUri;
    }
    return null;
  }

  private applyGeminiGenerationConfigToOpenAiPayload(
    request: Record<string, unknown>,
    generationConfig: Record<string, unknown>,
  ) {
    const temperature = Number(generationConfig.temperature);
    if (Number.isFinite(temperature)) {
      request.temperature = temperature;
    }
    const topP = Number(generationConfig.topP ?? generationConfig.top_p);
    if (Number.isFinite(topP)) {
      request.top_p = topP;
    }
    const maxOutputTokens = Number(generationConfig.maxOutputTokens ?? generationConfig.max_output_tokens);
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
      request.max_tokens = Math.round(maxOutputTokens);
    }
    if (Array.isArray(generationConfig.stopSequences)) {
      request.stop = generationConfig.stopSequences;
    }
  }

  private mapGeminiImageConfigToOpenAiSize(imageConfig: Record<string, unknown>): string | undefined {
    const aspectRatio = this.stringOrUndefined(imageConfig.aspectRatio ?? imageConfig.aspect_ratio) || '1:1';
    const imageSize = (this.stringOrUndefined(imageConfig.imageSize ?? imageConfig.image_size) || '1K').toUpperCase();
    const sizeTable: Record<string, Record<string, string>> = {
      '1K': {
        '1:1': '1024x1024',
        '2:3': '848x1264',
        '3:2': '1264x848',
        '3:4': '896x1200',
        '4:3': '1200x896',
        '4:5': '928x1152',
        '5:4': '1152x928',
        '9:16': '768x1376',
        '16:9': '1376x768',
        '21:9': '1584x672',
      },
      '2K': {
        '1:1': '2048x2048',
        '2:3': '1696x2528',
        '3:2': '2528x1696',
        '3:4': '1792x2400',
        '4:3': '2400x1792',
        '4:5': '1856x2304',
        '5:4': '2304x1856',
        '9:16': '1536x2752',
        '16:9': '2752x1536',
        '21:9': '3168x1344',
      },
      '4K': {
        '1:1': '4096x4096',
        '2:3': '3392x5056',
        '3:2': '5056x3392',
        '3:4': '3584x4800',
        '4:3': '4800x3584',
        '4:5': '3712x4608',
        '5:4': '4608x3712',
        '9:16': '3072x5504',
        '16:9': '5504x3072',
        '21:9': '6336x2688',
      },
    };
    return sizeTable[imageSize]?.[aspectRatio] || sizeTable['1K']['1:1'];
  }

  private mapChatCompletionToGeminiGenerateContent(
    chatData: Record<string, unknown>,
    modelId: string,
  ): Record<string, unknown> {
    const choices = Array.isArray(chatData.choices) ? (chatData.choices as Array<Record<string, unknown>>) : [];
    const mappedCandidates = choices.map((choice, index) => {
      const message = this.normalizeObject(choice.message);
      const content = message.content;
      const text =
        this.stringOrUndefined(content) || this.normalizePromptToText(content) || this.stringOrUndefined(choice.text) || '';
      return {
        content: {
          role: 'model',
          parts: text ? [{ text }] : [],
        },
        finishReason: this.mapOpenAiFinishReasonToGemini(this.stringOrUndefined(choice.finish_reason) || 'stop'),
        index,
      };
    });

    return {
      candidates: mappedCandidates,
      usageMetadata: this.mapOpenAiUsageToGemini(this.normalizeObject(chatData.usage)),
      modelVersion: this.stringOrUndefined(chatData.model) || modelId,
      responseId: this.stringOrUndefined(chatData.id) || undefined,
    };
  }

  private mapImageForwardedResponseToGemini(
    imageData: Record<string, unknown>,
    modelId: string,
  ): Record<string, unknown> {
    const rows = Array.isArray(imageData.data) ? imageData.data : [];
    const candidates = rows.map((row, index) => {
      const record = this.normalizeObject(row);
      const b64 = this.stringOrUndefined(record.b64_json);
      const url = this.stringOrUndefined(record.url);
      const part = b64
        ? { inlineData: { mimeType: 'image/png', data: b64 } }
        : { fileData: { mimeType: 'image/png', fileUri: url || '' } };
      return {
        content: {
          role: 'model',
          parts: [part],
        },
        finishReason: 'STOP',
        index,
      };
    });

    return {
      candidates,
      modelVersion: modelId,
    };
  }

  private mapEmbeddingForwardedResponseToGemini(data: Record<string, unknown>): Record<string, unknown> {
    const rows = Array.isArray(data.data) ? data.data : [];
    const first = rows[0] && typeof rows[0] === 'object' ? rows[0] as Record<string, unknown> : {};
    const embedding = Array.isArray(first.embedding) ? first.embedding : [];
    return {
      embedding: {
        values: embedding,
      },
    };
  }

  private async rewriteDashscopeBase64Inputs(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ): Promise<Record<string, unknown>> {
    if (!this.isDashscopeSource(route.source.provider_type, route.source.base_url)) {
      return payload;
    }
    if (this.isDashscopeWanBase64DirectRoute(route)) {
      return payload;
    }

    const nextPayload = this.deepCloneObject(payload);
    let convertedCount = 0;
    const uploadedUrls = new Map<string, { readableUrl: string; fileRef: string }>();
    const tempFileRefs: string[] = [];

    const convertToTempUrl = async (
      rawBase64Like: string,
      options: {
        fieldKey?: string;
        parentKey?: string;
        mimeTypeHint?: string;
        fileNameHint?: string;
      } = {},
    ): Promise<string | null> => {
      const parsedDataUrl = this.parseDataUrl(rawBase64Like);
      const base64Text = parsedDataUrl ? parsedDataUrl.base64 : rawBase64Like.trim();
      const effectiveMimeType = this.inferMimeTypeFromHints(
        parsedDataUrl?.mimeType,
        options.mimeTypeHint,
        options.fieldKey,
        options.parentKey,
      );

      if (!parsedDataUrl && !this.shouldTreatAsRawBase64(base64Text, options.fieldKey, options.parentKey)) {
        return null;
      }

      const normalizedBase64 = base64Text.replace(/\s+/g, '');
      if (!this.isLikelyBase64(normalizedBase64)) {
        return null;
      }

      if (uploadedUrls.has(normalizedBase64)) {
        return uploadedUrls.get(normalizedBase64)?.readableUrl || null;
      }

      let fileBuffer: Buffer;
      try {
        fileBuffer = Buffer.from(normalizedBase64, 'base64');
      } catch {
        return null;
      }
      if (!fileBuffer.length) {
        return null;
      }

      const uploaded = await this.uploadTempAssetForDashscope(
        route,
        context,
        fileBuffer,
        effectiveMimeType,
        options.fileNameHint || options.fieldKey || options.parentKey || 'asset',
      );
      uploadedUrls.set(normalizedBase64, uploaded);
      if (!tempFileRefs.includes(uploaded.fileRef)) {
        tempFileRefs.push(uploaded.fileRef);
      }
      convertedCount += 1;
      return uploaded.readableUrl;
    };

    const multipart = this.extractMultipartInstruction(nextPayload);
    if (multipart) {
      const fileBase64 = this.stringOrUndefined(multipart.file_base64);
      if (fileBase64) {
        const uploadedUrl = await convertToTempUrl(fileBase64, {
          fieldKey: 'file_base64',
          parentKey: '__multipart',
          mimeTypeHint: this.stringOrUndefined(multipart.file_mime_type),
          fileNameHint: this.stringOrUndefined(multipart.file_name),
        });
        if (uploadedUrl) {
          delete nextPayload.__multipart;
          if (nextPayload.file_url === undefined) {
            nextPayload.file_url = uploadedUrl;
          }
          if (route.capability === 'stt') {
            if (nextPayload.audio_url === undefined) {
              nextPayload.audio_url = uploadedUrl;
            }
            if (nextPayload.url === undefined) {
              nextPayload.url = uploadedUrl;
            }
            const inputObject = this.normalizeObject(nextPayload.input);
            if (!inputObject.file_url && !inputObject.audio_url && Object.keys(inputObject).length > 0) {
              inputObject.audio_url = uploadedUrl;
              nextPayload.input = inputObject;
            }
          }
        }
      }
    }

    const rewriteNode = async (
      value: unknown,
      parent: Record<string, unknown> | unknown[] | null,
      key: string | number | null,
      parentKey?: string,
      siblingObject?: Record<string, unknown>,
    ) => {
      if (typeof value === 'string') {
        const converted = await convertToTempUrl(value, {
          fieldKey: typeof key === 'string' ? key : undefined,
          parentKey,
          mimeTypeHint: this.resolveMimeTypeHintFromSiblings(
            siblingObject,
            typeof key === 'string' ? key : undefined,
          ),
          fileNameHint: this.resolveFileNameHintFromSiblings(
            siblingObject,
            typeof key === 'string' ? key : undefined,
          ),
        });
        if (converted && parent && key !== null) {
          (parent as any)[key] = converted;
        }
        return;
      }

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          await rewriteNode(value[i], value, i, parentKey, siblingObject);
        }
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      const record = value as Record<string, unknown>;
      const currentKey = typeof key === 'string' ? key : parentKey;
      for (const [childKey, childValue] of Object.entries(record)) {
        if (childKey === '__multipart') {
          continue;
        }
        await rewriteNode(childValue, record, childKey, currentKey, record);
      }
    };

    await rewriteNode(nextPayload, null, null, undefined, nextPayload);
    if (convertedCount > 0) {
      this.logger.log(
        `DashScope base64 bridge converted ${convertedCount} asset(s), model=${route.model_key}, capability=${route.capability}`,
      );
    }
    if (tempFileRefs.length > 0) {
      nextPayload[DASHSCOPE_TEMP_FILE_REFS_FIELD] = tempFileRefs;
    }
    return nextPayload;
  }

  private async uploadTempAssetForDashscope(
    route: ResolvedAiRoute,
    context: AiInvocationContext,
    fileBuffer: Buffer,
    mimeType: string,
    fileNameHint: string,
  ): Promise<{ readableUrl: string; fileRef: string }> {
    const extension = this.extensionByMimeType(mimeType);
    const safeName = this.sanitizeFileName(fileNameHint || 'asset');
    const fileName = `${safeName}-${Date.now()}${extension}`;
    const uploaderId = this.stringOrUndefined(context.user_id) || 'system';

    const uploaded = await this.uploadService.uploadBuffer(
      uploaderId,
      fileName,
      mimeType,
      fileBuffer,
      route.app_slug,
      DASHSCOPE_TEMP_UPLOAD_PREFIX,
    );
    const readableUrl = await this.uploadService.resolveReadableUrl(
      uploaded.file_url,
      DASHSCOPE_TEMP_URL_EXPIRES_SECONDS,
    );
    const finalUrl = readableUrl || uploaded.file_url;
    if (!/^https?:\/\//i.test(String(finalUrl || ''))) {
      throw new BadGatewayException(
        'DashScope 临时资源URL生成失败：当前存储返回的不是公网可访问链接，请配置 OSS/CDN 域名',
      );
    }
    return {
      readableUrl: String(finalUrl),
      fileRef: uploaded.file_url,
    };
  }

  private extractDashscopeTempFileRefs(payload: Record<string, unknown>): string[] {
    const refs = payload[DASHSCOPE_TEMP_FILE_REFS_FIELD];
    if (!Array.isArray(refs)) {
      return [];
    }
    return refs
      .map((item) => this.stringOrUndefined(item))
      .filter((item): item is string => !!item);
  }

  private async cleanupDashscopeTempFiles(fileRefs: string[]): Promise<void> {
    if (!Array.isArray(fileRefs) || fileRefs.length === 0) {
      return;
    }
    const uniqueRefs = [...new Set(fileRefs.map((item) => String(item || '').trim()).filter((item) => !!item))];
    await Promise.all(
      uniqueRefs.map(async (fileRef) => {
        try {
          await this.uploadService.deleteByFileUrl(fileRef);
        } catch (error: any) {
          this.logger.warn(
            `DashScope temp file cleanup failed file=${fileRef}: ${error?.message || 'unknown error'}`,
          );
        }
      }),
    );
  }

  private parseDataUrl(value: string): { mimeType: string; base64: string } | null {
    const raw = String(value || '').trim();
    const match = raw.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      return null;
    }
    return {
      mimeType: match[1].toLowerCase(),
      base64: match[2].replace(/\s+/g, ''),
    };
  }

  private isLikelyBase64(value: string): boolean {
    const raw = String(value || '').trim();
    if (!raw || raw.length < 64 || raw.length % 4 !== 0) {
      return false;
    }
    return /^[A-Za-z0-9+/]+={0,2}$/.test(raw);
  }

  private shouldTreatAsRawBase64(value: string, fieldKey?: string, parentKey?: string): boolean {
    if (!this.isLikelyBase64(value)) {
      return false;
    }
    if (this.fieldKeySuggestsBinary(fieldKey) || this.fieldKeySuggestsBinary(parentKey)) {
      return true;
    }
    return false;
  }

  private fieldKeySuggestsBinary(fieldKey?: string): boolean {
    const normalized = String(fieldKey || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.includes('base64')) {
      return true;
    }
    return BASE64_FIELD_KEYWORDS.some((item) => normalized.includes(item));
  }

  private resolveMimeTypeHintFromSiblings(
    siblingObject?: Record<string, unknown>,
    fieldKey?: string,
  ): string | undefined {
    if (!siblingObject) {
      return undefined;
    }
    const candidateKeys = [
      `${String(fieldKey || '').trim()}_mime_type`,
      `${String(fieldKey || '').trim()}MimeType`,
      'mime_type',
      'mimetype',
      'content_type',
      'contentType',
      'file_mime_type',
    ].filter((item) => !!item);
    for (const key of candidateKeys) {
      const value = this.stringOrUndefined(siblingObject[key]);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private resolveFileNameHintFromSiblings(
    siblingObject?: Record<string, unknown>,
    fieldKey?: string,
  ): string | undefined {
    if (!siblingObject) {
      return undefined;
    }
    const candidateKeys = [
      `${String(fieldKey || '').trim()}_name`,
      `${String(fieldKey || '').trim()}Name`,
      'file_name',
      'filename',
      'name',
    ].filter((item) => !!item);
    for (const key of candidateKeys) {
      const value = this.stringOrUndefined(siblingObject[key]);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private inferMimeTypeFromHints(...hints: Array<string | undefined>): string {
    for (const hint of hints) {
      const normalized = String(hint || '').trim().toLowerCase();
      if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized)) {
        return normalized;
      }
      if (this.fieldKeySuggestsBinary(normalized)) {
        if (normalized.includes('audio')) {
          return 'audio/wav';
        }
        if (normalized.includes('image') || normalized.includes('mask') || normalized.includes('frame')) {
          return 'image/png';
        }
      }
    }
    return 'application/octet-stream';
  }

  private extensionByMimeType(mimeType: string): string {
    const normalized = String(mimeType || '').trim().toLowerCase();
    if (normalized.includes('png')) return '.png';
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
    if (normalized.includes('webp')) return '.webp';
    if (normalized.includes('gif')) return '.gif';
    if (normalized.startsWith('video/mp4')) return '.mp4';
    if (normalized.includes('quicktime')) return '.mov';
    if (normalized.includes('webm')) return '.webm';
    if (normalized.includes('x-msvideo') || normalized.includes('avi')) return '.avi';
    if (normalized.includes('wav')) return '.wav';
    if (normalized.includes('mp3') || normalized.includes('mpeg')) return '.mp3';
    if (normalized.includes('m4a') || normalized.includes('mp4')) return '.m4a';
    if (normalized.includes('ogg')) return '.ogg';
    if (normalized.includes('flac')) return '.flac';
    return '.bin';
  }

  private sanitizeFileName(raw: string): string {
    const normalized = String(raw || 'asset')
      .replace(/[^a-z0-9_-]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return normalized.slice(0, 40) || 'asset';
  }

  private deepCloneObject(input: Record<string, unknown>): Record<string, unknown> {
    try {
      return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    } catch {
      return { ...input };
    }
  }

  private isDashscopeSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('dashscope')
      || provider.includes('aliyun')
      || url.includes('dashscope.aliyuncs.com')
      || url.includes('dashscope-intl.aliyuncs.com')
      || url.includes('dashscope-us.aliyuncs.com');
  }

  private wrapSseStreamWithUsageLogging(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    source: ReadableStream<Uint8Array> | null,
    startedAt: number,
    release?: AiGatewayRelease,
  ): ReadableStream<Uint8Array> | null {
    if (!source) {
      this.logUsageSafe(route, payload, context, {
        success: true,
        is_stream: true,
        usage: {},
        latency_ms: Date.now() - startedAt,
      });
      release?.();
      return null;
    }

    const textDecoder = new TextDecoder();
    let lineBuffer = '';
    let latestUsage: AiUsageMetrics = {};
    let streamedText = '';

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = source.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            if (!chunk.value) {
              continue;
            }

            controller.enqueue(chunk.value);
            lineBuffer += textDecoder.decode(chunk.value, { stream: true });
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) {
                continue;
              }
              const raw = trimmed.slice(5).trim();
              if (!raw || raw === '[DONE]') {
                continue;
              }
              try {
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                streamedText += this.extractStreamDeltaText(parsed);
                const usage = this.extractUsageMetrics(parsed);
                latestUsage = {
                  request_id: usage.request_id || latestUsage.request_id || null,
                  prompt_tokens: usage.prompt_tokens ?? latestUsage.prompt_tokens ?? null,
                  completion_tokens: usage.completion_tokens ?? latestUsage.completion_tokens ?? null,
                  total_tokens: usage.total_tokens ?? latestUsage.total_tokens ?? null,
                };
              } catch {
                // ignore non-json sse frames
              }
            }
          }

          this.logUsageSafe(route, payload, context, {
            success: true,
            is_stream: true,
            usage: this.withEstimatedStreamUsageFallback(payload, latestUsage, streamedText),
            request_id: latestUsage.request_id || null,
            latency_ms: Date.now() - startedAt,
          });
          controller.close();
        } catch (error: any) {
          this.logUsageSafe(route, payload, context, {
            success: false,
            is_stream: true,
            usage: latestUsage,
            request_id: latestUsage.request_id || null,
            latency_ms: Date.now() - startedAt,
            error_message: this.truncate(String(error?.message || 'stream forwarding failed'), 900),
          });
          controller.error(error);
        } finally {
          reader.releaseLock();
          release?.();
        }
      },
      cancel: async () => {
        try {
          await source.cancel();
        } catch {
          // ignore cancellation errors
        } finally {
          release?.();
        }
      },
    });
  }

  private extractUsageMetrics(data: Record<string, unknown>): AiUsageMetrics {
    const usageObj = this.resolveUsageObject(data);
    const promptTokens = this.pickNumber(
      usageObj.prompt_tokens,
      usageObj.input_tokens,
      usageObj.promptTokens,
      usageObj.inputTokens,
      usageObj.promptTokenCount,
      usageObj.inputTokenCount,
      usageObj.prompt_token_count,
      usageObj.input_token_count,
    );
    const completionTokens = this.pickNumber(
      usageObj.completion_tokens,
      usageObj.output_tokens,
      usageObj.completionTokens,
      usageObj.outputTokens,
      usageObj.candidatesTokenCount,
      usageObj.completionTokenCount,
      usageObj.outputTokenCount,
      usageObj.candidates_token_count,
      usageObj.completion_token_count,
      usageObj.output_token_count,
      usageObj.generated_tokens,
    );
    const totalFromUsage = this.pickNumber(
      usageObj.total_tokens,
      usageObj.totalTokens,
      usageObj.totalTokenCount,
      usageObj.total_token_count,
      usageObj.tokens,
    );
    const totalTokens =
      totalFromUsage
      ?? ((promptTokens ?? 0) + (completionTokens ?? 0) > 0 ? (promptTokens ?? 0) + (completionTokens ?? 0) : null);
    const cacheCreation = this.normalizeObject(usageObj.cache_creation);
    const cacheCreation5mInputTokens = this.pickNumber(
      cacheCreation.ephemeral_5m_input_tokens,
      cacheCreation.ephemeral5mInputTokens,
    );
    const cacheCreation1hInputTokens = this.pickNumber(
      cacheCreation.ephemeral_1h_input_tokens,
      cacheCreation.ephemeral1hInputTokens,
    );
    const cacheReadInputTokens = this.pickNumber(
      usageObj.cache_read_input_tokens,
      usageObj.cacheReadInputTokens,
      usageObj.cachedContentTokenCount,
      usageObj.cached_content_token_count,
      this.getNestedObject(usageObj, ['prompt_tokens_details'])?.cached_tokens,
      this.getNestedObject(usageObj, ['input_tokens_details'])?.cached_tokens,
      usageObj.prompt_cache_hit_tokens,
      usageObj.promptCacheHitTokens,
    );
    const cacheCreationInputTokens =
      this.pickNumber(
        usageObj.cache_creation_input_tokens,
        usageObj.cacheCreationInputTokens,
      )
      ?? ((cacheCreation5mInputTokens ?? 0) + (cacheCreation1hInputTokens ?? 0) > 0
        ? (cacheCreation5mInputTokens ?? 0) + (cacheCreation1hInputTokens ?? 0)
        : null);
    const uncachedInputTokens = this.pickNumber(
      usageObj.prompt_cache_miss_tokens,
      usageObj.promptCacheMissTokens,
      usageObj.uncached_input_tokens,
      usageObj.uncachedInputTokens,
    );
    const cachedInputTokens =
      (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) > 0
        ? (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
        : null;

    return {
      request_id:
        this.stringOrUndefined(data.id)
        || this.stringOrUndefined(data.request_id)
        || this.stringOrUndefined(data.requestId)
        || this.stringOrUndefined(this.getNestedObject(data, ['response'])?.id)
        || null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      uncached_input_tokens: uncachedInputTokens,
      cached_input_tokens: cachedInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_creation_5m_input_tokens: cacheCreation5mInputTokens,
      cache_creation_1h_input_tokens: cacheCreation1hInputTokens,
      duration_seconds: this.extractDurationSecondsFromData(data),
      image_count: this.extractImageCountFromData(data),
      video_resolution: this.extractVideoResolutionFromData(data),
    };
  }

  private resolveUsageObject(data: Record<string, unknown>): Record<string, unknown> {
    const direct = this.normalizeObject(data.usage);
    if (Object.keys(direct).length > 0) {
      return this.aggregateUsageObject(direct);
    }

    const candidates = [
      this.normalizeObject(data.usageMetadata),
      this.normalizeObject(data.usage_metadata),
      this.normalizeObject(this.getNestedObject(data, ['data', 'usage'])),
      this.normalizeObject(this.getNestedObject(data, ['data', 'usageMetadata'])),
      this.normalizeObject(this.getNestedObject(data, ['data', 'usage_metadata'])),
      this.normalizeObject(this.getNestedObject(data, ['response', 'usage'])),
      this.normalizeObject(this.getNestedObject(data, ['response', 'usageMetadata'])),
      this.normalizeObject(this.getNestedObject(data, ['response', 'usage_metadata'])),
      this.normalizeObject(this.getNestedObject(data, ['output', 'usage'])),
      this.normalizeObject(this.getNestedObject(data, ['output', 'usageMetadata'])),
      this.normalizeObject(this.getNestedObject(data, ['output', 'usage_metadata'])),
    ];

    for (const candidate of candidates) {
      if (Object.keys(candidate).length > 0) {
        return this.aggregateUsageObject(candidate);
      }
    }

    if (this.objectLooksLikeUsage(data)) {
      return data;
    }
    return {};
  }

  private aggregateUsageObject(usage: Record<string, unknown>): Record<string, unknown> {
    const details = Array.isArray(usage.models)
      ? usage.models
      : Array.isArray(usage.model_usage)
        ? usage.model_usage
        : null;
    if (!details) {
      return usage;
    }
    const topPromptTokens = this.pickNumber(usage.prompt_tokens, usage.input_tokens, usage.promptTokenCount, usage.inputTokenCount);
    const topCompletionTokens = this.pickNumber(
      usage.completion_tokens,
      usage.output_tokens,
      usage.candidatesTokenCount,
      usage.outputTokenCount,
    );
    const topTotalTokens = this.pickNumber(usage.total_tokens, usage.totalTokenCount, usage.tokens);
    let detailPromptTokens = 0;
    let detailCompletionTokens = 0;
    let detailTotalTokens = 0;
    for (const item of details) {
      const detail = this.normalizeObject(item);
      detailPromptTokens += this.pickNumber(detail.prompt_tokens, detail.input_tokens, detail.inputTokenCount) || 0;
      detailCompletionTokens += (
        this.pickNumber(detail.completion_tokens, detail.output_tokens, detail.candidatesTokenCount, detail.outputTokenCount) || 0
      );
      detailTotalTokens += this.pickNumber(detail.total_tokens, detail.totalTokenCount, detail.tokens) || 0;
    }
    const promptTokens = topPromptTokens ?? (detailPromptTokens > 0 ? detailPromptTokens : null);
    const completionTokens = topCompletionTokens ?? (detailCompletionTokens > 0 ? detailCompletionTokens : null);
    const totalTokens = topTotalTokens ?? (detailTotalTokens > 0 ? detailTotalTokens : null);
    return {
      ...usage,
      prompt_tokens: promptTokens && promptTokens > 0 ? promptTokens : usage.prompt_tokens,
      completion_tokens: completionTokens && completionTokens > 0 ? completionTokens : usage.completion_tokens,
      total_tokens: totalTokens && totalTokens > 0 ? totalTokens : usage.total_tokens,
    };
  }

  private objectLooksLikeUsage(value: Record<string, unknown>): boolean {
    return [
      'prompt_tokens',
      'input_tokens',
      'completion_tokens',
      'output_tokens',
      'total_tokens',
      'promptTokenCount',
      'candidatesTokenCount',
      'totalTokenCount',
    ].some((key) => value[key] !== undefined);
  }

  private extractStreamDeltaText(data: Record<string, unknown>): string {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const parts: string[] = [];
    for (const choice of choices) {
      const choiceObj = this.normalizeObject(choice);
      const delta = this.normalizeObject(choiceObj.delta);
      const message = this.normalizeObject(choiceObj.message);
      const text =
        this.extractTextFromContent(delta.content)
        || this.extractTextFromContent(message.content)
        || this.stringOrUndefined(delta.text)
        || this.stringOrUndefined(choiceObj.text);
      if (text) {
        parts.push(text);
      }
    }
    const eventType = this.stringOrUndefined(data.type);
    if (eventType && (eventType.includes('delta') || eventType.includes('output_text'))) {
      const deltaText = this.stringOrUndefined(data.delta) || this.stringOrUndefined(data.text);
      if (deltaText) {
        parts.push(deltaText);
      }
    }
    return parts.join('');
  }

  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .map((part) => {
        const item = this.normalizeObject(part);
        return this.stringOrUndefined(item.text) || this.stringOrUndefined(item.output_text) || '';
      })
      .join('');
  }

  private withEstimatedStreamUsageFallback(
    payload: Record<string, unknown>,
    usage: AiUsageMetrics,
    streamedText: string,
  ): AiUsageMetrics {
    if (usage.total_tokens || usage.prompt_tokens || usage.completion_tokens) {
      return usage;
    }
    const completionTokens = this.estimateTokensFromText(streamedText);
    if (!completionTokens) {
      return usage;
    }
    const promptTokens = this.estimatePromptTokensForPreflight(payload);
    return {
      ...usage,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  private estimateTokensFromText(text: string): number | null {
    const value = String(text || '').trim();
    if (!value) {
      return null;
    }
    const cjkChars = (value.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const otherChars = Math.max(0, value.length - cjkChars);
    return Math.max(1, Math.ceil(cjkChars + otherChars / 4));
  }

  private extractDurationSecondsFromData(data: Record<string, unknown>): number | null {
    return this.numberOrNull(
      data.duration_seconds,
      data.duration,
      this.getNestedObject(data, ['output'])?.duration_seconds,
      this.getNestedObject(data, ['output'])?.duration,
      this.getNestedObject(data, ['output'])?.output_video_duration,
      this.getNestedObject(data, ['data'])?.duration_seconds,
      this.getNestedObject(data, ['data'])?.duration,
      this.getNestedObject(data, ['usage'])?.duration,
      this.getNestedObject(data, ['usage'])?.output_video_duration,
      this.getNestedObject(data, ['usage'])?.video_duration,
    );
  }

  private extractImageCountFromData(data: Record<string, unknown>): number | null {
    const dataItems = Array.isArray(data.data) ? data.data : null;
    if (dataItems && dataItems.length > 0) {
      return dataItems.length;
    }
    const outputItems = this.getNestedObject(data, ['output']);
    if (outputItems && Array.isArray(outputItems.results) && outputItems.results.length > 0) {
      return outputItems.results.length;
    }
    return null;
  }

  private extractVideoResolutionFromData(data: Record<string, unknown>): string | null {
    const sr = this.numberOrNull(
      this.getNestedObject(data, ['usage'])?.SR,
      this.getNestedObject(data, ['usage'])?.sr,
    );
    if (sr && sr > 0) {
      return `${Math.round(sr)}P`;
    }
    const direct = this.stringOrUndefined(
      this.getNestedObject(data, ['usage'])?.resolution
      || this.getNestedObject(data, ['usage'])?.size
      || this.getNestedObject(data, ['output'])?.resolution
      || this.getNestedObject(data, ['output'])?.size
      || data.resolution,
    );
    if (!direct) {
      return null;
    }
    const normalized = direct.trim().toUpperCase();
    return normalized || null;
  }

  private resolveVideoResolutionFromPayload(payload: Record<string, unknown>): string | null {
    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    const rawResolution =
      this.stringOrUndefined(payload.resolution)
      || this.stringOrUndefined(parameters.resolution)
      || this.stringOrUndefined(payload.size)
      || this.stringOrUndefined(inputObject.size)
      || this.stringOrUndefined(inputObject.resolution);
    return rawResolution ? this.resolveVideoResolutionKey(rawResolution) : null;
  }

  private resolveDurationSecondsFromPayload(payload: Record<string, unknown>): number | null {
    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    return this.numberOrNull(
      payload.duration_seconds,
      payload.audio_duration_seconds,
      payload.video_duration_seconds,
      payload.duration,
      inputObject.duration_seconds,
      inputObject.audio_duration_seconds,
      inputObject.video_duration_seconds,
      inputObject.duration,
      parameters.duration_seconds,
      parameters.audio_duration_seconds,
      parameters.video_duration_seconds,
      parameters.duration,
    );
  }

  private estimateSpeechDurationSecondsFromPayload(payload: Record<string, unknown>): number | null {
    const text =
      this.stringOrUndefined(payload.input)
      || this.stringOrUndefined(payload.text)
      || this.stringOrUndefined(payload.prompt)
      || this.normalizePromptToText(payload.input ?? payload.text ?? payload.prompt);
    if (!text) {
      return null;
    }
    return this.estimateSpeechDurationSecondsFromText(text);
  }

  private estimateSpeechDurationSecondsFromText(text: string): number | null {
    const raw = String(text || '').trim();
    if (!raw) {
      return null;
    }
    const normalized = raw.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    const asciiWordCount = (normalized.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    const cjkCharCount = (normalized.match(/[\u3400-\u9fff]/g) || []).length;
    const punctuationCount = (normalized.match(/[,.!?;:，。！？；：、]/g) || []).length;
    const otherCharCount = Math.max(0, normalized.length - cjkCharCount);

    const estimatedSeconds =
      (asciiWordCount / 2.8)
      + (cjkCharCount / 4.2)
      + (otherCharCount / 18)
      + (punctuationCount * 0.18);

    if (!Number.isFinite(estimatedSeconds) || estimatedSeconds <= 0) {
      return null;
    }
    return Number(Math.min(estimatedSeconds, 20 * 60).toFixed(3));
  }

  private resolveBillingMetrics(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    usage: {
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      uncached_input_tokens?: number | null;
      cached_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
      cache_creation_5m_input_tokens?: number | null;
      cache_creation_1h_input_tokens?: number | null;
      duration_seconds?: number | null;
      image_count?: number | null;
      video_resolution?: string | null;
    },
    mode: 'preflight' | 'actual',
  ): {
    billed_units: number;
    billed_unit_label: 'output_token' | 'token' | 'minute' | 'image' | 'call' | 'second' | 'character';
    billed_input_tokens: number | null;
    billed_cached_input_tokens: number | null;
    billed_cache_write_tokens: number | null;
    billed_output_tokens: number | null;
    billed_duration_seconds: number | null;
    estimated_cost_rmb: number;
    unit_price_mode: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_second' | 'per_mchar';
    effective_unit_price_rmb: number | null;
    effective_unit_price_points: number | null;
    effective_input_unit_price_rmb: number | null;
    effective_cached_input_unit_price_rmb: number | null;
    effective_cache_write_5m_unit_price_rmb: number | null;
    effective_cache_write_1h_unit_price_rmb: number | null;
    effective_output_unit_price_rmb: number | null;
    points_cost_override: number | null;
    points_pricing_source: 'model_points_price' | 'rmb_fallback' | null;
    charge_rmb_override?: number | null;
  } {
    const videoResolutionPricing = this.resolveVideoResolutionPricing(route, payload, usage);
    if (videoResolutionPricing) {
      const billedSeconds = Math.max(0, Number(videoResolutionPricing.duration_seconds || 0));
      const effectiveUnitPriceRmb = Number(videoResolutionPricing.cost_rmb_per_second || 0);
      const sellRmbPerSecond = Number(videoResolutionPricing.sell_rmb_per_second || 0);
      const effectiveUnitPricePoints = Number(videoResolutionPricing.points_per_second || 0);
      const estimatedCostRmb = Number((billedSeconds * effectiveUnitPriceRmb).toFixed(6));
      const chargeRmbOverride = sellRmbPerSecond > 0
        ? Number((billedSeconds * sellRmbPerSecond).toFixed(6))
        : null;
      const pointsCostOverride = effectiveUnitPricePoints > 0
        ? this.normalizePointsCharge(Math.max(0.01, billedSeconds * effectiveUnitPricePoints))
        : null;
      return {
        billed_units: billedSeconds,
        billed_unit_label: 'second',
        billed_input_tokens: null,
        billed_cached_input_tokens: null,
        billed_cache_write_tokens: null,
        billed_output_tokens: null,
        billed_duration_seconds: billedSeconds > 0 ? Math.max(1, Math.round(billedSeconds)) : null,
        estimated_cost_rmb: estimatedCostRmb,
        unit_price_mode: 'per_second',
        effective_unit_price_rmb: effectiveUnitPriceRmb,
        effective_unit_price_points: effectiveUnitPricePoints > 0 ? effectiveUnitPricePoints : null,
        effective_input_unit_price_rmb: null,
        effective_cached_input_unit_price_rmb: null,
        effective_cache_write_5m_unit_price_rmb: null,
        effective_cache_write_1h_unit_price_rmb: null,
        effective_output_unit_price_rmb: null,
        points_cost_override: pointsCostOverride,
        points_pricing_source: pointsCostOverride !== null
          ? 'model_points_price'
          : (chargeRmbOverride !== null ? 'rmb_fallback' : null),
        charge_rmb_override: chargeRmbOverride,
      };
    }

    const imageQualityResolutionPricing = this.resolveImageQualityResolutionPricing(route, payload, usage);
    if (imageQualityResolutionPricing) {
      const quantity = Math.max(1, Number(imageQualityResolutionPricing.quantity || 1));
      const effectiveUnitPriceRmb = Number(imageQualityResolutionPricing.cost_rmb_per_call || 0);
      const sellRmbPerCall = Number(imageQualityResolutionPricing.sell_rmb_per_call || 0);
      const effectiveUnitPricePoints = Number(imageQualityResolutionPricing.points_per_call || 0);
      const estimatedCostRmb = Number((quantity * effectiveUnitPriceRmb).toFixed(6));
      const chargeRmbOverride = sellRmbPerCall > 0
        ? Number((quantity * sellRmbPerCall).toFixed(6))
        : null;
      const pointsCostOverride = effectiveUnitPricePoints > 0
        ? this.normalizePointsCharge(Math.max(0.01, quantity * effectiveUnitPricePoints))
        : null;
      return {
        billed_units: quantity,
        billed_unit_label: 'image',
        billed_input_tokens: null,
        billed_cached_input_tokens: null,
        billed_cache_write_tokens: null,
        billed_output_tokens: null,
        billed_duration_seconds: null,
        estimated_cost_rmb: estimatedCostRmb,
        unit_price_mode: 'per_call',
        effective_unit_price_rmb: effectiveUnitPriceRmb,
        effective_unit_price_points: effectiveUnitPricePoints > 0 ? effectiveUnitPricePoints : null,
        effective_input_unit_price_rmb: null,
        effective_cached_input_unit_price_rmb: null,
        effective_cache_write_5m_unit_price_rmb: null,
        effective_cache_write_1h_unit_price_rmb: null,
        effective_output_unit_price_rmb: null,
        points_cost_override: pointsCostOverride,
        points_pricing_source: pointsCostOverride !== null
          ? 'model_points_price'
          : (chargeRmbOverride !== null ? 'rmb_fallback' : null),
        charge_rmb_override: chargeRmbOverride,
      };
    }

    if (route.capability === 'tts' && route.pricing_mode === 'per_mchar') {
      const characterCount = this.resolveTtsCharacterCountFromPayload(payload);
      const billedCharacters = mode === 'preflight'
        ? Math.max(1, characterCount || 0)
        : Math.max(0, characterCount || 0);
      const costRmbPerMchar = Number(route.rmb_per_mtoken || 0);
      const pointsPer100Chars = Number(route.points_per_call || 0);
      const estimatedCostRmb = costRmbPerMchar > 0
        ? Number(((billedCharacters * costRmbPerMchar) / 1_000_000).toFixed(6))
        : 0;
      const pointsCostOverride = pointsPer100Chars > 0 && billedCharacters > 0
        ? this.normalizePointsCharge(Math.max(0.01, (billedCharacters * pointsPer100Chars) / 100))
        : null;
      return {
        billed_units: billedCharacters,
        billed_unit_label: 'character',
        billed_input_tokens: null,
        billed_cached_input_tokens: null,
        billed_cache_write_tokens: null,
        billed_output_tokens: null,
        billed_duration_seconds: null,
        estimated_cost_rmb: estimatedCostRmb,
        unit_price_mode: 'per_mchar',
        effective_unit_price_rmb: costRmbPerMchar,
        effective_unit_price_points: pointsPer100Chars > 0 ? pointsPer100Chars : null,
        effective_input_unit_price_rmb: null,
        effective_cached_input_unit_price_rmb: null,
        effective_cache_write_5m_unit_price_rmb: null,
        effective_cache_write_1h_unit_price_rmb: null,
        effective_output_unit_price_rmb: null,
        points_cost_override: pointsCostOverride,
        points_pricing_source: pointsCostOverride !== null ? 'model_points_price' : null,
      };
    }

    if (route.pricing_mode === 'per_call') {
      const quantity = Math.max(
        1,
        this.normalizePositiveIntegerOrNull(usage.image_count)
          ?? this.normalizePositiveIntegerOrNull(payload.n)
          ?? 1,
      );
      return {
        billed_units: quantity,
        billed_unit_label: route.capability === 'image' ? 'image' : 'call',
        billed_input_tokens: null,
        billed_cached_input_tokens: null,
        billed_cache_write_tokens: null,
        billed_output_tokens: null,
        billed_duration_seconds: null,
        estimated_cost_rmb: this.estimateCostRmb(quantity, route.pricing_mode, route.rmb_per_mtoken, route.rmb_per_call, route.rmb_per_minute),
        unit_price_mode: 'per_call',
        effective_unit_price_rmb: route.rmb_per_call,
        effective_unit_price_points: route.points_per_call > 0 ? route.points_per_call : null,
        effective_input_unit_price_rmb: null,
        effective_cached_input_unit_price_rmb: null,
        effective_cache_write_5m_unit_price_rmb: null,
        effective_cache_write_1h_unit_price_rmb: null,
        effective_output_unit_price_rmb: null,
        points_cost_override: route.points_per_call > 0
          ? this.normalizePointsCharge(Math.max(0.01, quantity * route.points_per_call))
          : null,
        points_pricing_source: route.points_per_call > 0 ? 'model_points_price' : null,
      };
    }

    if (route.pricing_mode === 'per_minute') {
      const durationSeconds = this.numberOrNull(
        usage.duration_seconds,
        this.resolveDurationSecondsFromPayload(payload),
        route.capability === 'tts' ? this.estimateSpeechDurationSecondsFromPayload(payload) : null,
        mode === 'preflight' ? 60 : null,
      );
      const safeDurationSeconds = durationSeconds && durationSeconds > 0 ? durationSeconds : 0;
      if (safeDurationSeconds <= 0) {
        return {
          billed_units: 0,
          billed_unit_label: 'minute',
          billed_input_tokens: null,
          billed_cached_input_tokens: null,
          billed_cache_write_tokens: null,
          billed_output_tokens: null,
          billed_duration_seconds: null,
          estimated_cost_rmb: 0,
          unit_price_mode: 'per_minute',
          effective_unit_price_rmb: route.rmb_per_minute,
          effective_unit_price_points: route.points_per_minute > 0 ? route.points_per_minute : null,
          effective_input_unit_price_rmb: null,
          effective_cached_input_unit_price_rmb: null,
          effective_cache_write_5m_unit_price_rmb: null,
          effective_cache_write_1h_unit_price_rmb: null,
          effective_output_unit_price_rmb: null,
          points_cost_override: null,
          points_pricing_source: null,
        };
      }
      const billedMinutes = Number((safeDurationSeconds / 60).toFixed(6));
      return {
        billed_units: billedMinutes,
        billed_unit_label: 'minute',
        billed_input_tokens: null,
        billed_cached_input_tokens: null,
        billed_cache_write_tokens: null,
        billed_output_tokens: null,
        billed_duration_seconds: Math.max(1, Math.round(safeDurationSeconds)),
        estimated_cost_rmb: this.estimateCostRmb(
          billedMinutes,
          route.pricing_mode,
          route.rmb_per_mtoken,
          route.rmb_per_call,
          route.rmb_per_minute,
        ),
        unit_price_mode: 'per_minute',
        effective_unit_price_rmb: route.rmb_per_minute,
        effective_unit_price_points: route.points_per_minute > 0 ? route.points_per_minute : null,
        effective_input_unit_price_rmb: null,
        effective_cached_input_unit_price_rmb: null,
        effective_cache_write_5m_unit_price_rmb: null,
        effective_cache_write_1h_unit_price_rmb: null,
        effective_output_unit_price_rmb: null,
        points_cost_override: route.points_per_minute > 0
          ? this.normalizePointsCharge(Math.max(0.01, billedMinutes * route.points_per_minute))
          : null,
        points_pricing_source: route.points_per_minute > 0 ? 'model_points_price' : null,
      };
    }

    if (route.capability === 'chat') {
      return this.resolveLlmTokenBillingMetrics(route, payload, usage, mode);
    }

    const tokenUnits = this.resolveBillableTokenUnits(route, payload, usage, mode);
    return {
      billed_units: tokenUnits,
      billed_unit_label: route.capability === 'embedding' ? 'token' : 'output_token',
      billed_input_tokens: route.capability === 'embedding' ? tokenUnits : null,
      billed_cached_input_tokens: null,
      billed_cache_write_tokens: null,
      billed_output_tokens: route.capability === 'embedding' ? null : tokenUnits,
      billed_duration_seconds: null,
      estimated_cost_rmb: this.estimateCostRmb(
        tokenUnits,
        route.pricing_mode,
        route.rmb_per_mtoken,
        route.rmb_per_call,
        route.rmb_per_minute,
      ),
      unit_price_mode: 'per_mtoken',
      effective_unit_price_rmb: route.rmb_per_mtoken,
      effective_unit_price_points: route.points_per_mtoken > 0 ? route.points_per_mtoken : null,
      effective_input_unit_price_rmb: null,
      effective_cached_input_unit_price_rmb: null,
      effective_cache_write_5m_unit_price_rmb: null,
      effective_cache_write_1h_unit_price_rmb: null,
      effective_output_unit_price_rmb: null,
      points_cost_override: route.points_per_mtoken > 0
        ? this.normalizePointsCharge(Math.max(0.01, (tokenUnits * route.points_per_mtoken) / 1_000_000))
        : null,
      points_pricing_source: route.points_per_mtoken > 0 ? 'model_points_price' : null,
    };
  }

  private resolveLlmTokenBillingMetrics(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    usage: {
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      uncached_input_tokens?: number | null;
      cached_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
      cache_creation_5m_input_tokens?: number | null;
      cache_creation_1h_input_tokens?: number | null;
    },
    mode: 'preflight' | 'actual',
  ) {
    const outputTokens = this.resolveBillableTokenUnits(route, payload, usage, mode);
    if (mode === 'preflight') {
      const estimatedCostRmb = this.estimateCostRmb(
        outputTokens,
        route.pricing_mode,
        route.rmb_per_mtoken,
        route.rmb_per_call,
        route.rmb_per_minute,
      );
      return {
        billed_units: outputTokens,
        billed_unit_label: 'output_token' as const,
        billed_input_tokens: null,
        billed_cached_input_tokens: null,
        billed_cache_write_tokens: null,
        billed_output_tokens: outputTokens,
        billed_duration_seconds: null,
        estimated_cost_rmb: estimatedCostRmb,
        unit_price_mode: 'per_mtoken' as const,
        effective_unit_price_rmb: route.rmb_per_mtoken,
        effective_unit_price_points: route.points_per_mtoken > 0 ? route.points_per_mtoken : null,
        effective_input_unit_price_rmb: null,
        effective_cached_input_unit_price_rmb: null,
        effective_cache_write_5m_unit_price_rmb: null,
        effective_cache_write_1h_unit_price_rmb: null,
        effective_output_unit_price_rmb: route.rmb_per_mtoken,
        points_cost_override: route.points_per_mtoken > 0
          ? this.normalizePointsCharge(Math.max(0.01, (outputTokens * route.points_per_mtoken) / 1_000_000))
          : null,
        points_pricing_source: route.points_per_mtoken > 0 ? 'model_points_price' as const : null,
      };
    }

    const cacheReadTokens = this.normalizePositiveIntegerOrZero(usage.cache_read_input_tokens);
    const cacheCreation5mTokens = this.normalizePositiveIntegerOrZero(usage.cache_creation_5m_input_tokens);
    const cacheCreation1hTokens = this.normalizePositiveIntegerOrZero(usage.cache_creation_1h_input_tokens);
    const cacheCreationTotal = this.normalizePositiveIntegerOrZero(usage.cache_creation_input_tokens);
    const splitCacheCreationTokens = cacheCreation5mTokens + cacheCreation1hTokens;
    const cacheWrite5mTokens = splitCacheCreationTokens > 0
      ? cacheCreation5mTokens
      : cacheCreationTotal;
    const cacheWrite1hTokens = splitCacheCreationTokens > 0 ? cacheCreation1hTokens : 0;
    const cacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens;
    const promptTokens = this.normalizePositiveIntegerOrZero(usage.prompt_tokens);
    const explicitUncachedInputTokens = this.normalizePositiveIntegerOrNull(usage.uncached_input_tokens);
    const derivedUncachedInputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
    const inputTokens = explicitUncachedInputTokens ?? derivedUncachedInputTokens;

    const inputRmb = this.normalizeRmbPerMToken(route.input_rmb_per_mtoken, 0);
    const cachedInputRmb = this.normalizeRmbPerMToken(route.cached_input_rmb_per_mtoken, 0);
    const cacheWrite5mRmb = this.normalizeRmbPerMToken(route.cache_write_5m_rmb_per_mtoken, 0);
    const cacheWrite1hRmb = this.normalizeRmbPerMToken(route.cache_write_1h_rmb_per_mtoken, 0);
    const outputRmb = this.normalizeRmbPerMToken(route.output_rmb_per_mtoken || route.rmb_per_mtoken, 0);
    const estimatedCostRmb = Number((
      this.estimateMTokenCost(inputTokens, inputRmb)
      + this.estimateMTokenCost(cacheReadTokens, cachedInputRmb)
      + this.estimateMTokenCost(cacheWrite5mTokens, cacheWrite5mRmb)
      + this.estimateMTokenCost(cacheWrite1hTokens, cacheWrite1hRmb)
      + this.estimateMTokenCost(outputTokens, outputRmb)
    ).toFixed(6));

    const inputPoints = this.normalizePointsPerMToken(route.points_input_per_mtoken, 0);
    const cachedInputPoints = this.normalizePointsPerMToken(route.points_cached_input_per_mtoken, 0);
    const cacheWrite5mPoints = this.normalizePointsPerMToken(route.points_cache_write_5m_per_mtoken, 0);
    const cacheWrite1hPoints = this.normalizePointsPerMToken(route.points_cache_write_1h_per_mtoken, 0);
    const outputPoints = this.normalizePointsPerMToken(route.points_output_per_mtoken || route.points_per_mtoken, 0);
    const directPoints =
      this.estimateMTokenCost(inputTokens, inputPoints)
      + this.estimateMTokenCost(cacheReadTokens, cachedInputPoints)
      + this.estimateMTokenCost(cacheWrite5mTokens, cacheWrite5mPoints)
      + this.estimateMTokenCost(cacheWrite1hTokens, cacheWrite1hPoints)
      + this.estimateMTokenCost(outputTokens, outputPoints);
    const pointsCostOverride = directPoints > 0
      ? this.normalizePointsCharge(Math.max(0.01, directPoints))
      : null;

    const detailedBillingEnabled = inputRmb > 0
      || cachedInputRmb > 0
      || cacheWrite5mRmb > 0
      || cacheWrite1hRmb > 0
      || inputPoints > 0
      || cachedInputPoints > 0
      || cacheWrite5mPoints > 0
      || cacheWrite1hPoints > 0;
    const billedUnits = detailedBillingEnabled
      ? inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
      : outputTokens;

    return {
      billed_units: billedUnits,
      billed_unit_label: detailedBillingEnabled ? 'token' as const : 'output_token' as const,
      billed_input_tokens: inputTokens,
      billed_cached_input_tokens: cacheReadTokens,
      billed_cache_write_tokens: cacheWriteTokens,
      billed_output_tokens: outputTokens,
      billed_duration_seconds: null,
      estimated_cost_rmb: estimatedCostRmb,
      unit_price_mode: 'per_mtoken' as const,
      effective_unit_price_rmb: outputRmb || route.rmb_per_mtoken,
      effective_unit_price_points: outputPoints > 0 ? outputPoints : null,
      effective_input_unit_price_rmb: inputRmb,
      effective_cached_input_unit_price_rmb: cachedInputRmb,
      effective_cache_write_5m_unit_price_rmb: cacheWrite5mRmb,
      effective_cache_write_1h_unit_price_rmb: cacheWrite1hRmb,
      effective_output_unit_price_rmb: outputRmb,
      points_cost_override: pointsCostOverride,
      points_pricing_source: pointsCostOverride !== null ? 'model_points_price' as const : null,
    };
  }

  private resolveBillableTokenUnits(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    usage: {
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
    },
    mode: 'preflight' | 'actual',
  ): number {
    if (route.capability === 'embedding') {
      return Math.max(1, usage.total_tokens ?? usage.prompt_tokens ?? this.estimatePromptTokensForPreflight(payload));
    }

    if (mode === 'preflight') {
      const declaredOutputTokens = this.pickNumber(payload.max_tokens, payload.max_output_tokens) || 0;
      return Math.max(256, declaredOutputTokens > 0 ? declaredOutputTokens : 512);
    }

    const completionTokens = usage.completion_tokens;
    if (completionTokens && completionTokens > 0) {
      return completionTokens;
    }
    if (usage.total_tokens && usage.prompt_tokens !== null && usage.prompt_tokens !== undefined) {
      const derived = usage.total_tokens - usage.prompt_tokens;
      if (derived > 0) {
        return derived;
      }
    }
    return Math.max(1, usage.total_tokens ?? usage.prompt_tokens ?? 0);
  }

  private resolveTtsCharacterCountFromPayload(payload: Record<string, unknown>): number {
    const inputObject = this.normalizeObject(payload.input);
    const text =
      this.stringOrUndefined(payload.text)
      || this.stringOrUndefined(payload.input)
      || this.stringOrUndefined(payload.prompt)
      || this.stringOrUndefined(payload.content)
      || this.stringOrUndefined(inputObject.text)
      || this.stringOrUndefined(inputObject.input)
      || this.stringOrUndefined(inputObject.prompt)
      || this.normalizePromptToText(payload.input ?? payload.text ?? payload.prompt ?? payload.content);
    if (!text) {
      return 0;
    }
    return Array.from(text).length;
  }

  private resolveVideoResolutionPricing(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    usage: {
      duration_seconds?: number | null;
      video_resolution?: string | null;
    },
  ): {
    resolution: '480P' | '720P' | '1080P' | '2K' | '4K';
    duration_seconds: number;
    cost_rmb_per_second: number;
    sell_rmb_per_second: number;
    points_per_second: number;
  } | null {
    if (route.capability !== 'video') {
      return null;
    }
    const overrides = this.normalizeObject(route.request_overrides);
    const pricingRoot = this.normalizeObject(overrides.pricing);
    const resolutionRates = this.normalizeObject(
      pricingRoot.video_resolution_rates || overrides.video_resolution_rates,
    );
    if (Object.keys(resolutionRates).length === 0) {
      return null;
    }

    const resolution = this.resolveVideoResolutionKey(
      this.stringOrUndefined(usage.video_resolution)
      || this.stringOrUndefined(payload.resolution)
      || this.stringOrUndefined(this.normalizeObject(payload.parameters).resolution)
      || this.stringOrUndefined(payload.size)
      || this.stringOrUndefined(this.normalizeObject(payload.input).size),
    );
    const rate = this.normalizeObject(
      resolutionRates[resolution]
      || resolutionRates[resolution.toLowerCase()]
      || resolutionRates[resolution.replace('P', 'p')]
      || resolutionRates[resolution.replace('K', 'k')],
    );
    const costRmbPerSecond = this.numberOrNull(
      rate.cost_rmb_per_second,
      rate.costRmbPerSecond,
      rate.rmb_per_second,
      rate.rmbPerSecond,
      rate.cost_per_second,
      rate.costPerSecond,
    ) || 0;
    const sellRmbPerSecond = this.numberOrNull(
      rate.sell_rmb_per_second,
      rate.sellRmbPerSecond,
      rate.price_rmb_per_second,
      rate.priceRmbPerSecond,
      rate.sale_rmb_per_second,
      rate.saleRmbPerSecond,
      rate.public_rmb_per_second,
      rate.publicRmbPerSecond,
    ) || 0;
    const pointsPerSecond = this.numberOrNull(
      rate.points_per_second,
      rate.pointsPerSecond,
      rate.sell_points_per_second,
      rate.sellPointsPerSecond,
    ) || 0;
    if (costRmbPerSecond <= 0 && sellRmbPerSecond <= 0 && pointsPerSecond <= 0) {
      return null;
    }

    const durationSeconds = Math.max(
      0,
      Number(
        this.numberOrNull(
          usage.duration_seconds,
          this.resolveDurationSecondsFromPayload(payload),
        ) || 0,
      ),
    );
    if (durationSeconds <= 0) {
      return null;
    }

    return {
      resolution,
      duration_seconds: durationSeconds,
      cost_rmb_per_second: Number(costRmbPerSecond),
      sell_rmb_per_second: Number(sellRmbPerSecond),
      points_per_second: Number(pointsPerSecond),
    };
  }

  private resolveImageQualityResolutionPricing(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    usage: {
      image_count?: number | null;
    },
  ): {
    quality: 'low' | 'medium' | 'high';
    resolution: '1K' | '2K' | '4K';
    quantity: number;
    cost_rmb_per_call: number;
    sell_rmb_per_call: number;
    points_per_call: number;
  } | null {
    if (route.capability !== 'image') {
      return null;
    }
    const overrides = this.normalizeObject(route.request_overrides);
    const pricingRoot = this.normalizeObject(overrides.pricing);
    const qualityRates = this.normalizeObject(
      pricingRoot.image_quality_resolution_rates
      || pricingRoot.image_resolution_rates
      || overrides.image_quality_resolution_rates
      || overrides.image_resolution_rates,
    );
    if (Object.keys(qualityRates).length === 0) {
      return null;
    }

    const inputObject = this.normalizeObject(payload.input);
    const parameters = this.normalizeObject(payload.parameters);
    const quality = this.resolveImageQualityKey(
      this.stringOrUndefined(payload.quality)
      || this.stringOrUndefined(parameters.quality)
      || this.stringOrUndefined(inputObject.quality),
    );
    const resolution = this.resolveImageResolutionKey(
      this.stringOrUndefined(payload.resolution)
      || this.stringOrUndefined(payload.image_size)
      || this.stringOrUndefined(payload.imageSize)
      || this.stringOrUndefined(payload.size)
      || this.stringOrUndefined(parameters.resolution)
      || this.stringOrUndefined(parameters.size)
      || this.stringOrUndefined(inputObject.resolution)
      || this.stringOrUndefined(inputObject.image_size)
      || this.stringOrUndefined(inputObject.imageSize)
      || this.stringOrUndefined(inputObject.size),
    );
    const qualityRoot = this.normalizeObject(
      qualityRates[quality]
      || qualityRates[quality.toUpperCase()]
      || qualityRates[quality.toLowerCase()],
    );
    const rate = this.normalizeObject(
      qualityRoot[resolution]
      || qualityRoot[resolution.toLowerCase()]
      || qualityRoot[resolution.replace('K', 'k')]
      || qualityRoot[`${quality}_${resolution}`]
      || qualityRates[`${quality}_${resolution}`]
      || qualityRates[`${quality}_${resolution}`.toLowerCase()],
    );
    const costRmbPerCall = this.numberOrNull(
      rate.cost_rmb_per_call,
      rate.costRmbPerCall,
      rate.rmb_per_call,
      rate.rmbPerCall,
      rate.cost_per_call,
      rate.costPerCall,
      rate.cost_rmb,
      rate.costRmb,
    ) || 0;
    const sellRmbPerCall = this.numberOrNull(
      rate.sell_rmb_per_call,
      rate.sellRmbPerCall,
      rate.price_rmb_per_call,
      rate.priceRmbPerCall,
      rate.sale_rmb_per_call,
      rate.saleRmbPerCall,
      rate.public_rmb_per_call,
      rate.publicRmbPerCall,
      rate.sell_rmb,
      rate.sellRmb,
    ) || 0;
    const pointsPerCall = this.numberOrNull(
      rate.points_per_call,
      rate.pointsPerCall,
      rate.sell_points_per_call,
      rate.sellPointsPerCall,
    ) || 0;
    if (costRmbPerCall <= 0 && sellRmbPerCall <= 0 && pointsPerCall <= 0) {
      return null;
    }

    const quantity = Math.max(
      1,
      this.normalizePositiveIntegerOrNull(usage.image_count)
        ?? this.normalizePositiveIntegerOrNull(payload.n)
        ?? 1,
    );
    return {
      quality,
      resolution,
      quantity,
      cost_rmb_per_call: Number(costRmbPerCall),
      sell_rmb_per_call: Number(sellRmbPerCall),
      points_per_call: Number(pointsPerCall),
    };
  }

  private resolveImageQualityKey(rawValue?: string | null): 'low' | 'medium' | 'high' {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
      return normalized;
    }
    return 'medium';
  }

  private resolveImageResolutionKey(rawValue?: string | null): '1K' | '2K' | '4K' {
    const normalized = String(rawValue || '').trim().toUpperCase();
    if (!normalized) {
      return '1K';
    }
    if (normalized === '4K') {
      return '4K';
    }
    if (normalized === '2K') {
      return '2K';
    }
    if (normalized === '1K') {
      return '1K';
    }
    const matched = normalized.match(/^(\d{3,5})\s*[X*]\s*(\d{3,5})$/);
    if (matched) {
      const maxSide = Math.max(Number(matched[1]), Number(matched[2]));
      if (maxSide >= 3000) {
        return '4K';
      }
      if (maxSide >= 1500) {
        return '2K';
      }
      return '1K';
    }
    if (normalized.includes('4096') || normalized.includes('3840') || normalized.includes('4K')) {
      return '4K';
    }
    if (normalized.includes('2048') || normalized.includes('2K')) {
      return '2K';
    }
    return '1K';
  }

  private buildPublicVideoResolutionRates(requestOverrides: unknown): Array<{
    resolution: string;
    points_per_second: number;
    billing_unit: 'second';
    note: string;
  }> {
    const overrides = this.normalizeObject(requestOverrides);
    const pricingRoot = this.normalizeObject(overrides.pricing);
    const resolutionRates = this.normalizeObject(
      pricingRoot.video_resolution_rates || overrides.video_resolution_rates,
    );
    const rows: Array<{ key: string; note: string }> = [
      { key: '480P', note: '模型原生直出的分辨率。' },
      { key: '720P', note: '模型原生直出的分辨率。' },
      { key: '1080P', note: '基于 720p 原生生成后进行画质放大。' },
      { key: '2K', note: '基于 720p 原生生成后进行画质放大。' },
      { key: '4K', note: '基于 720p 原生生成后进行画质放大。' },
    ];
    return rows
      .map((row) => {
        const rate = this.normalizeObject(
          resolutionRates[row.key]
          || resolutionRates[row.key.toLowerCase()]
          || resolutionRates[row.key.replace('P', 'p')]
          || resolutionRates[row.key.replace('K', 'k')],
        );
        const points = this.numberOrNull(
          rate.points_per_second,
          rate.pointsPerSecond,
          rate.sell_points_per_second,
          rate.sellPointsPerSecond,
        ) || 0;
        return {
          resolution: row.key,
          points_per_second: Number(points),
          billing_unit: 'second' as const,
          note: row.note,
        };
      })
      .filter((row) => row.points_per_second > 0);
  }

  private resolvePublicModelPricingGroup(
    capability: string,
    model: Record<string, unknown>,
  ): {
    type: string;
    label: string;
  } {
    if (capability !== 'video') {
      return this.defaultPublicModelPricingGroup(capability);
    }
    const apiType = String(model.api_type || '').trim().toLowerCase();
    const modelHints = `${String(model.model_key || '')} ${String(model.upstream_model || '')}`.toLowerCase();
    const compactModelHints = modelHints.replace(/[^a-z0-9]/g, '');
    if (apiType === ALIYUN_ICE_VIDEO_TRANSLATION_API_TYPE || compactModelHints.includes('aliyunvideotranslation')) {
      return { type: 'video_translation', label: '视频翻译' };
    }
    if (apiType === DASHSCOPE_VIDEORETALK_API_TYPE || compactModelHints.includes(DASHSCOPE_VIDEORETALK_MODEL_KEY)) {
      return { type: 'video_retalk', label: 'VideoRetalk' };
    }
    return { type: 'video', label: '视频模型' };
  }

  private defaultPublicModelPricingGroup(capability: string): {
    type: string;
    label: string;
  } {
    if (capability === 'chat') return { type: 'chat', label: '文本模型' };
    if (capability === 'embedding') return { type: 'embedding', label: '向量模型' };
    if (capability === 'image') return { type: 'image', label: '图片模型' };
    if (capability === 'tts') return { type: 'tts', label: '语音合成' };
    if (capability === 'stt') return { type: 'stt', label: '语音识别' };
    return { type: 'other', label: '其他模型' };
  }

  private buildPublicImageQualityResolutionRates(requestOverrides: unknown): Array<{
    quality: 'low' | 'medium' | 'high';
    resolution: '1K' | '2K' | '4K';
    price_rmb_per_call: number;
    points_per_call: number;
    billing_unit: 'call';
  }> {
    const overrides = this.normalizeObject(requestOverrides);
    const pricingRoot = this.normalizeObject(overrides.pricing);
    const qualityRates = this.normalizeObject(
      pricingRoot.image_quality_resolution_rates
      || pricingRoot.image_resolution_rates
      || overrides.image_quality_resolution_rates
      || overrides.image_resolution_rates,
    );
    const qualities: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    const resolutions: Array<'1K' | '2K' | '4K'> = ['1K', '2K', '4K'];
    const rows: Array<{
      quality: 'low' | 'medium' | 'high';
      resolution: '1K' | '2K' | '4K';
      price_rmb_per_call: number;
      points_per_call: number;
      billing_unit: 'call';
    }> = [];
    qualities.forEach((quality) => {
      const qualityRoot = this.normalizeObject(
        qualityRates[quality]
        || qualityRates[quality.toUpperCase()]
        || qualityRates[quality.toLowerCase()],
      );
      resolutions.forEach((resolution) => {
        const rate = this.normalizeObject(
          qualityRoot[resolution]
          || qualityRoot[resolution.toLowerCase()]
          || qualityRoot[resolution.replace('K', 'k')]
          || qualityRates[`${quality}_${resolution}`]
          || qualityRates[`${quality}_${resolution}`.toLowerCase()],
        );
        const priceRmb = this.numberOrNull(
          rate.sell_rmb_per_call,
          rate.sellRmbPerCall,
          rate.price_rmb_per_call,
          rate.priceRmbPerCall,
          rate.sale_rmb_per_call,
          rate.saleRmbPerCall,
          rate.public_rmb_per_call,
          rate.publicRmbPerCall,
          rate.sell_rmb,
          rate.sellRmb,
        ) || 0;
        const points = this.numberOrNull(
          rate.points_per_call,
          rate.pointsPerCall,
          rate.sell_points_per_call,
          rate.sellPointsPerCall,
        ) || 0;
        if (priceRmb > 0 || points > 0) {
          rows.push({
            quality,
            resolution,
            price_rmb_per_call: Number(priceRmb),
            points_per_call: Number(points),
            billing_unit: 'call',
          });
        }
      });
    });
    return rows;
  }

  private buildPublicTtsCharacterRate(model: {
    pricing_mode?: unknown;
    points_per_call?: unknown;
  }): {
    points_per_100_chars: number;
    billing_unit: '100_characters';
  } | null {
    const pricingMode = String(model.pricing_mode || '').trim().toLowerCase();
    if (
      pricingMode !== 'per_mchar'
      && pricingMode !== 'per_million_char'
      && pricingMode !== 'per_million_chars'
      && pricingMode !== 'per_million_character'
      && pricingMode !== 'per_million_characters'
    ) {
      return null;
    }
    return {
      points_per_100_chars: Number(model.points_per_call || 0),
      billing_unit: '100_characters',
    };
  }

  private resolveVideoResolutionKey(rawValue?: string | null): '480P' | '720P' | '1080P' | '2K' | '4K' {
    const normalized = String(rawValue || '').trim().toUpperCase();
    if (!normalized) {
      return '720P';
    }
    if (normalized === '4K') {
      return '4K';
    }
    if (normalized === '2K') {
      return '2K';
    }
    if (normalized === '1080P') {
      return '1080P';
    }
    if (normalized === '720P') {
      return '720P';
    }
    if (normalized === '480P') {
      return '480P';
    }
    const matched = normalized.match(/^(\d{3,4})\s*[X*]\s*(\d{3,4})$/);
    if (matched) {
      const width = Number(matched[1]);
      const height = Number(matched[2]);
      const maxSide = Math.max(width, height);
      if (maxSide >= 3800) {
        return '4K';
      }
      if (maxSide >= 2000) {
        return '2K';
      }
      if (maxSide >= 1700 || (width >= 1000 && height >= 1700)) {
        return '1080P';
      }
      if (maxSide <= 854) {
        return '480P';
      }
    }
    if (normalized.includes('4K') || normalized.includes('2160')) {
      return '4K';
    }
    if (normalized.includes('2K') || normalized.includes('1440')) {
      return '2K';
    }
    if (normalized.includes('1080')) {
      return '1080P';
    }
    if (normalized.includes('480')) {
      return '480P';
    }
    return '720P';
  }

  private logUsageSafe(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
    input: {
      success: boolean;
      is_stream: boolean;
      usage: AiUsageMetrics;
      request_id?: string | null;
      usage_reference_id?: string | null;
      latency_ms?: number | null;
      error_message?: string | null;
      billable?: boolean;
    },
  ) {
    if (context.skip_usage_tracking) {
      return;
    }
    const promptTokens = this.normalizePositiveIntegerOrNull(input.usage.prompt_tokens);
    const completionTokens = this.normalizePositiveIntegerOrNull(input.usage.completion_tokens);
    const totalTokens =
      this.normalizePositiveIntegerOrNull(input.usage.total_tokens)
      ?? ((promptTokens ?? 0) + (completionTokens ?? 0) > 0 ? (promptTokens ?? 0) + (completionTokens ?? 0) : null);
    const uncachedInputTokens = this.normalizePositiveIntegerOrNull(input.usage.uncached_input_tokens);
    const cachedInputTokens = this.normalizePositiveIntegerOrNull(input.usage.cached_input_tokens);
    const cacheReadInputTokens = this.normalizePositiveIntegerOrNull(input.usage.cache_read_input_tokens);
    const cacheCreationInputTokens = this.normalizePositiveIntegerOrNull(input.usage.cache_creation_input_tokens);
    const cacheCreation5mInputTokens = this.normalizePositiveIntegerOrNull(input.usage.cache_creation_5m_input_tokens);
    const cacheCreation1hInputTokens = this.normalizePositiveIntegerOrNull(input.usage.cache_creation_1h_input_tokens);
    const durationSeconds = this.numberOrNull(input.usage.duration_seconds);
    const imageCount = this.normalizePositiveIntegerOrNull(input.usage.image_count);
    const videoResolution = this.stringOrUndefined(input.usage.video_resolution) || null;
    const billing = this.resolveBillingMetrics(
      route,
      payload,
      {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        uncached_input_tokens: uncachedInputTokens,
        cached_input_tokens: cachedInputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        cache_creation_5m_input_tokens: cacheCreation5mInputTokens,
        cache_creation_1h_input_tokens: cacheCreation1hInputTokens,
        duration_seconds: durationSeconds,
        image_count: imageCount,
        video_resolution: videoResolution,
      },
      'actual',
    );
    const requestId = input.request_id || input.usage.request_id || null;
    const usageReferenceId =
      this.stringOrUndefined(input.usage_reference_id)
      || this.buildAiUsageReferenceId(route, requestId);

    this.aiGatewayUsageQueue.enqueue('ai-usage-record-and-charge', async () => {
      try {
        await this.aiRoutingService.recordUsage({
          app_id: route.app_id,
          app_slug: route.app_slug,
          user_id: context.user_id || null,
          usage_reference_id: usageReferenceId,
          global_model_id: route.model_id,
          model_key: route.model_key,
          upstream_model: route.upstream_model,
          capability: route.capability,
          source_id: route.source.id,
          source_name: route.source.name,
          provider_type: route.source.provider_type,
          endpoint_path: route.endpoint_path,
          request_path: context.request_path || '',
          request_id: requestId || '',
          is_stream: input.is_stream,
          success: input.success,
          error_message: input.error_message || null,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          uncached_input_tokens: uncachedInputTokens,
          cached_input_tokens: cachedInputTokens,
          cache_read_input_tokens: cacheReadInputTokens,
          cache_creation_input_tokens: cacheCreationInputTokens,
          cache_creation_5m_input_tokens: cacheCreation5mInputTokens,
          cache_creation_1h_input_tokens: cacheCreation1hInputTokens,
          unit_price_rmb_per_mtoken: route.rmb_per_mtoken,
          unit_price_rmb_per_call: billing.unit_price_mode === 'per_call' ? (billing.effective_unit_price_rmb ?? route.rmb_per_call) : route.rmb_per_call,
          unit_price_rmb_per_minute:
            billing.unit_price_mode === 'per_minute' || billing.unit_price_mode === 'per_second'
              ? (billing.effective_unit_price_rmb ?? route.rmb_per_minute)
              : route.rmb_per_minute,
          unit_price_mode: billing.unit_price_mode,
          unit_price_rmb_input_per_mtoken: billing.effective_input_unit_price_rmb ?? 0,
          unit_price_rmb_cached_input_per_mtoken: billing.effective_cached_input_unit_price_rmb ?? 0,
          unit_price_rmb_cache_write_5m_per_mtoken: billing.effective_cache_write_5m_unit_price_rmb ?? 0,
          unit_price_rmb_cache_write_1h_per_mtoken: billing.effective_cache_write_1h_unit_price_rmb ?? 0,
          unit_price_rmb_output_per_mtoken: billing.effective_output_unit_price_rmb ?? 0,
          billed_input_tokens: billing.billed_input_tokens,
          billed_cached_input_tokens: billing.billed_cached_input_tokens,
          billed_cache_write_tokens: billing.billed_cache_write_tokens,
          billed_output_tokens: billing.billed_output_tokens,
          billed_units: billing.billed_units,
          billed_unit_label: billing.billed_unit_label,
          billed_duration_seconds: billing.billed_duration_seconds,
          estimated_cost_rmb: billing.estimated_cost_rmb,
          points_cost: null,
          points_pricing_source: null,
          latency_ms: input.latency_ms ?? null,
        });
      } catch (error: any) {
        this.logger.warn(`failed to record AI usage log: ${error?.message || 'unknown error'}`);
        return;
      }

      if (input.success && input.billable !== false) {
        try {
          await this.chargeAiPointsForUsage(route, payload, context, {
            usage_reference_id: usageReferenceId,
            request_id: requestId,
            is_stream: input.is_stream,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            uncached_input_tokens: uncachedInputTokens,
            cached_input_tokens: cachedInputTokens,
            cache_read_input_tokens: cacheReadInputTokens,
            cache_creation_input_tokens: cacheCreationInputTokens,
            cache_creation_5m_input_tokens: cacheCreation5mInputTokens,
            cache_creation_1h_input_tokens: cacheCreation1hInputTokens,
            billed_input_tokens: billing.billed_input_tokens,
            billed_cached_input_tokens: billing.billed_cached_input_tokens,
            billed_cache_write_tokens: billing.billed_cache_write_tokens,
            billed_output_tokens: billing.billed_output_tokens,
            billed_units: billing.billed_units,
            billed_unit_label: billing.billed_unit_label,
            billed_duration_seconds: billing.billed_duration_seconds,
            estimated_cost_rmb: billing.estimated_cost_rmb,
            points_cost_override: billing.points_cost_override,
            points_pricing_source_override: billing.points_pricing_source,
            charge_rmb_override: billing.charge_rmb_override,
            effective_pricing_mode: billing.unit_price_mode,
            effective_unit_price_rmb: billing.effective_unit_price_rmb,
            effective_unit_price_points: billing.effective_unit_price_points,
            effective_input_unit_price_rmb: billing.effective_input_unit_price_rmb,
            effective_cached_input_unit_price_rmb: billing.effective_cached_input_unit_price_rmb,
            effective_cache_write_5m_unit_price_rmb: billing.effective_cache_write_5m_unit_price_rmb,
            effective_cache_write_1h_unit_price_rmb: billing.effective_cache_write_1h_unit_price_rmb,
            effective_output_unit_price_rmb: billing.effective_output_unit_price_rmb,
          });
        } catch (error: any) {
          this.logger.warn(`failed to charge AI points: ${error?.message || 'unknown error'}`);
        }
      }
    });
  }

  private async assertSufficientPointsBeforeInvoke(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ) {
    if (context.skip_points) {
      return;
    }
    const userId = this.stringOrUndefined(context.user_id);
    if (!userId) {
      return;
    }

    const preflight = this.resolveBillingMetrics(
      route,
      payload,
      {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      },
      'preflight',
    );

    const settings = await this.aiPointsService.getSettingsByAppId(route.app_id);
    const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
    const requiredPoints = this.resolvePointsCharge(route, preflight, pointsPerYuan).points;
    if (requiredPoints <= 0) {
      return;
    }

    const wallet = await this.aiPointsService.getOrCreateWalletByAppId(route.app_id, userId, settings);
    if (wallet.balance < requiredPoints) {
      throw new ForbiddenException(`积分不足，当前剩余 ${wallet.balance.toFixed(2)}，至少需要 ${requiredPoints.toFixed(2)} 积分`);
    }
  }
  private estimatePromptTokensForPreflight(payload: Record<string, unknown>): number {
    const focus =
      payload.messages
      ?? payload.input
      ?? payload.prompt
      ?? payload.text
      ?? payload.content
      ?? payload;
    let text = '';
    try {
      text = typeof focus === 'string' ? focus : JSON.stringify(focus);
    } catch {
      text = String(focus || '');
    }
    const safeChars = Math.min(String(text || '').length, 8000);
    return Math.max(1, Math.ceil(safeChars / 4));
  }

  private normalizePointsPerYuan(value: unknown): number {
    const parsed = this.pickNumber(value);
    if (parsed && parsed > 0) {
      return parsed;
    }
    return DEFAULT_POINTS_PER_YUAN;
  }

  private convertRmbToPoints(costRmb: number, pointsPerYuan: number): number {
    const safeCostRmb = Number(costRmb || 0);
    const safePointsPerYuan = Math.max(0.000001, Number(pointsPerYuan || DEFAULT_POINTS_PER_YUAN));
    if (!Number.isFinite(safeCostRmb) || safeCostRmb <= 0) {
      return 0;
    }
    return this.normalizePointsCharge(Math.max(0.01, safeCostRmb * safePointsPerYuan));
  }

  private resolveAiUsagePointsEventType(capability: AiCapability): string {
    if (capability === 'chat') return 'ai_chat_usage';
    if (capability === 'embedding') return 'ai_embedding_usage';
    if (capability === 'tts') return 'ai_tts_usage';
    if (capability === 'stt') return 'ai_stt_usage';
    if (capability === 'image') return 'ai_image_usage';
    if (capability === 'video') return 'ai_video_usage';
    return 'ai_usage';
  }

  private buildAiUsageReferenceId(route: ResolvedAiRoute, requestId: string | null): string {
    const requestPart = this.stringOrUndefined(requestId);
    if (requestPart) {
      return `${route.model_id}:${requestPart}`.slice(0, 120);
    }
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `${route.model_id}:${Date.now().toString(36)}:${randomPart}`.slice(0, 120);
  }

  private buildAsyncVideoReservationKey(route: ResolvedAiRoute): string {
    const randomPart = Math.random().toString(36).slice(2, 12);
    return `video-reserve:${route.model_id}:${Date.now().toString(36)}:${randomPart}`.slice(0, 120);
  }

  private buildSyncImageReservationKey(route: ResolvedAiRoute): string {
    const randomPart = Math.random().toString(36).slice(2, 12);
    return `image-reserve:${route.model_id}:${Date.now().toString(36)}:${randomPart}`.slice(0, 120);
  }

  private async reserveSyncImagePoints(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    context: AiInvocationContext,
  ) {
    if (context.skip_points) {
      return null;
    }
    const userId = this.stringOrUndefined(context.user_id);
    if (!userId) {
      return null;
    }

    const preflight = this.resolveBillingMetrics(
      route,
      payload,
      {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      },
      'preflight',
    );
    const settings = await this.aiPointsService.getSettingsByAppId(route.app_id);
    const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
    const requiredPoints = this.resolvePointsCharge(route, preflight, pointsPerYuan).points;
    if (requiredPoints <= 0) {
      return null;
    }

    return this.aiPointsService.reservePoints({
      app_id: route.app_id,
      user_id: userId,
      amount: requiredPoints,
      capability: route.capability,
      reservation_key: this.buildSyncImageReservationKey(route),
      metadata: {
        app_slug: route.app_slug,
        model_id: route.model_id,
        model_key: route.model_key,
        upstream_model: route.upstream_model,
        capability: route.capability,
        billed_units: preflight.billed_units,
        billed_unit_label: preflight.billed_unit_label,
        estimated_cost_rmb: preflight.estimated_cost_rmb,
        points_per_yuan: pointsPerYuan,
        request_path: context.request_path || '',
      },
    });
  }

  private async releaseSyncImageReservation(
    route: ResolvedAiRoute,
    reservation: { user_id: string; reservation_key: string },
    taskId: string | null,
    context: AiInvocationContext,
    error: unknown,
  ) {
    const metadata = {
      model_id: route.model_id,
      model_key: route.model_key,
      upstream_model: route.upstream_model,
      capability: route.capability,
      request_path: context.request_path || '',
      error_message: this.truncate(String((error as any)?.message || 'unknown error'), 500),
    };
    if (taskId) {
      const settled = await this.aiPointsService.settleReservation({
        app_id: route.app_id,
        user_id: reservation.user_id,
        external_task_id: taskId,
        success: false,
        settled_points: 0,
        usage_reference_id: this.buildAiUsageReferenceId(route, taskId),
        request_id: taskId,
        metadata,
      });
      if (settled) {
        return;
      }
    }
    await this.aiPointsService.releaseReservationByKey({
      app_id: route.app_id,
      user_id: reservation.user_id,
      reservation_key: reservation.reservation_key,
      metadata,
    });
  }

  private buildAsyncVideoPublicTaskId(route: ResolvedAiRoute): string {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `video-task:${route.model_id}:${Date.now().toString(36)}:${randomPart}`.slice(0, 120);
  }

  private resolveDashscopeVideoConcurrencyLimit(route: ResolvedAiRoute): number {
    const overrides = this.normalizeObject(route.request_overrides?.video_queue);
    return this.boundNumber(
      overrides.concurrency_limit ?? route.request_overrides?.video_concurrency_limit,
      DASHSCOPE_VIDEO_QUEUE_CONCURRENCY_LIMIT,
      1,
      20,
    );
  }

  private async resolveAppIdBySlug(appSlug: string): Promise<string> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM apps WHERE slug = $1 LIMIT 1`,
      appSlug,
    ) as Promise<Array<{ id: string }>>);
    const appId = this.stringOrUndefined(rows[0]?.id);
    if (!appId) {
      throw new NotFoundException(`app not found: ${appSlug}`);
    }
    return appId;
  }

  private async ensureDashscopeVideoQueueSchema() {
    if (this.dashscopeVideoQueueSchemaEnsured) {
      return;
    }
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_async_video_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        public_task_id varchar(128) NOT NULL,
        external_task_id varchar(128) NULL,
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
        model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
        model_key varchar(120) NOT NULL,
        upstream_model varchar(160) NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'QUEUED',
        reservation_key varchar(128) NULL,
        usage_reference_id varchar(120) NULL,
        request_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        response_json jsonb NULL,
        error_message text NULL,
        request_path varchar(255) NULL,
        metadata_json jsonb NULL,
        queued_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_async_video_tasks_public
      ON ai_async_video_tasks(app_id, public_task_id);
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_async_video_tasks_external
      ON ai_async_video_tasks(app_id, external_task_id)
      WHERE external_task_id IS NOT NULL;
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_async_video_tasks_queue
      ON ai_async_video_tasks(source_id, upstream_model, status, queued_at, created_at);
    `);
    this.dashscopeVideoQueueSchemaEnsured = true;
  }

  private normalizeNullableString(value: unknown, maxLength: number): string | null {
    const normalized = this.stringOrUndefined(value);
    if (!normalized) {
      return null;
    }
    return normalized.slice(0, maxLength);
  }

  private async chargeAiPointsForUsage(
    route: ResolvedAiRoute,
    _payload: Record<string, unknown>,
    context: AiInvocationContext,
    input: {
      usage_reference_id: string;
      request_id: string | null;
      is_stream: boolean;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
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
      billed_units: number;
      billed_unit_label: string;
      billed_duration_seconds: number | null;
      estimated_cost_rmb: number;
      points_cost_override?: number | null;
      points_pricing_source_override?: 'model_points_price' | 'rmb_fallback' | null;
      charge_rmb_override?: number | null;
      effective_pricing_mode?: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_second' | 'per_mchar';
      effective_unit_price_rmb?: number | null;
      effective_unit_price_points?: number | null;
      effective_input_unit_price_rmb?: number | null;
      effective_cached_input_unit_price_rmb?: number | null;
      effective_cache_write_5m_unit_price_rmb?: number | null;
      effective_cache_write_1h_unit_price_rmb?: number | null;
      effective_output_unit_price_rmb?: number | null;
    },
  ) {
    const userId = this.stringOrUndefined(context.user_id);
    if (!userId) {
      return;
    }

    const costRmb = Number(input.estimated_cost_rmb || 0);
    const chargeRmb = this.numberOrNull(input.charge_rmb_override) ?? costRmb;

    const settings = await this.aiPointsService.getSettingsByAppId(route.app_id);
    const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
    const pointCharge = this.resolvePointsCharge(
      route,
      {
        billed_units: input.billed_units,
        estimated_cost_rmb: costRmb,
        charge_rmb_override: chargeRmb,
        points_cost_override: input.points_cost_override,
        points_pricing_source_override: input.points_pricing_source_override,
      },
      pointsPerYuan,
    );
    const pointsCost = pointCharge.points;
    if (pointsCost <= 0) {
      return;
    }

    const referenceId = this.stringOrUndefined(input.usage_reference_id) || this.buildAiUsageReferenceId(route, input.request_id);
    try {
      await this.aiPointsService.consumePoints({
        app_id: route.app_id,
        user_id: userId,
        cost: pointsCost,
        event_type: this.resolveAiUsagePointsEventType(route.capability),
        reference_type: 'ai_usage',
        reference_id: referenceId,
        metadata: {
          app_slug: route.app_slug,
          model_id: route.model_id,
          model_key: route.model_key,
          upstream_model: route.upstream_model,
          capability: route.capability,
          pricing_mode: input.effective_pricing_mode || route.pricing_mode,
          unit_price_rmb_per_mtoken: route.rmb_per_mtoken,
          unit_price_rmb_per_call: route.rmb_per_call,
          unit_price_rmb_per_minute: route.rmb_per_minute,
          effective_unit_price_rmb: input.effective_unit_price_rmb,
          effective_unit_price_points: input.effective_unit_price_points,
          effective_input_unit_price_rmb: input.effective_input_unit_price_rmb,
          effective_cached_input_unit_price_rmb: input.effective_cached_input_unit_price_rmb,
          effective_cache_write_5m_unit_price_rmb: input.effective_cache_write_5m_unit_price_rmb,
          effective_cache_write_1h_unit_price_rmb: input.effective_cache_write_1h_unit_price_rmb,
          effective_output_unit_price_rmb: input.effective_output_unit_price_rmb,
          billed_units: input.billed_units,
          billed_unit_label: input.billed_unit_label,
          billed_input_tokens: input.billed_input_tokens,
          billed_cached_input_tokens: input.billed_cached_input_tokens,
          billed_cache_write_tokens: input.billed_cache_write_tokens,
          billed_output_tokens: input.billed_output_tokens,
          billed_duration_seconds: input.billed_duration_seconds,
          estimated_cost_rmb: Number(costRmb.toFixed(6)),
          charge_rmb: Number(chargeRmb.toFixed(6)),
          points_pricing_source: pointCharge.source,
          unit_price_points_per_mtoken: route.points_per_mtoken,
          unit_price_points_input_per_mtoken: route.points_input_per_mtoken,
          unit_price_points_cached_input_per_mtoken: route.points_cached_input_per_mtoken,
          unit_price_points_cache_write_5m_per_mtoken: route.points_cache_write_5m_per_mtoken,
          unit_price_points_cache_write_1h_per_mtoken: route.points_cache_write_1h_per_mtoken,
          unit_price_points_output_per_mtoken: route.points_output_per_mtoken,
          unit_price_points_per_call: route.points_per_call,
          unit_price_points_per_100_chars: input.effective_pricing_mode === 'per_mchar' ? route.points_per_call : undefined,
          unit_price_points_per_minute: route.points_per_minute,
          points_per_yuan: pointsPerYuan,
          points_cost: pointsCost,
          prompt_tokens: input.prompt_tokens,
          completion_tokens: input.completion_tokens,
          total_tokens: input.total_tokens,
          uncached_input_tokens: input.uncached_input_tokens,
          cached_input_tokens: input.cached_input_tokens,
          cache_read_input_tokens: input.cache_read_input_tokens,
          cache_creation_input_tokens: input.cache_creation_input_tokens,
          cache_creation_5m_input_tokens: input.cache_creation_5m_input_tokens,
          cache_creation_1h_input_tokens: input.cache_creation_1h_input_tokens,
          is_stream: input.is_stream,
          request_path: context.request_path || '',
          request_id: input.request_id || null,
        },
      });
      await this.aiRoutingService.updateUsagePointsSettlement({
        usage_reference_id: referenceId,
        points_cost: pointsCost,
        points_pricing_source: pointCharge.source,
      });
    } catch (error) {
      if (error instanceof InsufficientAiPointsError) {
        this.logger.warn(
          `AI points insufficient app=${route.app_slug} user=${userId} model=${route.model_key} required=${error.required} balance=${error.balance}`,
        );
        return;
      }
      throw error;
    }
  }

  private resolvePointsCharge(
    route: ResolvedAiRoute,
    billing: {
      billed_units: number;
      estimated_cost_rmb: number;
      charge_rmb_override?: number | null;
      points_cost_override?: number | null;
      points_pricing_source_override?: 'model_points_price' | 'rmb_fallback' | null;
    },
    pointsPerYuan: number,
  ): { points: number; source: 'model_points_price' | 'rmb_fallback' } {
    const directPoints = Number(billing.points_cost_override || 0);
    if (Number.isFinite(directPoints) && directPoints > 0) {
      return {
        points: this.normalizePointsCharge(directPoints),
        source: billing.points_pricing_source_override || 'model_points_price',
      };
    }

    const billedUnits = Number(billing.billed_units || 0);
    const mode = route.pricing_mode;
    if (Number.isFinite(billedUnits) && billedUnits > 0) {
      if (mode === 'per_mtoken' && route.points_per_mtoken > 0) {
        const points = this.normalizePointsCharge(Math.max(0.01, (billedUnits * route.points_per_mtoken) / 1_000_000));
        return { points, source: 'model_points_price' };
      }
      if (mode === 'per_call' && route.points_per_call > 0) {
        const points = this.normalizePointsCharge(Math.max(0.01, billedUnits * route.points_per_call));
        return { points, source: 'model_points_price' };
      }
      if (mode === 'per_mchar' && route.points_per_call > 0) {
        const points = this.normalizePointsCharge(Math.max(0.01, (billedUnits * route.points_per_call) / 100));
        return { points, source: 'model_points_price' };
      }
      if (mode === 'per_minute' && route.points_per_minute > 0) {
        const points = this.normalizePointsCharge(Math.max(0.01, billedUnits * route.points_per_minute));
        return { points, source: 'model_points_price' };
      }
    }

    const fallback = this.convertRmbToPoints(
      Number(billing.charge_rmb_override ?? billing.estimated_cost_rmb ?? 0),
      pointsPerYuan,
    );
    return {
      points: this.normalizePointsCharge(fallback),
      source: 'rmb_fallback',
    };
  }

  private normalizePointsCharge(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return Number((Math.round((parsed + Number.EPSILON) * 100) / 100).toFixed(2));
  }

  private estimateCostRmb(
    billedUnits: number | null,
    pricingMode: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_second' | 'per_mchar',
    unitPriceRmbPerMToken: number,
    unitPriceRmbPerCall: number,
    unitPriceRmbPerMinute: number,
  ): number {
    if (pricingMode === 'per_call') {
      const perCall = Number(unitPriceRmbPerCall || 0);
      if (!Number.isFinite(perCall) || perCall <= 0) {
        return 0;
      }
      return Number((Math.max(0, billedUnits || 0) * perCall).toFixed(6));
    }

    if (pricingMode === 'per_minute') {
      const perMinute = Number(unitPriceRmbPerMinute || 0);
      if (!Number.isFinite(perMinute) || perMinute <= 0) {
        return 0;
      }
      return Number((Math.max(0, billedUnits || 0) * perMinute).toFixed(6));
    }

    if (pricingMode === 'per_second') {
      const perSecond = Number(unitPriceRmbPerMinute || 0);
      if (!Number.isFinite(perSecond) || perSecond <= 0) {
        return 0;
      }
      return Number((Math.max(0, billedUnits || 0) * perSecond).toFixed(6));
    }

    if (!billedUnits || billedUnits <= 0) {
      return 0;
    }

    const unitPrice = Number(unitPriceRmbPerMToken || 0);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      return 0;
    }
    return Number(((billedUnits * unitPrice) / 1_000_000).toFixed(6));
  }

  private estimateMTokenCost(tokens: number | null | undefined, unitPricePerMToken: number | null | undefined): number {
    const safeTokens = Math.max(0, Number(tokens || 0));
    const safeUnitPrice = Math.max(0, Number(unitPricePerMToken || 0));
    if (!Number.isFinite(safeTokens) || !Number.isFinite(safeUnitPrice) || safeTokens <= 0 || safeUnitPrice <= 0) {
      return 0;
    }
    return (safeTokens * safeUnitPrice) / 1_000_000;
  }

  private normalizeRmbPerMToken(value: unknown, fallback = 0): number {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Number(parsed.toFixed(6));
  }

  private normalizePointsPerMToken(value: unknown, fallback = 0): number {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Number(parsed.toFixed(6));
  }

  private normalizeLegacyMessages(payload: Record<string, unknown>) {
    const messageList = payload.messages;
    if (Array.isArray(messageList)) {
      const items = messageList
        .map((item) => this.normalizeChatMessage(item))
        .filter((item): item is { role: string; content: string } => !!item);
      if (items.length > 0) {
        return items;
      }
    }

    const message = this.stringOrUndefined(payload.message);
    const history = Array.isArray(payload.history) ? payload.history : [];
    if (!message && history.length === 0) {
      throw new BadRequestException('message or messages is required');
    }

    const normalizedHistory = history
      .map((item) => this.normalizeChatMessage(item))
      .filter((item): item is { role: string; content: string } => !!item);

    if (message) {
      normalizedHistory.push({ role: 'user', content: message });
    }
    return normalizedHistory;
  }

  private normalizeResponsesPayloadToChat(payload: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {
      stream: false,
    };

    if (payload.model !== undefined) {
      output.model = payload.model;
    }
    if (payload.temperature !== undefined) {
      output.temperature = payload.temperature;
    }
    if (payload.top_p !== undefined) {
      output.top_p = payload.top_p;
    }
    if (payload.user !== undefined) {
      output.user = payload.user;
    }
    if (payload.max_output_tokens !== undefined) {
      output.max_tokens = payload.max_output_tokens;
    } else if (payload.max_tokens !== undefined) {
      output.max_tokens = payload.max_tokens;
    }

    const input = payload.input;
    const messages = payload.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      output.messages = messages;
      return output;
    }

    const prompt = this.normalizePromptToText(input);
    if (!prompt) {
      throw new BadRequestException('responses requires input or messages');
    }
    output.messages = [{ role: 'user', content: prompt }];
    return output;
  }

  private transformChatSseToResponsesStream(
    source: ReadableStream<Uint8Array> | null,
    modelHint?: string,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const responseId = `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const messageId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let model = modelHint || 'unknown-model';
    let outputText = '';
    let createdSent = false;
    let completedSent = false;
    let lineBuffer = '';

    const sendCreated = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (createdSent) {
        return;
      }
      createdSent = true;
      const payload = {
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          model,
          status: 'in_progress',
          output: [],
        },
      };
      controller.enqueue(encoder.encode(this.buildSseEvent('response.created', payload)));
    };

    const sendCompleted = (controller: ReadableStreamDefaultController<Uint8Array>, usage?: unknown) => {
      if (completedSent) {
        return;
      }
      completedSent = true;
      const payload = {
        type: 'response.completed',
        response: {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          model,
          status: 'completed',
          output: [
            {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: outputText,
                  annotations: [],
                },
              ],
            },
          ],
          output_text: outputText,
          usage: this.normalizeObject(usage),
        },
      };
      controller.enqueue(encoder.encode(this.buildSseEvent('response.completed', payload)));
    };

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          if (!source) {
            sendCreated(controller);
            sendCompleted(controller);
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          const reader = source.getReader();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) {
                break;
              }
              if (!chunk.value) {
                continue;
              }

              lineBuffer += decoder.decode(chunk.value, { stream: true });
              const lines = lineBuffer.split(/\r?\n/);
              lineBuffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) {
                  continue;
                }
                const raw = trimmed.slice(5).trim();
                if (!raw) {
                  continue;
                }
                if (raw === '[DONE]') {
                  sendCreated(controller);
                  sendCompleted(controller);
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  controller.close();
                  return;
                }

                let parsed: Record<string, unknown> | null = null;
                try {
                  parsed = JSON.parse(raw) as Record<string, unknown>;
                } catch {
                  continue;
                }
                if (!parsed) {
                  continue;
                }

                const chunkModel = this.stringOrUndefined(parsed.model);
                if (chunkModel) {
                  model = chunkModel;
                }
                sendCreated(controller);

                const deltaText = this.extractChatStreamDeltaText(parsed);
                if (deltaText) {
                  outputText += deltaText;
                  controller.enqueue(
                    encoder.encode(
                      this.buildSseEvent('response.output_text.delta', {
                        type: 'response.output_text.delta',
                        response_id: responseId,
                        output_index: 0,
                        content_index: 0,
                        delta: deltaText,
                      }),
                    ),
                  );
                }

                const finishReason = this.extractChatStreamFinishReason(parsed);
                if (finishReason) {
                  controller.enqueue(
                    encoder.encode(
                      this.buildSseEvent('response.output_text.done', {
                        type: 'response.output_text.done',
                        response_id: responseId,
                        output_index: 0,
                        content_index: 0,
                        text: outputText,
                      }),
                    ),
                  );
                  sendCompleted(controller, parsed.usage);
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  controller.close();
                  return;
                }
              }
            }
          } finally {
            reader.releaseLock();
          }

          sendCreated(controller);
          sendCompleted(controller);
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error: any) {
          controller.enqueue(
            encoder.encode(
              this.buildSseEvent('response.failed', {
                type: 'response.failed',
                response_id: responseId,
                error: {
                  message: error?.message || 'stream transform failed',
                },
              }),
            ),
          );
          controller.close();
        }
      },
    });
  }

  private buildSseEvent(event: string, payload: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  private transformOpenAiSseToGeminiStream(
    source: ReadableStream<Uint8Array> | null,
    modelId: string,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let lineBuffer = '';

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        if (!source) {
          controller.close();
          return;
        }

        const reader = source.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            if (!chunk.value) {
              continue;
            }

            lineBuffer += decoder.decode(chunk.value, { stream: true });
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) {
                continue;
              }
              const raw = trimmed.slice(5).trim();
              if (!raw || raw === '[DONE]') {
                continue;
              }

              let parsed: Record<string, unknown> | null = null;
              try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                continue;
              }
              if (!parsed) {
                continue;
              }

              const deltaText = this.extractChatStreamDeltaText(parsed);
              const finishReason = this.extractChatStreamFinishReason(parsed);
              const payload: Record<string, unknown> = {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: deltaText ? [{ text: deltaText }] : [],
                    },
                    finishReason: finishReason ? this.mapOpenAiFinishReasonToGemini(finishReason) : undefined,
                    index: 0,
                  },
                ],
                modelVersion: modelId,
              };
              if (parsed.usage && typeof parsed.usage === 'object') {
                payload.usageMetadata = this.mapOpenAiUsageToGemini(parsed.usage as Record<string, unknown>);
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });
  }

  private extractChatStreamDeltaText(payload: Record<string, unknown>): string {
    const choices = Array.isArray(payload.choices) ? (payload.choices as Array<Record<string, unknown>>) : [];
    if (choices.length === 0) {
      return '';
    }
    const first = this.normalizeObject(choices[0]);
    const delta = this.normalizeObject(first.delta);
    const content = delta.content;
    if (typeof content === 'string') {
      return content;
    }
    return this.normalizePromptToText(content);
  }

  private extractChatStreamFinishReason(payload: Record<string, unknown>): string {
    const choices = Array.isArray(payload.choices) ? (payload.choices as Array<Record<string, unknown>>) : [];
    if (choices.length === 0) {
      return '';
    }
    const first = this.normalizeObject(choices[0]);
    return this.stringOrUndefined(first.finish_reason) || '';
  }

  private mapOpenAiFinishReasonToGemini(value?: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === 'stop') {
      return 'STOP';
    }
    if (normalized === 'length') {
      return 'MAX_TOKENS';
    }
    if (normalized === 'content_filter') {
      return 'SAFETY';
    }
    if (normalized === 'tool_calls') {
      return 'STOP';
    }
    return normalized.toUpperCase();
  }

  private mapOpenAiUsageToGemini(usage: Record<string, unknown>): Record<string, unknown> {
    const cachedTokens = this.pickNumber(
      this.getNestedObject(usage, ['prompt_tokens_details'])?.cached_tokens,
      this.getNestedObject(usage, ['input_tokens_details'])?.cached_tokens,
    );
    return {
      promptTokenCount: this.pickNumber(usage.prompt_tokens) || 0,
      candidatesTokenCount: this.pickNumber(usage.completion_tokens) || 0,
      totalTokenCount: this.pickNumber(usage.total_tokens) || 0,
      ...(cachedTokens ? { cachedContentTokenCount: cachedTokens } : {}),
    };
  }

  private normalizePromptToText(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => this.normalizePromptToText(item))
        .filter((item) => !!item)
        .join('\n')
        .trim();
    }
    if (!value || typeof value !== 'object') {
      return '';
    }
    const record = value as Record<string, unknown>;
    const text = this.stringOrUndefined(record.text);
    if (text) {
      return text;
    }
    const content = record.content;
    if (typeof content === 'string') {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => this.normalizePromptToText(item))
        .filter((item) => !!item)
        .join('\n')
        .trim();
    }
    return '';
  }

  private mapChatCompletionToTextCompletion(
    chatData: Record<string, unknown>,
    originalPayload: Record<string, unknown>,
  ): Record<string, unknown> {
    const choices = Array.isArray(chatData.choices) ? (chatData.choices as Array<Record<string, unknown>>) : [];
    const created = Number(chatData.created) || Math.floor(Date.now() / 1000);
    const model =
      this.stringOrUndefined(chatData.model) || this.stringOrUndefined(originalPayload.model) || 'unknown-model';

    const mappedChoices = choices.map((choice, index) => {
      const message = this.normalizeObject(choice.message);
      const text =
        this.stringOrUndefined(message.content) || this.normalizePromptToText(message.content) || this.stringOrUndefined(choice.text) || '';
      return {
        text,
        index: Number(choice.index ?? index),
        logprobs: null,
        finish_reason: this.stringOrUndefined(choice.finish_reason) || 'stop',
      };
    });

    return {
      id: this.stringOrUndefined(chatData.id) || `cmpl_${Date.now()}`,
      object: 'text_completion',
      created,
      model,
      choices: mappedChoices,
      usage: this.normalizeObject(chatData.usage),
    };
  }

  private mapChatCompletionToResponses(
    chatData: Record<string, unknown>,
    originalPayload: Record<string, unknown>,
  ): Record<string, unknown> {
    const choices = Array.isArray(chatData.choices) ? (chatData.choices as Array<Record<string, unknown>>) : [];
    const created = Number(chatData.created) || Math.floor(Date.now() / 1000);
    const model =
      this.stringOrUndefined(chatData.model) || this.stringOrUndefined(originalPayload.model) || 'unknown-model';

    const assistantText = choices
      .map((choice) => {
        const message = this.normalizeObject(choice.message);
        const content = message.content;
        if (typeof content === 'string') {
          return content.trim();
        }
        return this.normalizePromptToText(content) || this.stringOrUndefined(choice.text) || '';
      })
      .filter((item) => !!item)
      .join('\n')
      .trim();

    return {
      id: this.stringOrUndefined(chatData.id) || `resp_${Date.now()}`,
      object: 'response',
      created_at: created,
      model,
      status: 'completed',
      output: [
        {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: assistantText,
              annotations: [],
            },
          ],
        },
      ],
      output_text: assistantText,
      usage: this.normalizeObject(chatData.usage),
    };
  }

  private normalizeChatMessage(raw: unknown): { role: string; content: string } | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const role = this.stringOrUndefined((raw as Record<string, unknown>).role);
    const content = this.stringOrUndefined((raw as Record<string, unknown>).content);
    if (!role || !content) {
      return null;
    }
    return { role, content };
  }

  private normalizeLegacyExtraFields(payload: Record<string, unknown>) {
    const ignored = new Set([
      'message',
      'history',
      'messages',
      'system_prompt',
      'systemPrompt',
      'context',
      'stream',
      'model',
    ]);
    const output: Record<string, unknown> = {};
    Object.entries(payload).forEach(([key, value]) => {
      if (ignored.has(key)) {
        return;
      }
      output[key] = value;
    });
    return output;
  }

  private resolveMinimaxTtsEndpoint(endpointPath: string, asyncMode: boolean): string {
    const normalized = this.stringOrUndefined(endpointPath);
    if (normalized && normalized !== '/audio/speech') {
      if (normalized === '/v1/t2a_v2' || normalized === '/t2a_v2') {
        return '/t2a_v2';
      }
      if (normalized === '/v1/t2a_async_v2' || normalized === '/t2a_async_v2') {
        return asyncMode ? '/t2a_async_v2' : '/t2a_v2';
      }
      return normalized;
    }
    return asyncMode ? '/t2a_async_v2' : '/t2a_v2';
  }

  private defaultMinimaxAsyncQueryEndpoint(_synthesisEndpointPath: string): string {
    return '/query/t2a_async_query_v2';
  }

  private buildDashscopeCosyVoiceTtsRequest(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const overrides = this.normalizeObject(route.request_overrides);
    const inputOverrides = {
      ...this.normalizeObject(overrides.input),
      ...this.normalizeObject(payload.input),
    };
    this.assertNoUnsupportedDashscopeCosyVoiceTtsFields(payload, inputOverrides, overrides);
    const text =
      this.stringOrUndefined(payload.ssml) ||
      this.stringOrUndefined(inputOverrides.ssml) ||
      this.stringOrUndefined(overrides.ssml) ||
      this.stringOrUndefined(payload.text) ||
      this.stringOrUndefined(payload.input) ||
      this.stringOrUndefined(inputOverrides.text) ||
      this.stringOrUndefined(payload.content) ||
      this.stringOrUndefined(overrides.text);
    if (!text) {
      throw new BadRequestException('DashScope CosyVoice TTS requires text/input');
    }
    const voice =
      this.stringOrUndefined(payload.voice) ||
      this.stringOrUndefined(payload.voice_id) ||
      this.stringOrUndefined(inputOverrides.voice) ||
      this.stringOrUndefined(overrides.voice) ||
      this.stringOrUndefined(overrides.voice_id);
    if (!voice) {
      throw new BadRequestException('DashScope CosyVoice TTS requires voice');
    }
    this.assertDashscopeCosyVoiceVoiceAllowed(route.upstream_model, voice);
    const format =
      this.stringOrUndefined(payload.response_format) ||
      this.stringOrUndefined(payload.format) ||
      this.stringOrUndefined(inputOverrides.format) ||
      this.stringOrUndefined(overrides.format) ||
      'mp3';
    const sampleRate = this.pickNumber(
      payload.sample_rate,
      inputOverrides.sample_rate,
      overrides.sample_rate,
      24000,
    ) || 24000;
    const input: Record<string, unknown> = {
      ...inputOverrides,
      text,
      voice,
      format,
      sample_rate: sampleRate,
    };
    const enableSsml = this.resolveDashscopeCosyVoiceEnableSsml(payload, inputOverrides, overrides, text);
    if (enableSsml) {
      this.assertDashscopeCosyVoiceSsmlText(text);
      input.enable_ssml = true;
    } else {
      delete input.enable_ssml;
    }
    const languageHints = this.normalizeDashscopeLanguageHints(
      payload.language_hints ?? inputOverrides.language_hints ?? payload.language ?? overrides.language_hints ?? overrides.language,
      'DashScope CosyVoice TTS language_hints',
    );
    if (languageHints.length > 0) {
      input.language_hints = languageHints;
    }
    const instruction =
      this.stringOrUndefined(payload.instruction) ||
      this.stringOrUndefined(payload.instructions) ||
      this.stringOrUndefined(payload.prompt) ||
      this.stringOrUndefined(inputOverrides.prompt) ||
      this.stringOrUndefined(inputOverrides.instruction) ||
      this.stringOrUndefined(inputOverrides.instructions) ||
      this.stringOrUndefined(overrides.instruction) ||
      this.stringOrUndefined(overrides.instructions) ||
      this.stringOrUndefined(overrides.prompt);
    if (instruction) {
      input.instruction = instruction;
    }
    ['volume', 'speech_rate', 'pitch_rate'].forEach((key) => {
      const value = this.pickFirstDefined(payload[key], inputOverrides[key], overrides[key]);
      if (value !== undefined) {
        input[key] = value;
      }
    });
    const rootOverrides = { ...overrides };
    delete rootOverrides.input;
    delete rootOverrides.audio;
    delete rootOverrides.voice;
    delete rootOverrides.voice_id;
    delete rootOverrides.format;
    delete rootOverrides.response_format;
    delete rootOverrides.language;
    delete rootOverrides.language_hints;
    delete rootOverrides.instruction;
    delete rootOverrides.instructions;
    delete rootOverrides.prompt;
    delete rootOverrides.emotion;
    delete rootOverrides.sample_rate;
    delete rootOverrides.ssml;
    delete rootOverrides.enable_ssml;
    delete rootOverrides.enableSsml;
    delete rootOverrides.text_type;
    delete rootOverrides.textType;
    delete rootOverrides.target_model;
    delete rootOverrides.linked_tts_model_key;
    delete rootOverrides.linked_tts_model_id;
    return {
      ...rootOverrides,
      model: route.upstream_model,
      input,
    };
  }

  private assertNoUnsupportedDashscopeCosyVoiceTtsFields(
    payload: Record<string, unknown>,
    inputOverrides: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) {
    const voiceSetting = this.normalizeObject(payload.voice_setting);
    const overrideVoiceSetting = this.normalizeObject(overrides.voice_setting);
    const unsupportedEmotion = this.pickFirstDefined(
      payload.emotion,
      inputOverrides.emotion,
      voiceSetting.emotion,
      overrideVoiceSetting.emotion,
      overrides.emotion,
    );
    if (unsupportedEmotion !== undefined) {
      throw new BadRequestException(
        'DashScope CosyVoice V3.5 TTS does not support emotion. Use prompt/instruction to describe speaking style, or choose a MiniMax TTS model if you need the emotion field.',
      );
    }
  }

  private resolveDashscopeCosyVoiceEnableSsml(
    payload: Record<string, unknown>,
    inputOverrides: Record<string, unknown>,
    overrides: Record<string, unknown>,
    text: string,
  ): boolean {
    const explicit = this.pickFirstDefined(
      payload.enable_ssml,
      payload.enableSsml,
      inputOverrides.enable_ssml,
      inputOverrides.enableSsml,
      overrides.enable_ssml,
      overrides.enableSsml,
    );
    if (explicit !== undefined) {
      return explicit === true || explicit === 'true' || explicit === 1 || explicit === '1';
    }
    const textType =
      this.stringOrUndefined(payload.text_type) ||
      this.stringOrUndefined(payload.textType) ||
      this.stringOrUndefined(inputOverrides.text_type) ||
      this.stringOrUndefined(inputOverrides.textType) ||
      this.stringOrUndefined(overrides.text_type) ||
      this.stringOrUndefined(overrides.textType);
    if (textType && textType.toLowerCase() === 'ssml') {
      return true;
    }
    return this.looksLikeDashscopeCosyVoiceSsml(text);
  }

  private looksLikeDashscopeCosyVoiceSsml(text: string): boolean {
    return /<\s*speak(?:\s|>)/i.test(text);
  }

  private assertDashscopeCosyVoiceSsmlText(text: string) {
    if (!this.looksLikeDashscopeCosyVoiceSsml(text) || !/<\s*\/\s*speak\s*>/i.test(text)) {
      throw new BadRequestException('DashScope CosyVoice SSML requires input text wrapped in <speak>...</speak>');
    }
  }

  private normalizeDashscopeLanguageHints(value: unknown, label = 'DashScope CosyVoice language_hints'): string[] {
    const allowed = Object.keys(DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS);
    const allowedText = allowed.map((code) => `${code}=${DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS[code]}`).join(', ');
    if (Array.isArray(value)) {
      const normalized = value.map((item) => this.stringOrUndefined(item)).filter((item): item is string => !!item);
      if (normalized.length > 1) {
        throw new BadRequestException(`${label} only accepts one language code for CosyVoice V3.5; current DashScope API only processes the first element. Allowed values: ${allowedText}`);
      }
      normalized.forEach((item) => this.assertDashscopeCosyVoiceLanguageHint(item, label));
      return normalized;
    }
    const single = this.stringOrUndefined(value);
    if (single) {
      this.assertDashscopeCosyVoiceLanguageHint(single, label);
    }
    return single ? [single] : [];
  }

  private assertDashscopeCosyVoiceLanguageHint(value: string, label: string) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS, normalized)) {
      const allowedText = Object.entries(DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS)
        .map(([code, name]) => `${code}=${name}`)
        .join(', ');
      throw new BadRequestException(`${label} is invalid: ${value}. Allowed CosyVoice V3.5 language codes: ${allowedText}`);
    }
  }

  private assertDashscopeCosyVoiceVoiceAllowed(model: string, voice: string) {
    const normalizedModel = String(model || '').trim().toLowerCase();
    if (!DASHSCOPE_COSYVOICE_V35_MODELS.has(normalizedModel)) {
      return;
    }
    const normalizedVoice = String(voice || '').trim();
    if (normalizedVoice.startsWith(`${normalizedModel}-`)) {
      return;
    }
    throw new BadRequestException(
      `DashScope CosyVoice V3.5 does not support system voices. Use a voice cloned or designed for ${normalizedModel}; the voice value should be the provider voice_id returned by DashScope, such as ${normalizedModel}-<prefix>-<id>, or use the platform voice_id returned by /audio/voices/clone.`,
    );
  }

  private buildMinimaxTtsRequest(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    asyncMode: boolean,
  ): Record<string, unknown> {
    const overrides = this.normalizeObject(route.request_overrides);
    const voiceSetting = {
      ...this.normalizeObject(overrides.voice_setting),
      ...this.normalizeObject(payload.voice_setting),
    };
    const audioSetting = {
      ...this.normalizeObject(overrides.audio_setting),
      ...this.normalizeObject(payload.audio_setting),
    };
    this.assertNoUnsupportedMinimaxTtsFields(payload, voiceSetting, overrides);

    const text =
      this.stringOrUndefined(payload.text) ||
      this.stringOrUndefined(payload.input) ||
      this.stringOrUndefined(payload.content) ||
      this.stringOrUndefined(overrides.text) ||
      this.stringOrUndefined(overrides.input);
    if (!text) {
      throw new BadRequestException('Minimax TTS requires text/input');
    }
    this.validateMinimaxTtsTextControls(text);

    const voiceId =
      this.stringOrUndefined(payload.voice_id) ||
      this.stringOrUndefined(payload.voice) ||
      this.stringOrUndefined(voiceSetting.voice_id) ||
      this.stringOrUndefined(overrides.voice_id);
    if (!voiceId) {
      throw new BadRequestException('Minimax TTS requires voice_id');
    }

    const emotion = this.normalizeMinimaxTtsEmotion(payload.emotion, voiceSetting.emotion, overrides.emotion);
    const addSilence = this.pickFirstDefined(payload.add_silence, voiceSetting.add_silence, overrides.add_silence);
    const requestPayload: Record<string, unknown> = {
      ...this.normalizeObject(overrides),
      ...this.normalizeObject(payload),
      model: this.stringOrUndefined(payload.model) || route.upstream_model,
      text,
      voice_setting: {
        ...voiceSetting,
        voice_id: voiceId,
        speed: this.normalizeMinimaxNumberSetting('speed', 1, 0.5, 2, payload.speed, voiceSetting.speed, overrides.speed),
        vol: this.numberOrDefault(payload.vol, payload.volume, voiceSetting.vol, overrides.vol, 1),
        pitch: this.normalizeMinimaxNumberSetting('pitch', 0, -12, 12, payload.pitch, voiceSetting.pitch, overrides.pitch),
        ...(emotion ? { emotion } : {}),
        ...(addSilence !== undefined ? { add_silence: addSilence } : {}),
      },
      audio_setting: {
        ...audioSetting,
        sample_rate: this.numberOrDefault(payload.sample_rate, audioSetting.sample_rate, overrides.sample_rate, 32000),
        bitrate: this.numberOrDefault(payload.bitrate, audioSetting.bitrate, overrides.bitrate, 128000),
        format:
          this.stringOrUndefined(payload.response_format) ||
          this.stringOrUndefined(payload.format) ||
          this.stringOrUndefined(audioSetting.format) ||
          this.stringOrUndefined(overrides.format) ||
          'mp3',
        channel: this.numberOrDefault(payload.channel, audioSetting.channel, overrides.channel, 1),
      },
    };

    if (asyncMode) {
      const sampleRate = this.numberOrDefault(payload.sample_rate, audioSetting.sample_rate, overrides.sample_rate, 32000);
      requestPayload.audio_setting = {
        ...this.normalizeObject(requestPayload.audio_setting),
        sample_rate: sampleRate,
        audio_sample_rate: sampleRate,
      };
    }

    const languageBoost =
      this.stringOrUndefined(payload.language_boost) ||
      this.stringOrUndefined(payload.language) ||
      this.stringOrUndefined(overrides.language_boost);
    if (languageBoost) {
      requestPayload.language_boost = languageBoost;
    }

    if (!asyncMode) {
      requestPayload.output_format =
        this.stringOrUndefined(payload.output_format) || this.stringOrUndefined(overrides.output_format) || 'hex';
    }

    delete requestPayload.input;
    delete requestPayload.prompt;
    delete requestPayload.instruction;
    delete requestPayload.instructions;
    delete requestPayload.ssml;
    delete requestPayload.enable_ssml;
    delete requestPayload.enableSsml;
    delete requestPayload.text_type;
    delete requestPayload.textType;
    delete requestPayload.content;
    delete requestPayload.voice;
    delete requestPayload.voice_id;
    delete requestPayload.speed;
    delete requestPayload.vol;
    delete requestPayload.volume;
    delete requestPayload.pitch;
    delete requestPayload.emotion;
    delete requestPayload.add_silence;
    delete requestPayload.sample_rate;
    delete requestPayload.bitrate;
    delete requestPayload.format;
    delete requestPayload.channel;
    delete requestPayload.response_format;
    delete requestPayload.return_audio_binary;
    delete requestPayload.stream;
    delete requestPayload.endpoint_path;
    delete requestPayload.prefer_sync_tts;
    delete requestPayload.prefer_async_tts;
    delete requestPayload.async_tts;

    return requestPayload;
  }

  private assertNoUnsupportedMinimaxTtsFields(
    payload: Record<string, unknown>,
    voiceSetting: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) {
    const inputOverrides = {
      ...this.normalizeObject(overrides.input),
      ...this.normalizeObject(payload.input),
    };
    const unsupportedPrompt = this.pickFirstDefined(
      payload.prompt,
      payload.instruction,
      payload.instructions,
      inputOverrides.prompt,
      inputOverrides.instruction,
      inputOverrides.instructions,
      voiceSetting.prompt,
      voiceSetting.instruction,
      voiceSetting.instructions,
      overrides.prompt,
      overrides.instruction,
      overrides.instructions,
    );
    if (unsupportedPrompt !== undefined) {
      throw new BadRequestException(
        'MiniMax TTS does not support prompt/instruction. Put the spoken text in input or text, and use emotion for supported MiniMax emotion control.',
      );
    }
    const unsupportedSsml = this.pickFirstDefined(
      payload.ssml,
      payload.enable_ssml,
      payload.enableSsml,
      payload.text_type,
      payload.textType,
      inputOverrides.ssml,
      inputOverrides.enable_ssml,
      inputOverrides.enableSsml,
      inputOverrides.text_type,
      inputOverrides.textType,
      overrides.ssml,
      overrides.enable_ssml,
      overrides.enableSsml,
      overrides.text_type,
      overrides.textType,
    );
    if (unsupportedSsml !== undefined) {
      throw new BadRequestException(
        'MiniMax TTS does not support SSML. Use MiniMax text controls such as <#0.6#> pause markers, or choose a CosyVoice V3.5 model if you need SSML.',
      );
    }
    const text =
      this.stringOrUndefined(payload.text) ||
      this.stringOrUndefined(payload.input) ||
      this.stringOrUndefined(payload.content) ||
      this.stringOrUndefined(overrides.text) ||
      this.stringOrUndefined(overrides.input);
    if (text && this.looksLikeDashscopeCosyVoiceSsml(text)) {
      throw new BadRequestException(
        'MiniMax TTS does not support SSML input. Use plain input text with MiniMax controls such as <#0.6#> pause markers, or choose a CosyVoice V3.5 model.',
      );
    }
  }

  private validateMinimaxTtsTextControls(text: string) {
    const pausePattern = /<#([^#>]*)#>/g;
    let match: RegExpExecArray | null;
    let previousEnd = -1;
    while ((match = pausePattern.exec(text)) !== null) {
      const rawSeconds = String(match[1] || '').trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(rawSeconds)) {
        throw new BadRequestException('Minimax TTS pause marker must use <#seconds#>, with at most 2 decimal places');
      }
      const seconds = Number(rawSeconds);
      if (!Number.isFinite(seconds) || seconds < 0.01 || seconds > 99.99) {
        throw new BadRequestException('Minimax TTS pause marker seconds must be between 0.01 and 99.99');
      }
      const before = text.slice(0, match.index).trim();
      const after = text.slice(match.index + match[0].length).trim();
      if (!before || !after) {
        throw new BadRequestException('Minimax TTS pause marker must be placed between two text segments');
      }
      if (previousEnd >= 0 && !text.slice(previousEnd, match.index).trim()) {
        throw new BadRequestException('Minimax TTS pause markers cannot be consecutive');
      }
      previousEnd = match.index + match[0].length;
    }
  }

  private normalizeMinimaxNumberSetting(
    field: string,
    fallback: number,
    min: number,
    max: number,
    ...values: unknown[]
  ): number {
    const picked = this.pickFirstDefined(...values);
    if (picked === undefined) {
      return fallback;
    }
    const parsed = Number(picked);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`Minimax TTS ${field} must be a number`);
    }
    if (parsed < min || parsed > max) {
      throw new BadRequestException(`Minimax TTS ${field} must be between ${min} and ${max}`);
    }
    return parsed;
  }

  private normalizeMinimaxTtsEmotion(...values: unknown[]): string | undefined {
    const picked = this.pickFirstDefined(...values);
    const raw = this.stringOrUndefined(picked);
    if (!raw) {
      return undefined;
    }
    const normalized = raw.trim().toLowerCase() === 'whisper' ? 'whipser' : raw.trim().toLowerCase();
    if (!MINIMAX_TTS_EMOTIONS.has(normalized)) {
      throw new BadRequestException(
        `Minimax TTS emotion must be one of: ${Array.from(MINIMAX_TTS_EMOTIONS).join(', ')}; whisper is accepted as alias for whipser`,
      );
    }
    return normalized;
  }

  private pickFirstDefined(...values: unknown[]): unknown {
    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }
      if (typeof value === 'string' && !value.trim()) {
        continue;
      }
      return value;
    }
    return undefined;
  }

  private extractTtsTextLength(payload: Record<string, unknown>): number {
    return this.resolveTtsCharacterCountFromPayload(payload);
  }

  private extractMinimaxAudioBytes(data: Record<string, unknown>): Buffer | null {
    const candidates = [
      this.getNestedString(data, ['data', 'audio']),
      this.getNestedString(data, ['audio']),
      this.getNestedString(data, ['output', 'audio']),
      this.getNestedString(data, ['audio_hex']),
      this.getNestedString(data, ['data', 'audio_base64']),
      this.getNestedString(data, ['audio_base64']),
      this.getNestedString(data, ['output', 'audio_base64']),
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      if (/^[0-9a-fA-F]+$/.test(candidate) && candidate.length % 2 === 0) {
        return Buffer.from(candidate, 'hex');
      }
      const dataUrlMatch = candidate.match(/^data:audio\/[a-z0-9.+-]+;base64,(.+)$/i);
      const base64Text = dataUrlMatch ? dataUrlMatch[1] : candidate;
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text)) {
        try {
          const buffer = Buffer.from(base64Text, 'base64');
          if (buffer.length > 0) {
            return buffer;
          }
        } catch {
          // ignore invalid base64
        }
      }
    }
    return null;
  }

  private extractMinimaxVoiceId(payload: Record<string, unknown>): string | null {
    const voiceSetting = this.normalizeObject(payload.voice_setting);
    return this.stringOrUndefined(voiceSetting.voice_id) || this.stringOrUndefined(payload.voice_id) || null;
  }

  private async resolveMinimaxBinaryAudio(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
    requestPayload: Record<string, unknown>,
    initialData: Record<string, unknown>,
    asyncMode: boolean,
  ): Promise<{ audioBytes: Buffer; audioFormat: string } | null> {
    const audioFormat = this.extractMinimaxAudioFormat(payload, requestPayload);
    const inlineAudio = this.extractMinimaxAudioBytes(initialData);
    if (inlineAudio) {
      return {
        audioBytes: inlineAudio,
        audioFormat,
      };
    }
    const inlineAudioUrl = this.extractMinimaxAudioUrl(initialData);
    if (inlineAudioUrl) {
      const downloaded = await this.downloadAudioFromUrl(inlineAudioUrl, route.source.api_key, route.source.custom_headers, route.source.outbound_proxy_id);
      if (downloaded) {
        return {
          audioBytes: downloaded.buffer,
          audioFormat: this.audioFormatByMimeType(downloaded.mimeType, audioFormat),
        };
      }
    }

    if (!asyncMode) {
      return null;
    }

    const taskInfo = this.extractMinimaxAsyncTaskInfo(initialData);
    if (!taskInfo.taskId) {
      throw new BadGatewayException('MiniMax async tts accepted but no task_id returned');
    }
    const pollAttempts = this.boundNumber(payload.poll_max_attempts ?? payload.max_poll_attempts, 25, 1, 60);
    const pollIntervalMs = this.boundNumber(payload.poll_interval_ms, 800, 200, 5000);
    const queryEndpointPath = this.stringOrUndefined(payload.query_endpoint_path ?? payload.query_endpoint);

    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      const taskData = await this.fetchMinimaxAsyncTaskData(
        route,
        taskInfo.taskId,
        taskInfo.taskToken,
        queryEndpointPath,
      );

      const taskAudio = this.extractMinimaxAudioBytes(taskData);
      if (taskAudio) {
        return {
          audioBytes: taskAudio,
          audioFormat,
        };
      }

      const taskAudioUrl = this.extractMinimaxAudioUrl(taskData);
      if (taskAudioUrl) {
        const downloaded = await this.downloadAudioFromUrl(taskAudioUrl, route.source.api_key, route.source.custom_headers, route.source.outbound_proxy_id);
        if (downloaded) {
          return {
            audioBytes: downloaded.buffer,
            audioFormat: this.audioFormatByMimeType(downloaded.mimeType, audioFormat),
          };
        }
      }

      const terminalError = this.extractMinimaxAsyncTaskError(taskData);
      if (terminalError) {
        throw new BadGatewayException(`MiniMax async tts failed: ${terminalError}`);
      }
      if (this.isMinimaxAsyncTaskCompleted(taskData)) {
        const fileId = this.extractMinimaxFileId(taskData);
        if (fileId) {
          const fileAudio = await this.downloadMinimaxFileAudio(route, fileId, audioFormat);
          if (fileAudio) {
            return fileAudio;
          }
        }
        throw new BadGatewayException('MiniMax async tts completed but no playable audio returned');
      }

      if (attempt < pollAttempts) {
        await this.sleep(pollIntervalMs);
      }
    }

    throw new BadGatewayException(`MiniMax async tts polling timeout after ${pollAttempts} attempts`);
  }

  private extractMinimaxAsyncTaskInfo(data: Record<string, unknown>): { taskId: string | null; taskToken: string | null } {
    const taskId =
      this.getNestedString(data, ['task_id']) ||
      this.getNestedString(data, ['taskId']) ||
      this.getNestedString(data, ['data', 'task_id']) ||
      this.getNestedString(data, ['data', 'taskId']) ||
      this.getNestedString(data, ['data', 'task', 'task_id']) ||
      this.getNestedString(data, ['data', 'task', 'id']) ||
      null;
    const taskToken =
      this.getNestedString(data, ['task_token']) ||
      this.getNestedString(data, ['taskToken']) ||
      this.getNestedString(data, ['data', 'task_token']) ||
      this.getNestedString(data, ['data', 'taskToken']) ||
      null;
    return { taskId, taskToken };
  }

  private extractMinimaxAudioUrl(data: Record<string, unknown>): string | null {
    const directCandidates = [
      this.getNestedString(data, ['audio_url']),
      this.getNestedString(data, ['file_url']),
      this.getNestedString(data, ['audio_file']),
      this.getNestedString(data, ['output', 'audio_url']),
      this.getNestedString(data, ['output', 'file_url']),
      this.getNestedString(data, ['data', 'audio_url']),
      this.getNestedString(data, ['data', 'file_url']),
      this.getNestedString(data, ['data', 'audio_file']),
      this.getNestedString(data, ['data', 'output', 'audio_url']),
      this.getNestedString(data, ['data', 'output', 'file_url']),
      this.getNestedString(data, ['data', 'audio_file', 'url']),
      this.getNestedString(data, ['data', 'audio', 'url']),
    ].filter((item): item is string => !!item);
    for (const candidate of directCandidates) {
      if (/^https?:\/\//i.test(candidate)) {
        return candidate;
      }
    }

    const dataNode = this.normalizeObject(data.data);
    const files = Array.isArray(dataNode.files) ? dataNode.files : [];
    for (const item of files) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const url =
        this.stringOrUndefined((item as Record<string, unknown>).url) ||
        this.stringOrUndefined((item as Record<string, unknown>).file_url) ||
        this.stringOrUndefined((item as Record<string, unknown>).audio_url);
      if (url && /^https?:\/\//i.test(url)) {
        return url;
      }
    }
    return null;
  }

  private extractMinimaxFileId(data: Record<string, unknown>): string | null {
    const stringCandidates = [
      this.getNestedString(data, ['file_id']),
      this.getNestedString(data, ['fileId']),
      this.getNestedString(data, ['data', 'file_id']),
      this.getNestedString(data, ['data', 'fileId']),
      this.getNestedString(data, ['file', 'file_id']),
      this.getNestedString(data, ['file', 'id']),
      this.getNestedString(data, ['data', 'file', 'file_id']),
      this.getNestedString(data, ['data', 'file', 'id']),
    ].filter((item): item is string => !!item);
    if (stringCandidates.length > 0) {
      return stringCandidates[0];
    }

    const numberCandidates = [
      this.getNestedNumber(data, ['file_id']),
      this.getNestedNumber(data, ['fileId']),
      this.getNestedNumber(data, ['data', 'file_id']),
      this.getNestedNumber(data, ['data', 'fileId']),
      this.getNestedNumber(data, ['file', 'file_id']),
      this.getNestedNumber(data, ['file', 'id']),
      this.getNestedNumber(data, ['data', 'file', 'file_id']),
      this.getNestedNumber(data, ['data', 'file', 'id']),
    ].filter((item): item is number => item !== null);
    return numberCandidates.length > 0 ? String(numberCandidates[0]) : null;
  }

  private async downloadMinimaxFileAudio(
    route: ResolvedAiRoute,
    fileId: string,
    preferredFormat: string,
  ): Promise<{ audioBytes: Buffer; audioFormat: string } | null> {
    const retrieved = await this.retrieveMinimaxFile(route, fileId);
    const downloadUrl = this.extractMinimaxAudioUrl(retrieved);
    if (downloadUrl) {
      const downloaded = await this.downloadAudioFromUrl(downloadUrl, route.source.api_key, route.source.custom_headers, route.source.outbound_proxy_id);
      if (downloaded) {
        return {
          audioBytes: downloaded.buffer,
          audioFormat: this.audioFormatByMimeType(downloaded.mimeType, preferredFormat),
        };
      }
    }

    return this.downloadMinimaxFileContent(route, fileId, preferredFormat);
  }

  private async retrieveMinimaxFile(route: ResolvedAiRoute, fileId: string): Promise<Record<string, unknown>> {
    const endpointUrl = this.joinUrl(
      route.source.base_url,
      this.normalizeMinimaxEndpointPathForBase(route.source.base_url, '/files/retrieve'),
    );
    const endpoint = new URL(endpointUrl);
    endpoint.searchParams.set('file_id', fileId);

    const upstreamResp = await this.fetchUpstream(route, endpoint.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
    });

    if (!upstreamResp.ok) {
      const errorBody = await upstreamResp.text();
      this.logger.warn(
        `MiniMax file retrieve failed model=${route.model_key} source=${route.source.name} file_id=${fileId} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 600)}`,
      );
      return {};
    }

    const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      return (await upstreamResp.json()) as Record<string, unknown>;
    }

    const raw = await upstreamResp.text();
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async downloadMinimaxFileContent(
    route: ResolvedAiRoute,
    fileId: string,
    preferredFormat: string,
  ): Promise<{ audioBytes: Buffer; audioFormat: string } | null> {
    const endpointUrl = this.joinUrl(
      route.source.base_url,
      this.normalizeMinimaxEndpointPathForBase(route.source.base_url, '/files/retrieve_content'),
    );
    const endpoint = new URL(endpointUrl);
    endpoint.searchParams.set('file_id', fileId);

    const upstreamResp = await this.fetchUpstream(route, endpoint.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
    });

    if (!upstreamResp.ok) {
      const errorBody = await upstreamResp.text();
      this.logger.warn(
        `MiniMax file content download failed model=${route.model_key} source=${route.source.name} file_id=${fileId} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 600)}`,
      );
      return null;
    }

    const buffer = Buffer.from(await upstreamResp.arrayBuffer());
    if (!buffer.length) {
      return null;
    }
    return {
      audioBytes: buffer,
      audioFormat: this.audioFormatByMimeType(upstreamResp.headers.get('content-type') || '', preferredFormat),
    };
  }

  private extractMinimaxAsyncTaskError(data: Record<string, unknown>): string | null {
    const statusCode =
      this.getNestedNumber(data, ['base_resp', 'status_code']) ??
      this.getNestedNumber(data, ['base_resp', 'code']) ??
      this.getNestedNumber(data, ['code']);
    const statusMsg =
      this.getNestedString(data, ['base_resp', 'status_msg']) ||
      this.getNestedString(data, ['base_resp', 'message']) ||
      this.getNestedString(data, ['error']) ||
      this.getNestedString(data, ['message']) ||
      '';
    if (statusCode !== null && statusCode !== 0) {
      return statusMsg || `status_code=${statusCode}`;
    }

    const statusText = this.extractMinimaxAsyncStatusText(data);
    if (statusText && /(fail|error|cancel|timeout)/.test(statusText)) {
      return statusMsg || statusText;
    }
    return null;
  }

  private isMinimaxAsyncTaskCompleted(data: Record<string, unknown>): boolean {
    const statusText = this.extractMinimaxAsyncStatusText(data);
    if (!statusText) {
      return false;
    }
    return /(success|succeed|done|finish|complete)/.test(statusText);
  }

  private extractMinimaxAsyncStatusText(data: Record<string, unknown>): string {
    const candidates = [
      this.getNestedString(data, ['status']),
      this.getNestedString(data, ['data', 'status']),
      this.getNestedString(data, ['data', 'task_status']),
      this.getNestedString(data, ['data', 'state']),
      this.getNestedString(data, ['base_resp', 'status_msg']),
      this.getNestedString(data, ['message']),
    ].filter((item): item is string => !!item);
    return candidates.map((item) => item.toLowerCase()).find((item) => !!item) || '';
  }

  private async fetchMinimaxAsyncTaskData(
    route: ResolvedAiRoute,
    taskId: string,
    taskToken?: string | null,
    endpointPathOverride?: string,
  ): Promise<Record<string, unknown>> {
    const endpointPath = endpointPathOverride || this.defaultMinimaxAsyncQueryEndpoint(route.endpoint_path);
    const normalizedEndpointPath = this.normalizeMinimaxEndpointPathForBase(route.source.base_url, endpointPath);
    const endpointUrl = this.joinUrl(route.source.base_url, normalizedEndpointPath);
    const endpoint = new URL(endpointUrl);
    if (!endpoint.searchParams.has('task_id')) {
      endpoint.searchParams.set('task_id', taskId);
    }
    if (taskToken && !endpoint.searchParams.has('task_token')) {
      endpoint.searchParams.set('task_token', taskToken);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${route.source.api_key}`,
      ...route.source.custom_headers,
    };

    const upstreamResp = await this.fetchUpstream(route, endpoint.toString(), {
      method: 'GET',
      headers,
    });

    if (!upstreamResp.ok) {
      const errorBody = await upstreamResp.text();
      this.logger.warn(
        `MiniMax async query failed model=${route.model_key} source=${route.source.name} status=${upstreamResp.status} body=${this.truncate(String(errorBody || ''), 600)}`,
      );
      throw new BadGatewayException(
        `MiniMax async query error (${upstreamResp.status}): ${errorBody || upstreamResp.statusText || 'request failed'}`,
      );
    }

    const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      return (await upstreamResp.json()) as Record<string, unknown>;
    }
    const raw = await upstreamResp.text();
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new BadGatewayException('MiniMax async query returned non-json response');
    }
  }

  private async loadMinimaxVoiceCatalogFromApi(appSlug: string): Promise<MinimaxVoiceCatalog | null> {
    const normalizedAppSlug = this.stringOrUndefined(appSlug);
    if (!normalizedAppSlug) {
      return null;
    }
    const routes = await this.aiRoutingService.resolveModelRouteCandidatesByCapability(normalizedAppSlug, 'tts');
    const route = routes.find((item) => this.isMinimaxSource(item.source.provider_type));
    if (!route || !route.source.api_key) {
      return null;
    }

    const cacheKey = `${route.source.id}:${this.hashSecret(route.source.api_key)}`;
    const cached = this.minimaxVoiceApiCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const endpoint = this.resolveMinimaxGetVoiceEndpoint(route.source.base_url);
    const response = await this.runWithMinimaxTtsKeyQueue(route, () => this.outboundHttp.fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: JSON.stringify({ voice_type: 'all' }),
    }, {
      proxyId: route.source.outbound_proxy_id,
    }));
    const rawText = await response.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new BadGatewayException(`MiniMax get_voice failed (${response.status}): ${this.truncate(rawText, 600)}`);
    }
    const statusCode = this.getNestedNumber(data, ['base_resp', 'status_code']);
    if (statusCode !== null && statusCode !== 0) {
      throw new BadGatewayException(`MiniMax get_voice failed: ${this.truncate(rawText, 600)}`);
    }

    const voices = this.normalizeMinimaxVoiceApiResponse(data);
    if (!voices.length) {
      return null;
    }
    const catalog: MinimaxVoiceCatalog = {
      generated_at: new Date().toISOString(),
      source_file: 'minimax:get_voice',
      total: voices.length,
      voices,
      by_language: voices.reduce<Record<string, MinimaxVoiceItem[]>>((acc, item) => {
        const key = item.language_boost || 'Custom';
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(item);
        return acc;
      }, {}),
    };
    if (this.minimaxVoiceApiCacheMs > 0) {
      this.minimaxVoiceApiCache.set(cacheKey, {
        value: catalog,
        expiresAt: now + this.minimaxVoiceApiCacheMs,
      });
    }
    return catalog;
  }

  private resolveMinimaxGetVoiceEndpoint(baseUrl: string): string {
    const raw = this.stringOrUndefined(baseUrl) || 'https://api.minimax.io/v1';
    const parsed = new URL(raw);
    const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
    parsed.pathname = normalizedPath.endsWith('/v1') ? `${normalizedPath}/get_voice` : '/v1/get_voice';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  }

  private normalizeMinimaxVoiceApiResponse(data: Record<string, unknown>): MinimaxVoiceItem[] {
    const buckets: Array<{ key: string; sourceType: MinimaxVoiceItem['source_type'] }> = [
      { key: 'system_voice', sourceType: 'system' },
      { key: 'voice_cloning', sourceType: 'voice_cloning' },
      { key: 'voice_generation', sourceType: 'voice_generation' },
    ];
    const seen = new Set<string>();
    const items: MinimaxVoiceItem[] = [];
    for (const bucket of buckets) {
      const entries = this.normalizeMinimaxVoiceEntries(data[bucket.key]);
      for (const entry of entries) {
        const entryObject = typeof entry === 'object' && entry ? entry : {};
        const voiceId = this.stringOrUndefined(
          (entryObject as Record<string, unknown>).voice_id
          || (entryObject as Record<string, unknown>).voiceId
          || (entryObject as Record<string, unknown>).id
          || entry,
        );
        if (!voiceId || seen.has(voiceId)) {
          continue;
        }
        seen.add(voiceId);
        const inferred = this.inferMinimaxVoiceLanguage(voiceId, entry);
        items.push({
          index: items.length + 1,
          language_zh: inferred.language_zh,
          language_en: inferred.language_en,
          language_boost: inferred.language_boost,
          voice_id: voiceId,
          voice_name: this.stringOrUndefined(
            (entryObject as Record<string, unknown>).voice_name
            || (entryObject as Record<string, unknown>).voiceName
            || (entryObject as Record<string, unknown>).name
            || (entryObject as Record<string, unknown>).display_name
            || (entryObject as Record<string, unknown>).description,
          ) || voiceId,
          gender_hint: this.inferMinimaxVoiceGender(voiceId, entry),
          source_type: bucket.sourceType,
        });
      }
    }
    return items;
  }

  private normalizeMinimaxVoiceEntries(value: unknown): Array<Record<string, unknown> | string> {
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.normalizeMinimaxVoiceEntries(item));
    }
    if (typeof value === 'string') {
      return [value];
    }
    if (!value || typeof value !== 'object') {
      return [];
    }
    const obj = value as Record<string, unknown>;
    for (const key of ['voices', 'items', 'voice_list', 'voiceList']) {
      if (Array.isArray(obj[key])) {
        return this.normalizeMinimaxVoiceEntries(obj[key]);
      }
    }
    return [obj];
  }

  private inferMinimaxVoiceLanguage(voiceId: string, entry: Record<string, unknown> | string) {
    const obj = typeof entry === 'object' && entry ? entry : {};
    const explicitBoost = this.stringOrUndefined(
      (obj as Record<string, unknown>).language_boost
      || (obj as Record<string, unknown>).languageBoost
      || (obj as Record<string, unknown>).language,
    );
    const normalizedExplicit = explicitBoost
      ? MINIMAX_LANGUAGE_BOOST_BY_VOICE_PREFIX[this.normalizeMinimaxVoiceLanguageToken(explicitBoost)] || explicitBoost
      : '';
    const prefix = this.normalizeMinimaxVoiceLanguageToken(voiceId.split('_')[0] || '');
    const languageBoost = normalizedExplicit
      || MINIMAX_LANGUAGE_BOOST_BY_VOICE_PREFIX[prefix]
      || '';
    const labels = languageBoost
      ? MINIMAX_LANGUAGE_LABELS_BY_BOOST[languageBoost] || { language_en: languageBoost, language_zh: languageBoost }
      : { language_en: 'Custom', language_zh: '账号音色' };
    return {
      language_boost: languageBoost,
      language_en: labels.language_en,
      language_zh: labels.language_zh,
    };
  }

  private normalizeMinimaxVoiceLanguageToken(value: string): string {
    return String(value || '').trim().toLowerCase().replace(/[()]/g, '').replace(/[^a-z]+/g, ' ').trim();
  }

  private inferMinimaxVoiceGender(voiceId: string, entry: Record<string, unknown> | string): string | undefined {
    const obj = typeof entry === 'object' && entry ? entry as Record<string, unknown> : {};
    const explicit = this.stringOrUndefined(obj.gender || obj.gender_hint || obj.sex);
    if (explicit) {
      return explicit.toLowerCase();
    }
    const normalized = voiceId.toLowerCase();
    if (normalized.includes('female') || normalized.includes('girl') || normalized.includes('woman')) {
      return 'female';
    }
    if (normalized.includes('male') || normalized.includes('boy') || normalized.includes('man')) {
      return 'male';
    }
    return undefined;
  }

  private async downloadAudioFromUrl(
    url: string,
    apiKey: string,
    customHeaders: Record<string, string>,
    proxyId?: string | null,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const tryFetch = async (headers?: Record<string, string>) => {
      try {
        const resp = await this.outboundHttp.fetch(url, { method: 'GET', headers }, { proxyId });
        if (!resp.ok) {
          return null;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (!buffer.length) {
          return null;
        }
        return {
          buffer,
          mimeType: resp.headers.get('content-type') || 'application/octet-stream',
        };
      } catch {
        return null;
      }
    };

    const withoutAuth = await tryFetch();
    if (withoutAuth) {
      return withoutAuth;
    }
    return tryFetch({
      Authorization: `Bearer ${apiKey}`,
      ...customHeaders,
    });
  }

  private extractMinimaxAudioFormat(
    originalPayload: Record<string, unknown>,
    requestPayload: Record<string, unknown>,
  ): string {
    const fromPayload = this.stringOrUndefined(originalPayload.response_format) || this.stringOrUndefined(originalPayload.format);
    const fromAudioSetting = this.getNestedString(originalPayload, ['audio_setting', 'format']);
    const fromRequest = this.getNestedString(requestPayload, ['audio_setting', 'format']);
    return (fromPayload || fromAudioSetting || fromRequest || 'mp3').toLowerCase();
  }

  private extractDashscopeCosyVoiceAudioFormat(
    originalPayload: Record<string, unknown>,
    requestPayload: Record<string, unknown>,
  ): string {
    const fromPayload = this.stringOrUndefined(originalPayload.response_format) || this.stringOrUndefined(originalPayload.format);
    const fromInput = this.getNestedString(originalPayload, ['input', 'format']);
    const fromRequest = this.getNestedString(requestPayload, ['input', 'format']);
    return (fromPayload || fromInput || fromRequest || 'mp3').toLowerCase();
  }

  private extractDashscopeCosyVoiceAudioUrl(data: Record<string, unknown>): string | null {
    return this.getNestedString(data, ['output', 'audio', 'url'])
      || this.getNestedString(data, ['output', 'url'])
      || this.getNestedString(data, ['data', 'audio', 'url'])
      || this.getNestedString(data, ['data', 'url'])
      || this.getNestedString(data, ['audio', 'url'])
      || this.getNestedString(data, ['url'])
      || null;
  }

  private contentTypeByAudioFormat(format: string): string {
    switch (format) {
      case 'mp3':
        return 'audio/mpeg';
      case 'wav':
        return 'audio/wav';
      case 'flac':
        return 'audio/flac';
      case 'ogg':
      case 'opus':
        return 'audio/ogg';
      case 'aac':
        return 'audio/aac';
      case 'pcm':
        return 'audio/pcm';
      default:
        return 'application/octet-stream';
    }
  }

  private audioFormatByMimeType(mimeType: string, preferredFormat = 'mp3'): string {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('wav')) {
      return 'wav';
    }
    if (normalized.includes('aac')) {
      return 'aac';
    }
    if (normalized.includes('ogg')) {
      return 'ogg';
    }
    if (normalized.includes('flac')) {
      return 'flac';
    }
    if (normalized.includes('mp4') || normalized.includes('m4a')) {
      return 'mp4';
    }
    return (preferredFormat || 'mp3').toLowerCase();
  }

  private loadMinimaxVoiceCatalog(): MinimaxVoiceCatalog | null {
    if (this.minimaxVoiceCatalogCache !== undefined) {
      return this.minimaxVoiceCatalogCache;
    }

    const configuredPath = this.stringOrUndefined(process.env.MINIMAX_VOICE_CATALOG_PATH);
    const candidatePaths = [
      configuredPath,
      resolve(process.cwd(), 'Doc/minimax/音色列表.json'),
      resolve(process.cwd(), 'prisma/minimax/音色列表.json'),
      resolve(process.cwd(), '../Doc/minimax/音色列表.json'),
      resolve(process.cwd(), '../../Doc/minimax/音色列表.json'),
      resolve(process.cwd(), '/app/Doc/minimax/音色列表.json'),
    ].filter((item): item is string => !!item);

    for (const filePath of candidatePaths) {
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as MinimaxVoiceCatalog & { items?: MinimaxVoiceItem[] };
        const fromVoices = Array.isArray(parsed?.voices) ? parsed.voices : [];
        const fromItems = Array.isArray(parsed?.items) ? parsed.items : [];
        const voices = fromVoices.length > 0 ? fromVoices : fromItems;
        if (!voices.length) {
          continue;
        }
        this.minimaxVoiceCatalogCache = {
          generated_at: parsed.generated_at,
          source_file: parsed.source_file,
          total: parsed.total,
          voices,
          by_language: parsed.by_language,
        };
        this.minimaxVoiceCatalogPath = filePath;
        return this.minimaxVoiceCatalogCache;
      } catch (error: any) {
        this.logger.warn(`Failed to parse Minimax voice catalog at ${filePath}: ${error?.message || error}`);
      }
    }

    this.minimaxVoiceCatalogCache = null;
    this.minimaxVoiceCatalogPath = null;
    return null;
  }

  private getNestedString(source: Record<string, unknown>, keys: string[]): string | undefined {
    let cursor: unknown = source;
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object') {
        return undefined;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === 'number' || typeof cursor === 'bigint') {
      return String(cursor);
    }
    return this.stringOrUndefined(cursor);
  }

  private getNestedNumber(source: Record<string, unknown>, keys: string[]): number | null {
    let cursor: unknown = source;
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object') {
        return null;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    const value = Number(cursor);
    return Number.isFinite(value) ? value : null;
  }

  private getNestedObject(source: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
    let cursor: unknown = source;
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object') {
        return null;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      return cursor as Record<string, unknown>;
    }
    return null;
  }

  private pickNumber(...values: unknown[]): number | null {
    for (const value of values) {
      if (value === null || value === undefined || value === '') {
        continue;
      }
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }
    return null;
  }

  private pickFirstString(...values: unknown[]): string | null {
    for (const value of values) {
      const text = this.stringOrUndefined(value);
      if (text) {
        return text;
      }
    }
    return null;
  }

  private booleanOrNull(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) {
      return null;
    }
    if (['true', '1', 'yes', 'y', 'on'].includes(text)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(text)) {
      return false;
    }
    return null;
  }

  private numberOrNull(...values: unknown[]): number | null {
    for (const value of values) {
      if (value === null || value === undefined || value === '') {
        continue;
      }
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Number(parsed.toFixed(6));
      }
    }
    return null;
  }

  private normalizePositiveIntegerOrNull(value: unknown): number | null {
    const picked = this.pickNumber(value);
    if (!picked || picked <= 0) {
      return null;
    }
    return picked;
  }

  private normalizePositiveIntegerOrZero(value: unknown): number {
    return this.normalizePositiveIntegerOrNull(value) ?? 0;
  }

  private normalizeObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private buildAliyunIceVideoTranslationPayload(
    route: ResolvedAiRoute,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (this.stringOrUndefined(payload.InputConfig) || this.stringOrUndefined(payload.inputConfig)) {
      return {
        ...route.request_overrides,
        ...payload,
        InputConfig: this.stringOrUndefined(payload.InputConfig) || this.stringOrUndefined(payload.inputConfig),
        OutputConfig: this.stringOrUndefined(payload.OutputConfig) || this.stringOrUndefined(payload.outputConfig),
        EditingConfig: this.stringOrUndefined(payload.EditingConfig) || this.stringOrUndefined(payload.editingConfig),
        Title: this.stringOrUndefined(payload.Title ?? payload.title),
        Description: this.stringOrUndefined(payload.Description ?? payload.description),
        UserData: this.stringifyJsonField(payload.UserData ?? payload.userData),
        ClientToken: this.stringOrUndefined(payload.ClientToken ?? payload.clientToken),
        duration_seconds: this.resolveDurationSecondsFromPayload(payload) ?? undefined,
        resolution: this.resolveVideoResolutionFromPayload(payload) ?? undefined,
      };
    }

    const input = this.normalizeObject(payload.input);
    const output = this.normalizeObject(payload.output);
    const editing = this.normalizeObject(payload.editing);
    const inputType = this.normalizeAliyunIceInputType(payload.input_type ?? input.type ?? payload.type);
    const inputValue =
      this.stringOrUndefined(input.url)
      || this.stringOrUndefined(input.media_url)
      || this.stringOrUndefined(input.mediaUrl)
      || this.stringOrUndefined(input.media_id)
      || this.stringOrUndefined(input.mediaId)
      || this.stringOrUndefined(input.video)
      || this.stringOrUndefined(input.audio)
      || this.stringOrUndefined(input.subtitle)
      || this.stringOrUndefined(payload.video_url)
      || this.stringOrUndefined(payload.audio_url)
      || this.stringOrUndefined(payload.subtitle_url)
      || this.stringOrUndefined(payload.input_url);
    if (!inputValue) {
      throw new BadRequestException('视频翻译需要 input.url 或 input.media_id');
    }
    const inputConfig: Record<string, unknown> = {
      ...this.normalizeObject(payload.input_config),
      ...this.normalizeObject(payload.inputConfig),
      Type: inputType,
      Media: inputValue,
    };

    const outputConfig = {
      ...this.normalizeObject(payload.output_config),
      ...this.normalizeObject(payload.outputConfig),
      ...output,
    };
    const outputMediaUrl =
      this.stringOrUndefined(outputConfig.MediaURL)
      || this.stringOrUndefined(outputConfig.media_url)
      || this.stringOrUndefined(outputConfig.mediaUrl)
      || this.stringOrUndefined(payload.output_url);
    const normalizedOutputConfig: Record<string, unknown> = {
      ...outputConfig,
      ...(outputMediaUrl ? { MediaURL: outputMediaUrl } : {}),
    };
    delete normalizedOutputConfig.media_url;
    delete normalizedOutputConfig.mediaUrl;
    if (!this.stringOrUndefined(normalizedOutputConfig.MediaURL) && !this.stringOrUndefined(normalizedOutputConfig.FileName)) {
      throw new BadRequestException('视频翻译需要 output.media_url，或 VOD 输出参数');
    }

    const mode = String(payload.mode ?? payload.translation_mode ?? payload.translationMode ?? 'speech')
      .trim()
      .toLowerCase();
    const sourceLanguage = this.stringOrUndefined(payload.source_language ?? payload.sourceLanguage ?? editing.SourceLanguage);
    const targetLanguage = this.stringOrUndefined(payload.target_language ?? payload.targetLanguage ?? editing.TargetLanguage);
    if (!sourceLanguage || !targetLanguage) {
      throw new BadRequestException('视频翻译需要 source_language 和 target_language');
    }
    const editingConfig: Record<string, unknown> = {
      ...this.normalizeObject(payload.editing_config),
      ...this.normalizeObject(payload.editingConfig),
      ...editing,
      SourceLanguage: sourceLanguage,
      TargetLanguage: targetLanguage,
    };
    this.assignIfDefined(editingConfig, 'DetextArea', payload.detext_area ?? payload.detextArea ?? editing.DetextArea);
    this.assignIfDefined(editingConfig, 'SupportEditing', payload.support_editing ?? payload.supportEditing ?? editing.SupportEditing);
    this.assignIfDefined(editingConfig, 'BilingualSubtitle', payload.bilingual_subtitle ?? payload.bilingualSubtitle ?? editing.BilingualSubtitle);
    this.assignIfDefined(editingConfig, 'TextSource', payload.text_source ?? payload.textSource ?? editing.TextSource);
    this.assignIfDefined(editingConfig, 'CustomParameter', payload.custom_parameter ?? payload.customParameter ?? editing.CustomParameter);
    this.assignIfDefined(editingConfig, 'HotwordLibraryIdList', payload.hotword_library_id_list ?? payload.hotwordLibraryIdList ?? editing.HotwordLibraryIdList);
    this.assignIfDefined(editingConfig, 'FECanvas', payload.fe_canvas ?? payload.feCanvas ?? editing.FECanvas);
    if (mode === 'subtitle') {
      editingConfig.NeedSpeechTranslate = false;
      editingConfig.NeedFaceTranslate = false;
      this.assignIfDefined(editingConfig, 'SubtitleTranslate', payload.subtitle_translate ?? payload.subtitleTranslate ?? editing.SubtitleTranslate);
    } else if (mode === 'face') {
      editingConfig.NeedSpeechTranslate = false;
      editingConfig.NeedFaceTranslate = true;
      this.assignIfDefined(editingConfig, 'FaceTranslate', payload.face_translate ?? payload.faceTranslate ?? editing.FaceTranslate);
    } else {
      editingConfig.NeedSpeechTranslate = true;
      editingConfig.NeedFaceTranslate = false;
      this.assignIfDefined(editingConfig, 'SpeechTranslate', payload.speech_translate ?? payload.speechTranslate ?? editing.SpeechTranslate);
    }

    const durationSeconds = this.resolveDurationSecondsFromPayload(payload);
    const resolution = this.resolveVideoResolutionFromPayload(payload);
    return {
      ...route.request_overrides,
      ...payload,
      model: route.upstream_model,
      InputConfig: JSON.stringify(inputConfig),
      OutputConfig: JSON.stringify(this.compactObject(normalizedOutputConfig)),
      EditingConfig: JSON.stringify(this.compactObject(editingConfig)),
      Title: this.stringOrUndefined(payload.title ?? payload.Title),
      Description: this.stringOrUndefined(payload.description ?? payload.Description),
      UserData: this.stringifyJsonField(payload.user_data ?? payload.userData ?? payload.UserData),
      ClientToken: this.stringOrUndefined(payload.client_token ?? payload.clientToken ?? payload.ClientToken),
      duration_seconds: durationSeconds ?? undefined,
      resolution: resolution ?? undefined,
      parameters: {
        ...this.normalizeObject(payload.parameters),
        ...(durationSeconds !== null ? { duration_seconds: durationSeconds } : {}),
        ...(resolution ? { resolution } : {}),
      },
    };
  }

  private normalizeAliyunIceInputType(value: unknown): 'Video' | 'Audio' | 'Subtitle' {
    const normalized = String(value || 'Video').trim().toLowerCase();
    if (normalized === 'audio') {
      return 'Audio';
    }
    if (normalized === 'subtitle' || normalized === 'srt') {
      return 'Subtitle';
    }
    return 'Video';
  }

  private assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== undefined && value !== null && value !== '') {
      target[key] = value;
    }
  }

  private compactObject(value: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    Object.entries(value).forEach(([key, item]) => {
      if (item === undefined || item === null || item === '') {
        return;
      }
      output[key] = item;
    });
    return output;
  }

  private stringifyJsonField(value: unknown): string | undefined {
    const direct = this.stringOrUndefined(value);
    if (direct) {
      return direct;
    }
    if (value && typeof value === 'object') {
      return JSON.stringify(value);
    }
    return undefined;
  }

  private extractAliyunIceVideoTranslationJobId(data: Record<string, unknown>): string | null {
    const raw = this.normalizeObject(data.raw);
    const rawData = this.normalizeObject(raw.Data ?? raw.data);
    return this.stringOrUndefined(data.job_id)
      || this.stringOrUndefined(data.task_id)
      || this.stringOrUndefined(data.provider_task_id)
      || this.stringOrUndefined(raw.JobId)
      || this.stringOrUndefined(raw.jobId)
      || this.stringOrUndefined(rawData.JobId)
      || this.stringOrUndefined(rawData.jobId)
      || null;
  }

  private extractAliyunIceVideoTranslationStatus(data: Record<string, unknown>): string | null {
    const state =
      this.stringOrUndefined(data.task_status)
      || this.stringOrUndefined(data.state)
      || this.stringOrUndefined(this.normalizeObject(data.raw).State)
      || this.stringOrUndefined(this.normalizeObject(data.raw).state);
    if (!state) {
      return null;
    }
    const normalized = state.trim().toUpperCase();
    if (normalized === 'FINISHED' || normalized === 'SUCCEEDED' || normalized === 'SUCCESS') {
      return 'SUCCEEDED';
    }
    if (normalized === 'FAILED' || normalized === 'FAIL') {
      return 'FAILED';
    }
    if (normalized === 'CREATED') {
      return 'PENDING';
    }
    if (normalized === 'EXECUTING' || normalized === 'RUNNING') {
      return 'RUNNING';
    }
    return normalized;
  }

  private isAliyunIceVideoTranslationTerminalSuccess(status: string): boolean {
    return String(status || '').trim().toUpperCase() === 'SUCCEEDED';
  }

  private isAliyunIceVideoTranslationTerminalFailure(status: string): boolean {
    return String(status || '').trim().toUpperCase() === 'FAILED';
  }

  private extractAliyunIceVideoTranslationErrorMessage(data: Record<string, unknown>): string | null {
    const raw = this.normalizeObject(data.raw);
    return this.stringOrUndefined(data.error_message)
      || this.stringOrUndefined(raw.ErrorMessage)
      || this.stringOrUndefined(raw.errorMessage)
      || this.stringOrUndefined(data.error_code)
      || this.stringOrUndefined(raw.ErrorCode)
      || null;
  }

  private buildAliyunIceVideoTranslationSubmitResponse(
    data: Record<string, unknown>,
    options: { publicTaskId: string; providerTaskId: string },
  ): Record<string, unknown> {
    return {
      created: Math.floor(Date.now() / 1000),
      task_id: options.publicTaskId,
      provider_task_id: options.providerTaskId,
      upstream_task_id: options.providerTaskId,
      task_status: 'PENDING',
      request_id: this.stringOrUndefined(data.request_id) || undefined,
    };
  }

  private buildAliyunIceVideoTranslationTaskResponse(
    data: Record<string, unknown>,
    options: { includeUrls: boolean; fallbackTaskId?: string | null; providerTaskId?: string | null },
  ): Record<string, unknown> {
    const providerTaskId = this.extractAliyunIceVideoTranslationJobId(data) || options.providerTaskId || null;
    const taskStatus = this.extractAliyunIceVideoTranslationStatus(data) || null;
    const response: Record<string, unknown> = {
      created: Math.floor(Date.now() / 1000),
      task_id: options.fallbackTaskId || providerTaskId,
      provider_task_id: providerTaskId || undefined,
      upstream_task_id: providerTaskId || undefined,
      task_status: taskStatus,
      request_id: this.stringOrUndefined(data.request_id) || undefined,
    };
    const message = this.extractAliyunIceVideoTranslationErrorMessage(data);
    if (message) {
      response.message = message;
    }
    if (options.includeUrls && taskStatus && this.isAliyunIceVideoTranslationTerminalSuccess(taskStatus)) {
      const urls = this.extractAliyunIceVideoTranslationOutputUrls(data);
      response.data = urls.map((url) => ({
        url,
        mime_type: url.toLowerCase().endsWith('.srt') ? 'text/plain' : 'video/mp4',
      }));
      if (urls[0]) {
        response.video_url = urls[0];
      }
      const usage: Record<string, unknown> = {};
      const durationSeconds = this.extractDurationSecondsFromData(data);
      const resolution = this.extractVideoResolutionFromData(data);
      if (durationSeconds !== null) {
        usage.duration = durationSeconds;
      }
      if (resolution) {
        usage.resolution = resolution;
      }
      if (Object.keys(usage).length > 0) {
        response.usage = usage;
      }
    }
    return response;
  }

  private extractAliyunIceVideoTranslationOutputUrls(data: Record<string, unknown>): string[] {
    const raw = this.normalizeObject(data.raw);
    const candidates = [
      data.output,
      data.job_result,
      raw.Output,
      raw.output,
      raw.JobResult,
      raw.jobResult,
      this.normalizeObject(raw.JobResult ?? raw.jobResult).AiResult,
      this.normalizeObject(raw.JobResult ?? raw.jobResult).aiResult,
    ];
    const urls = new Set<string>();
    candidates.forEach((candidate) => {
      this.collectUrlStrings(candidate, urls);
    });
    return Array.from(urls);
  }

  private collectUrlStrings(value: unknown, urls: Set<string>): void {
    if (!value) {
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      if (/^https?:\/\//i.test(trimmed)) {
        urls.add(trimmed);
        return;
      }
      try {
        this.collectUrlStrings(JSON.parse(trimmed), urls);
      } catch {
        const matches = trimmed.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
        matches.forEach((url) => urls.add(url));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => this.collectUrlStrings(item, urls));
      return;
    }
    if (typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach((item) => this.collectUrlStrings(item, urls));
    }
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

  private logAiTrace(message: string): void {
    if (this.isAiTraceLogEnabled()) {
      this.logger.log(message);
    }
  }

  private warnAiTrace(message: string): void {
    if (this.isAiTraceLogEnabled()) {
      this.logger.warn(message);
    }
  }

  private isAiTraceLogEnabled(): boolean {
    this.ensureAiGatewayTuningFresh();
    if (this.aiGatewayTuning.trace_log !== undefined) {
      return this.aiGatewayTuning.trace_log === true || String(this.aiGatewayTuning.trace_log).trim() === '1';
    }
    return String(process.env.AI_GATEWAY_TRACE_LOG || '').trim() === '1';
  }

  private truncate(value: string, maxLength: number): string {
    const text = String(value || '');
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}...`;
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

  private extractMultipartInstruction(payload: Record<string, unknown>): MultipartInstruction | null {
    const raw = payload.__multipart;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    return raw as MultipartInstruction;
  }

  private normalizeMultipartHeaders(headers: Record<string, string>): Record<string, string> {
    const output: Record<string, string> = {};
    Object.entries(headers || {}).forEach(([key, value]) => {
      if (!value) {
        return;
      }
      if (key.toLowerCase() === 'content-type') {
        return;
      }
      output[key] = value;
    });
    return output;
  }

  private numberOrDefault(...values: unknown[]): number {
    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }
      if (typeof value === 'string' && !value.trim()) {
        continue;
      }
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return 0;
  }

  private boundNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    const base = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
    return Math.min(Math.max(base, min), max);
  }

  private readBoundedInt(envName: string, fallback: number, min: number, max: number): number {
    return this.boundNumber(process.env[envName], fallback, min, max);
  }

  private ensureAiGatewayTuningFresh(): void {
    if (this.aiGatewayTuningLoadedAt > 0 && Date.now() - this.aiGatewayTuningLoadedAt < 15000) {
      return;
    }
    if (!this.aiGatewayTuningLoading) {
      this.aiGatewayTuningLoading = this.refreshAiGatewayTuning().finally(() => {
        this.aiGatewayTuningLoading = null;
      });
    }
  }

  private async refreshAiGatewayTuning(): Promise<void> {
    try {
      this.aiGatewayTuning = await this.runtimeSettingsService.getAiGatewayTuning();
      this.aiGatewayTuningLoadedAt = Date.now();
    } catch (error: any) {
      this.logger.warn(`AI gateway tuning refresh failed: ${error?.message || error}`);
      this.aiGatewayTuning = {};
      this.aiGatewayTuningLoadedAt = Date.now();
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private minimaxTtsKeyQueueKey(route: ResolvedAiRoute): string {
    const apiKeyHash = route.source.api_key ? this.hashSecret(route.source.api_key) : 'nokey';
    return `${route.source.id}:${apiKeyHash}`;
  }

  private hashSecret(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private async runWithMinimaxTtsKeyQueue<T>(route: ResolvedAiRoute, task: () => Promise<T>): Promise<T> {
    if (this.minimaxTtsKeyMinIntervalMs <= 0) {
      return task();
    }

    const queueKey = this.minimaxTtsKeyQueueKey(route);
    const previous = this.minimaxTtsKeyQueueTails.get(queueKey)?.catch(() => undefined) || Promise.resolve();
    let releaseQueue!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const current = previous.then(() => gate);
    this.minimaxTtsKeyQueueTails.set(queueKey, current);

    await previous;
    try {
      const lastStartedAt = this.minimaxTtsKeyLastStartedAt.get(queueKey) || 0;
      const waitMs = Math.max(0, lastStartedAt + this.minimaxTtsKeyMinIntervalMs - Date.now());
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      this.minimaxTtsKeyLastStartedAt.set(queueKey, Date.now());
      return await task();
    } finally {
      releaseQueue?.();
      if (this.minimaxTtsKeyQueueTails.get(queueKey) === current) {
        this.minimaxTtsKeyQueueTails.delete(queueKey);
      }
    }
  }

  private stringOrUndefined(value: unknown) {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private normalizeApiType(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  private isMinimaxTtsApiType(value: string): boolean {
    const normalized = this.normalizeApiType(value);
    return normalized === MINIMAX_TTS_SYNC_API_TYPE
      || normalized === MINIMAX_TTS_ASYNC_API_TYPE
      || normalized === MINIMAX_TTS_API_TYPE;
  }

  private isVoiceCloneApiType(value: unknown): boolean {
    const normalized = this.normalizeApiType(String(value || ''));
    return normalized.includes('voice-clone') || normalized.includes('voice_clone');
  }

  private isDashscopeCosyVoiceTtsRoute(route: ResolvedAiRoute): boolean {
    if (route.capability !== 'tts') {
      return false;
    }
    if (this.isVoiceCloneApiType(route.api_type)) {
      return false;
    }
    const apiType = this.normalizeApiType(String(route.api_type || ''));
    const endpointPath = this.normalizeEndpointPath(route.endpoint_path || '').toLowerCase();
    const providerType = this.normalizeApiType(route.source.provider_type);
    return apiType === DASHSCOPE_COSYVOICE_TTS_API_TYPE
      || apiType.includes('cosyvoice')
      || (providerType.includes('dashscope') && endpointPath.includes('/services/audio/tts/speechsynthesizer'));
  }

  private isMinimaxSource(value: string): boolean {
    const normalized = this.normalizeApiType(value).replace(/[^a-z0-9]/g, '');
    return normalized.includes('minimax');
  }

  private normalizeEndpointPath(endpointPath: string): string {
    const normalized = this.stringOrUndefined(endpointPath) || '/chat/completions';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  private buildDashscopeVideoTaskResponse(
    data: Record<string, unknown>,
    options: { includeVideoUrls: boolean; fallbackTaskId?: string | null; providerTaskId?: string | null },
  ): Record<string, unknown> {
    const providerTaskId = this.extractDashscopeTaskId(data) || options.providerTaskId || null;
    const taskId = options.fallbackTaskId || providerTaskId || null;
    const taskStatus = this.extractDashscopeTaskStatus(data) || null;
    const requestId = this.stringOrUndefined(data.request_id) || null;
    const response: Record<string, unknown> = {
      created: Math.floor(Date.now() / 1000),
      task_id: taskId,
      task_status: taskStatus,
      request_id: requestId,
    };
    if (taskStatus) {
      response.status = taskStatus;
    }
    if (providerTaskId && providerTaskId !== taskId) {
      response.upstream_task_id = providerTaskId;
    }

    const output = this.normalizeObject(data.output);
    const submitTime = this.stringOrUndefined(output.submit_time);
    const scheduledTime = this.stringOrUndefined(output.scheduled_time);
    const endTime = this.stringOrUndefined(output.end_time);
    if (submitTime) {
      response.submit_time = submitTime;
    }
    if (scheduledTime) {
      response.scheduled_time = scheduledTime;
    }
    if (endTime) {
      response.end_time = endTime;
    }

    const responseOutput: Record<string, unknown> = {
      ...(providerTaskId ? { task_id: providerTaskId } : {}),
      ...(taskStatus ? { task_status: taskStatus, status: taskStatus } : {}),
      ...(submitTime ? { submit_time: submitTime } : {}),
      ...(scheduledTime ? { scheduled_time: scheduledTime } : {}),
      ...(endTime ? { end_time: endTime } : {}),
    };

    if (options.includeVideoUrls && taskStatus && this.isDashscopeTaskTerminalSuccess(taskStatus)) {
      const videoUrls = this.extractDashscopeVideoUrls(data);
      if (videoUrls[0]) {
        response.video_url = videoUrls[0];
        responseOutput.video_url = videoUrls[0];
        response.data = videoUrls.map((url) => ({
          url,
          video_url: url,
          mime_type: 'video/mp4',
        }));
      } else {
        response.data = [];
      }
      const usage = this.extractUsageMetrics(data);
      if (usage.duration_seconds !== null || usage.video_resolution || this.stringOrUndefined(requestId)) {
        response.usage = {
          ...(usage.duration_seconds !== null ? { duration: usage.duration_seconds } : {}),
          ...(usage.video_resolution ? { resolution: usage.video_resolution } : {}),
          ...(usage.request_id ? { request_id: usage.request_id } : {}),
        };
      }
    }

    const message = this.resolveDashscopeTaskErrorMessage(data);
    if (message) {
      response.message = message;
      responseOutput.message = message;
    }

    if (Object.keys(responseOutput).length > 0) {
      response.output = responseOutput;
    }

    return response;
  }

  private joinUrl(baseUrl: string, endpointPath: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${endpointPath.replace(/^\/+/, '')}`;
  }

  private normalizeMinimaxEndpointPathForBase(baseUrl: string, endpointPath: string): string {
    const normalizedBase = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
    const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
    if (normalizedBase.endsWith('/v1') && normalizedPath.toLowerCase().startsWith('/v1/')) {
      return normalizedPath.slice(3);
    }
    return normalizedPath;
  }

  private normalizeCapability(value: string): AiCapability {
    const normalized = String(value || '').trim().toLowerCase();
    if ((AI_CAPABILITIES as readonly string[]).includes(normalized)) {
      return normalized as AiCapability;
    }
    throw new BadRequestException(`Unsupported capability: ${value}`);
  }
}
