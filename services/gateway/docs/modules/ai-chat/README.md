# Ai Chat 模块文档

> 模块名称：`ai-chat`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `ai-chat` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/ai-chat/ai-chat.controller.ts`
- `src/modules/ai-chat/ai-chat.module.ts`
- `src/modules/ai-chat/ai-chat.service.ts`
- `src/modules/ai-chat/ai-gateway-error-classifier.service.ts`
- `src/modules/ai-chat/ai-gateway-scheduler.service.ts`
- `src/modules/ai-chat/ai-gateway-throttle.service.ts`
- `src/modules/ai-chat/ai-gateway-usage-queue.service.ts`
- `src/modules/ai-chat/ai-gemini.controller.ts`
- `src/modules/ai-chat/ai-openai.controller.ts`
- `src/modules/ai-chat/ai-points.service.ts`
- `src/modules/ai-chat/ai-protocol-adapter.service.ts`
- `src/modules/ai-chat/ai-routing.service.ts`
- `src/modules/ai-chat/ai-upstream-client.service.ts`
- `src/modules/ai-chat/ai-video-result-proxy.service.ts`
- `src/modules/ai-chat/ai-voices-admin.controller.ts`
- `src/modules/ai-chat/ai-voices.controller.ts`
- `src/modules/ai-chat/ai-voices.service.ts`
- `src/modules/ai-chat/dto/ai-chat.dto.ts`
- `src/modules/ai-chat/guards/ai-debug-auth.service.ts`
- `src/modules/ai-chat/guards/ai-debug-jwt-auth.guard.ts`
- `src/modules/ai-chat/guards/openai-compat-auth.guard.ts`
- `src/modules/ai-chat/runninghub.rules.ts`
- `src/modules/ai-chat/runninghub.utils.ts`

## 3. Controller 与路由
### AiChatController
- 控制器文件：`src/modules/ai-chat/ai-chat.controller.ts`
- 基础路由：`[...tenantControllerPaths('ai', true), ...tenantControllerPaths('ai-chat', true)]`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| POST | `chat` | `chat()` |
| POST | `chat/completions` | `chatCompletions()` |
| GET | `models` | `listModels()` |
| GET | `default-models` | `listDefaultModels()` |
| GET | `models/pricing` | `listModelPricing()` |
| POST | `capabilities/:capability/invoke` | `invokeByCapability()` |
| POST | `embeddings` | `embeddings()` |
| POST | `audio/speech` | `textToSpeech()` |
| POST | `google/tts/speech` | `googleTtsSpeech()` |
| POST | `audio/speech/tasks/query` | `queryTtsTask()` |
| GET | `audio/voices/minimax` | `getMinimaxVoices()` |
| GET | `audio/voices/gemini` | `getGeminiVoices()` |
| POST | `audio/transcriptions` | `transcription()` |
| POST | `images/generations` | `imageGeneration()` |
| POST | `images/edits` | `FileFieldsInterceptor()` |
| POST | `images/edit` | `FileFieldsInterceptor()` |
| POST | `images/variations` | `FileFieldsInterceptor()` |
| POST | `videos/generations` | `videoGeneration()` |
| POST | `videos/generations/async` | `videoGenerationAsync()` |
| POST | `videos/generations/tasks/query` | `queryVideoTask()` |
| POST | `video-translation/jobs` | `submitVideoTranslationJob()` |
| POST | `video-translation/jobs/query` | `queryVideoTranslationJob()` |
| GET | `video-translation/jobs/:task_id` | `getVideoTranslationJob()` |
| POST | `video-retalk/jobs` | `submitVideoRetalkJob()` |
| POST | `video-retalk/jobs/query` | `queryVideoRetalkJob()` |
| GET | `video-retalk/jobs/:task_id` | `getVideoRetalkJob()` |
| GET | `history` | `getHistory()` |

### AiGeminiController
- 控制器文件：`src/modules/ai-chat/ai-gemini.controller.ts`
- 基础路由：`tenantRootControllerPaths('v1beta', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `models` | `models()` |
| GET | `models/pricing` | `modelPricing()` |
| GET | `models/:model` | `modelDetail()` |
| POST | `models/:model\\:generateContent` | `generateContent()` |
| POST | `models/:model\\:streamGenerateContent` | `streamGenerateContent()` |
| POST | `models/:model\\:embedContent` | `embedContent()` |

### AiOpenAiController
- 控制器文件：`src/modules/ai-chat/ai-openai.controller.ts`
- 基础路由：`['/:app/v1', '/api/v1', '/v1']`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| POST | `chat/completions` | `chatCompletions()` |
| POST | `completions` | `completions()` |
| POST | `responses` | `responses()` |
| GET | `models` | `models()` |
| GET | `models/pricing` | `modelPricing()` |
| GET | `default-models` | `defaultModels()` |
| GET | `models/:model` | `modelDetail()` |
| POST | `embeddings` | `embeddings()` |
| POST | `audio/speech` | `speech()` |
| POST | `google/tts/speech` | `googleTtsSpeech()` |
| POST | `vertex/tts/speech` | `vertexTtsSpeech()` |
| POST | `audio/transcriptions` | `transcriptions()` |
| POST | `audio/translations` | `translations()` |
| POST | `images/generations` | `images()` |
| POST | `videos/generations` | `videos()` |
| POST | `videos/generations/async` | `videosAsync()` |
| POST | `videos/generations/tasks/query` | `videoTaskQuery()` |
| POST | `images/edits` | `FileFieldsInterceptor()` |
| POST | `images/edit` | `FileFieldsInterceptor()` |
| POST | `images/variations` | `FileFieldsInterceptor()` |

### AiVoicesAdminController
- 控制器文件：`src/modules/ai-chat/ai-voices-admin.controller.ts`
- 基础路由：`'/api/v1/platform-admin/ai/voices'`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `(root)` | `listVoices()` |
| POST | `migration-jobs` | `createMigrationJob()` |
| GET | `migration-jobs/:job_id` | `getMigrationJob()` |
| POST | `:voice_id/migrate` | `migrateVoice()` |
| POST | `:voice_id/retry-clone` | `retryClone()` |
| POST | `:voice_id/activate-mapping` | `activateMapping()` |

### AiVoicesController
- 控制器文件：`src/modules/ai-chat/ai-voices.controller.ts`
- 基础路由：`[...tenantControllerPaths('audio/voices', true), '/v1/audio/voices']`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| POST | `clone` | `FileInterceptor()` |
| GET | `(root)` | `listVoices()` |
| GET | `:voice_id` | `getVoice()` |
| DELETE | `:voice_id` | `deleteVoice()` |

## 4. Service 能力
### AiChatService
- 服务文件：`src/modules/ai-chat/ai-chat.service.ts`
- 核心方法：
- `onModuleInit()`
- `buildModelPricingCacheKey()`
- `readModelPricingCache()`
- `writeModelPricingCache()`
- `chatLegacy()`
- `forwardChatCompletions()`
- `forwardCompletions()`
- `forwardResponses()`
- `listOpenAiModels()`
- `getGatewayRuntimeStats()`
- `getOpenAiModel()`
- `listGeminiModels()`
- `getGeminiModel()`
- `resolvePreferredMediaRouteKey()`
- `normalizeTtsVoiceAliases()`
- `shouldTryNextResolvedRoute()`
- `pumpDashscopeVideoQueue()`
- `failDashscopeAsyncVideoTask()`
- `buildDashscopeAsyncVideoQueueResponse()`
- `estimateDashscopeVideoQueuePosition()`
- `listMinimaxVoices()`
- `listGeminiVoices()`
- `isGeminiTtsVoiceName()`
- `isGeminiTtsModelKey()`
- `resolveGeminiVoiceLanguageLabels()`
- `shouldUseAiSdkForward()`
- `shouldUseAnthropic()`
- `shouldUseGoogleGenAi()`
- `shouldUseOpenRouter()`
- `isOpenRouterGeminiTtsRoute()`
- `summarizeOpenRouterPayloadForLog()`
- `safeUrlHost()`
- `resolveOpenRouterAudioFormat()`
- `resolveOpenRouterPollingUrl()`
- `defaultOpenRouterEndpoint()`
- `resolveAiSdkBaseUrl()`
- `normalizeAnthropicBaseUrl()`
- `shouldUseAnthropicBearerAuth()`
- `createAnthropicClient()`
- `createGoogleGenAiClient()`
- `resolveGoogleGenAiHttpOptions()`
- `resolveGoogleGenAiBase()`
- `buildAnthropicMessageRequest()`
- `normalizeAnthropicMessageContent()`
- `isSupportedAnthropicImageMimeType()`
- `extractAnthropicTextContent()`
- `extractAnthropicUsage()`
- `mapAnthropicStopReasonToOpenAi()`
- `buildGoogleGenerateContentRequest()`
- `buildGoogleChatConfig()`
- `resolveGoogleImageConfig()`
- `mapOpenAiSizeToGoogleImageConfig()`
- `normalizeGooglePartsFromMessageContent()`
- `collectGoogleImageInputParts()`
- `normalizeGoogleImageInput()`
- `resolveOpenAiImagePartUrl()`
- `convertImageValueToGooglePart()`
- `resolveGoogleTtsContentText()`
- `resolveGoogleTtsOutputFormat()`
- `resolveGoogleTtsResponseFormat()`
- `pickGoogleTtsAudioFormat()`
- `resolveGoogleTtsLanguageCode()`
- `resolveGoogleTtsPrimaryVoice()`
- `buildGoogleTtsSpeechConfig()`
- `resolveGoogleTtsSpeakers()`
- `resolveGoogleTtsSampleRate()`
- `resolveGoogleTtsChannels()`
- `isWavMimeType()`
- `resolvePcmDurationSeconds()`
- `wrapPcm16AsWav()`
- `resolveGoogleGenAiErrorMessage()`
- `normalizeHeaderObject()`
- `parseOpenAiCompatibleImageResponse()`
- `normalizeOpenAiCompatibleImageItems()`
- `normalizeOpenAiCompatibleImageItem()`
- `extractUpstreamRequestId()`
- `resolveOpenAiImageGenerationTimeoutMs()`
- `resolveDirectUpstreamTimeoutMs()`
- `hasOpenAiImageInputs()`
- `collectOpenAiImagePartsFromMessages()`
- `hasOpenAiImageCandidateValue()`
- `normalizeOpenAiImagePath()`
- `isOpenAiReasoningChatRoute()`
- `shouldBypassAiSdkChatForward()`
- `isStreamingRequest()`
- `shouldProxyResponsesDirectly()`
- `messageRequiresRawChatProxy()`
- `resolveResponsesEndpointPath()`
- `normalizeAiSdkLanguageUsage()`
- `toOpenAiUsageObject()`
- `mapAiSdkFinishReasonToOpenAi()`
- `resolveAiSdkTranscriptionAudio()`
- `resolveAiSdkErrorMessage()`
- `resolveErrorCauseMessage()`
- `shouldUseOfficialOpenAiSdkProxy()`
- `isOpenAiCompatibleSource()`
- `isOpenRouterApiType()`
- `isOpenRouterSource()`
- `isAnthropicSource()`
- `isGeminiSource()`
- `isVertexAiSource()`
- `createOfficialOpenAiClient()`
- `buildRouteFetch()`
- `withStreamUsageOptions()`
- `loadAliyunIceSdk()`
- `createAliyunIceClient()`
- `normalizeAliyunIceEndpoint()`
- `extractAliyunRegionFromEndpoint()`
- `normalizeAliyunIceSdkResponse()`
- `isTextLikeUpstreamContentType()`
- `resolveOfficialOpenAiSdkErrorMessage()`
- `buildMultipartForm()`
- `resolveUpstreamEndpointCandidates()`
- `buildAttemptedEndpointsSuffix()`
- `shouldUseDashscopeNative()`
- `shouldUseAliyunIceVideoTranslation()`
- `shouldUseDashscopeCompatibleStt()`
- `shouldUseRunningHub()`
- `normalizeRunningHubSyncImageErrorMessage()`
- `resolveRunningHubMaxUploadBytes()`
- `runningHubAssetKindLabel()`
- `inferVideoMimeTypeFromBase64()`
- `inferAudioMimeTypeFromBase64()`
- `formatByteSize()`
- `collectRunningHubImageInputs()`
- `collectRunningHubVideoFrameInputs()`
- `collectRunningHubVideoReferenceImageInputs()`
- `collectRunningHubVideoReferenceVideoInputs()`
- `collectRunningHubVideoReferenceAudioInputs()`
- `hasRunningHubVideoReferenceAudioInput()`
- `normalizeRunningHubImageInputValue()`
- `normalizeRunningHubQuality()`
- `normalizeRunningHubResolution()`
- `normalizeRunningHubVideoResolution()`
- `normalizeRunningHubVideoDuration()`
- `normalizeRunningHubVideoRatio()`
- `normalizeRunningHubConversionSlots()`
- `normalizeRunningHubAspectRatio()`
- `mapOpenAiSizeToRunningHubImageConfig()`
- `isRetryableRunningHubPollingError()`
- `extractRunningHubVideoDurationSeconds()`
- `isDashscopeNativeEndpointPath()`
- `isDashscopeNativeApiType()`
- `isDashscopeWanBase64DirectRoute()`
- `isDashscopeQwenImageRoute()`
- `isDashscopeQwenSingleEditRoute()`
- `resolveDashscopeNativeSttEndpoint()`
- `resolveDashscopeNativeVideoEndpoint()`
- `normalizeDashscopeNativeEndpointPath()`
- `isDashscopeVideoRetalkRoute()`
- `normalizeDashscopeNativeBaseUrl()`
- `buildDashscopeEndpointUrl()`
- `normalizeDashscopeVideoResolution()`
- `normalizeDashscopeVideoDuration()`
- `resolveDashscopeWan27VideoMode()`
- `extractDashscopeVideoMediaValue()`
- `collectDashscopeWan27I2vMediaEntries()`
- `collectDashscopeWan27R2vMediaEntries()`
- `assertDashscopeWan27I2vMedia()`
- `assertDashscopeWan27R2vMedia()`
- `inferDashscopeWan27VideoRatio()`
- `normalizeDashscopeWanImageSize()`
- `buildDashscopeNativeSttPayload()`
- `isDashscopeFileTranscriptionModel()`
- `buildDashscopeAsrOptions()`
- `extractDashscopeCompatibleAudioInput()`
- `extractDashscopeAudioUrl()`
- `collectDashscopeVideoImageInputs()`
- `collectImageUrlsFromPayload()`
- `collectDashscopeWanImageInputs()`
- `normalizeDashscopeWanImageInput()`
- `inferImageMimeTypeFromBase64()`
- `normalizeDashscopeImageSize()`
- `shouldRetryDashscopeImageOnStatus()`
- `shouldRetryDashscopeImageOnTaskFailure()`
- `containsDashscopeUrlErrorMessage()`
- `hasDashscopeUrlLikeFields()`
- `buildDashscopeSanitizedImagePayload()`
- `parseJsonObjectFromResponse()`
- `extractDashscopeTaskId()`
- `extractDashscopeTaskStatus()`
- `isDashscopeTaskTerminalFailure()`
- `isDashscopeTaskTerminalSuccess()`
- `resolveDashscopeTaskErrorMessage()`
- `resolveDashscopeTaskQueryEndpointPath()`
- `extractDashscopeImageUrls()`
- `extractDashscopeVideoUrls()`
- `extractDashscopeVideoDurationSeconds()`
- `normalizeTranscriptionResponseFormat()`
- `extractOpenAiChatText()`
- `extractDashscopeAnnotationValue()`
- `buildSubtitleOutput()`
- `isSubtitleText()`
- `normalizeSubtitleText()`
- `extractSubtitleCues()`
- `pickTimestampSeconds()`
- `formatSubtitleTime()`
- `extractDashscopeTranscriptionResultUrls()`
- `fetchDashscopeTranscriptionTextByUrl()`
- `parseMaybeJson()`
- `extractTextFromTranscriptionPayload()`
- `listAvailableModels()`
- `listDefaultModelSlots()`
- `getChatHistory()`
- `normalizeGeminiModelId()`
- `getAvailableGeminiModel()`
- `serializeGeminiModel()`
- `geminiRequestWantsImage()`
- `buildGeminiEmbeddingInput()`
- `normalizeGeminiContentList()`
- `normalizeGeminiPart()`
- `convertGeminiPartsToOpenAiContent()`
- `normalizeGeminiImagePartToValue()`
- `mapGeminiImageConfigToOpenAiSize()`
- `mapEmbeddingForwardedResponseToGemini()`
- `extractDashscopeTempFileRefs()`
- `cleanupDashscopeTempFiles()`
- `parseDataUrl()`
- `isLikelyBase64()`
- `shouldTreatAsRawBase64()`
- `fieldKeySuggestsBinary()`
- `inferMimeTypeFromHints()`
- `extensionByMimeType()`
- `sanitizeFileName()`
- `deepCloneObject()`
- `isDashscopeSource()`
- `extractUsageMetrics()`
- `resolveUsageObject()`
- `aggregateUsageObject()`
- `objectLooksLikeUsage()`
- `extractStreamDeltaText()`
- `extractTextFromContent()`
- `estimateTokensFromText()`
- `extractDurationSecondsFromData()`
- `extractImageCountFromData()`
- `extractVideoResolutionFromData()`
- `resolveVideoResolutionFromPayload()`
- `resolveDurationSecondsFromPayload()`
- `estimateSpeechDurationSecondsFromPayload()`
- `estimateSpeechDurationSecondsFromText()`
- `resolveTtsCharacterCountFromPayload()`
- `resolveImageQualityKey()`
- `resolveImageResolutionKey()`
- `buildPublicVideoResolutionRates()`
- `defaultPublicModelPricingGroup()`
- `buildPublicImageQualityResolutionRates()`
- `resolveVideoResolutionKey()`
- `estimatePromptTokensForPreflight()`
- `normalizePointsPerYuan()`
- `convertRmbToPoints()`
- `resolveAiUsagePointsEventType()`
- `buildAiUsageReferenceId()`
- `buildAsyncVideoReservationKey()`
- `buildSyncImageReservationKey()`
- `buildAsyncVideoPublicTaskId()`
- `resolveDashscopeVideoConcurrencyLimit()`
- `resolveAppIdBySlug()`
- `ensureDashscopeVideoQueueSchema()`
- `normalizeNullableString()`
- `normalizePointsCharge()`
- `estimateMTokenCost()`
- `normalizeRmbPerMToken()`
- `normalizePointsPerMToken()`
- `normalizeLegacyMessages()`
- `normalizeResponsesPayloadToChat()`
- `buildSseEvent()`
- `extractChatStreamDeltaText()`
- `extractChatStreamFinishReason()`
- `mapOpenAiFinishReasonToGemini()`
- `mapOpenAiUsageToGemini()`
- `normalizePromptToText()`
- `normalizeChatMessage()`
- `normalizeLegacyExtraFields()`
- `resolveMinimaxTtsEndpoint()`
- `defaultMinimaxAsyncQueryEndpoint()`
- `looksLikeDashscopeCosyVoiceSsml()`
- `assertDashscopeCosyVoiceSsmlText()`
- `normalizeDashscopeLanguageHints()`
- `assertDashscopeCosyVoiceLanguageHint()`
- `assertDashscopeCosyVoiceVoiceAllowed()`
- `validateMinimaxTtsTextControls()`
- `normalizeMinimaxTtsEmotion()`
- `pickFirstDefined()`
- `extractTtsTextLength()`
- `extractMinimaxAudioBytes()`
- `extractMinimaxVoiceId()`
- `extractMinimaxAsyncTaskInfo()`
- `extractMinimaxAudioUrl()`
- `extractMinimaxFileId()`
- `retrieveMinimaxFile()`
- `extractMinimaxAsyncTaskError()`
- `isMinimaxAsyncTaskCompleted()`
- `extractMinimaxAsyncStatusText()`
- `loadMinimaxVoiceCatalogFromApi()`
- `resolveMinimaxGetVoiceEndpoint()`
- `normalizeMinimaxVoiceApiResponse()`
- `normalizeMinimaxVoiceEntries()`
- `inferMinimaxVoiceLanguage()`
- `normalizeMinimaxVoiceLanguageToken()`
- `inferMinimaxVoiceGender()`
- `extractDashscopeCosyVoiceAudioUrl()`
- `contentTypeByAudioFormat()`
- `audioFormatByMimeType()`
- `loadMinimaxVoiceCatalog()`
- `getNestedString()`
- `getNestedNumber()`
- `getNestedObject()`
- `pickNumber()`
- `pickFirstString()`
- `booleanOrNull()`
- `numberOrNull()`
- `normalizePositiveIntegerOrNull()`
- `normalizePositiveIntegerOrZero()`
- `normalizeObject()`
- `normalizeAliyunIceInputType()`
- `assignIfDefined()`
- `compactObject()`
- `stringifyJsonField()`
- `extractAliyunIceVideoTranslationJobId()`
- `extractAliyunIceVideoTranslationStatus()`
- `isAliyunIceVideoTranslationTerminalSuccess()`
- `isAliyunIceVideoTranslationTerminalFailure()`
- `extractAliyunIceVideoTranslationErrorMessage()`
- `extractAliyunIceVideoTranslationOutputUrls()`
- `collectUrlStrings()`
- `safeJsonPreview()`
- `logAiTrace()`
- `warnAiTrace()`
- `isAiTraceLogEnabled()`
- `truncate()`
- `tryParseJsonObject()`
- `extractMultipartInstruction()`
- `normalizeMultipartHeaders()`
- `numberOrDefault()`
- `boundNumber()`
- `readBoundedInt()`
- `sleep()`
- `minimaxTtsKeyQueueKey()`
- `hashSecret()`
- `stringOrUndefined()`
- `normalizeApiType()`
- `isMinimaxTtsApiType()`
- `isVoiceCloneApiType()`
- `isDashscopeCosyVoiceTtsRoute()`
- `isMinimaxSource()`
- `normalizeEndpointPath()`
- `joinUrl()`
- `normalizeMinimaxEndpointPathForBase()`
- `normalizeCapability()`

### AiGatewayErrorClassifierService
- 服务文件：`src/modules/ai-chat/ai-gateway-error-classifier.service.ts`
- 核心方法：
- `classify()`
- `shouldCooldown()`
- `shouldTryNextRoute()`

### AiGatewaySchedulerService
- 服务文件：`src/modules/ai-chat/ai-gateway-scheduler.service.ts`
- 核心方法：
- `getStats()`
- `rememberStickyRoute()`
- `stringOrUndefined()`
- `readNonNegativeInt()`

### AiGatewayThrottleService
- 服务文件：`src/modules/ai-chat/ai-gateway-throttle.service.ts`
- 核心方法：
- `onModuleDestroy()`
- `acquire()`
- `recordSuccess()`
- `recordFailure()`
- `getStats()`
- `buildLimitKeys()`
- `sourceKey()`
- `assertSourceNotCoolingDown()`
- `acquireMemory()`
- `buildMemoryRelease()`
- `assertFixedWindow()`
- `incrementActive()`
- `decrementActive()`
- `shouldCooldownForFailure()`
- `acquireRedis()`
- `buildRedisRelease()`
- `getRedis()`
- `redisKey()`
- `hashLimitSegment()`
- `acquireRedisLua()`
- `releaseRedisLua()`
- `readNonNegativeInt()`

### AiGatewayUsageQueueService
- 服务文件：`src/modules/ai-chat/ai-gateway-usage-queue.service.ts`
- 核心方法：
- `getStats()`
- `drain()`
- `runQueuedTask()`
- `readOverflowPolicy()`
- `readPositiveInt()`

### InsufficientAiPointsError
- 服务文件：`src/modules/ai-chat/ai-points.service.ts`
- 核心方法：
- `onModuleInit()`
- `getSettingsByAppId()`
- `getWalletByAppId()`
- `serializeWallet()`
- `serializeReservation()`
- `normalizeNonNegativeDecimal2()`
- `normalizeNonNegativeInteger()`
- `toFiniteInteger()`
- `toFiniteDecimal2()`
- `roundTo2()`
- `normalizeReservationKey()`
- `normalizeReservationStatus()`
- `normalizeNullableString()`
- `normalizeJsonObject()`
- `ensureSchema()`
- `initSchema()`

### AiProtocolAdapterService
- 服务文件：`src/modules/ai-chat/ai-protocol-adapter.service.ts`
- 核心方法：
- `withOpenAiStreamUsageOptions()`
- `isStreamingRequest()`
- `isOpenAiCompatibleSource()`
- `isAnthropicSource()`
- `isGeminiSource()`
- `normalizeEndpointPath()`
- `normalizeObject()`

### AiRoutingService
- 服务文件：`src/modules/ai-chat/ai-routing.service.ts`
- 核心方法：
- `onModuleInit()`
- `refreshUsageFactsInterval()`
- `listGlobalSources()`
- `listProviderTemplates()`
- `createGlobalSource()`
- `updateGlobalSource()`
- `deleteGlobalSource()`
- `testSourceConnectivity()`
- `testModelConnectivity()`
- `resolvePlaygroundRoute()`
- `listGlobalModels()`
- `createGlobalModel()`
- `updateGlobalModel()`
- `deleteGlobalModel()`
- `listGlobalModelSourceRoutes()`
- `replaceGlobalModelSourceRoutes()`
- `listAppModelRoutes()`
- `listAppCapabilityDefaults()`
- `listAppDefaultModelSlots()`
- `listAppDefaultModelSlotsBySlug()`
- `deleteAppDefaultModelSlot()`
- `upsertAppModelRoute()`
- `deleteAppModelRoute()`
- `deleteAppCapabilityDefault()`
- `recordUsage()`
- `hasUsageReference()`
- `getUsageSummary()`
- `getUsageBreakdown()`
- `getUsageSummaryFromLogs()`
- `getUsageBreakdownFromLogs()`
- `getUsageSummaryFromFacts()`
- `getUsageBreakdownFromFacts()`
- `listUsageLogs()`
- `listActiveModelsBySlug()`
- `resolveModelRoute()`
- `buildResolvedRouteCacheKey()`
- `findDefaultTtsRouteModels()`
- `isSupportedMinimaxTtsUpstreamModel()`
- `isMinimaxTtsRouteCandidate()`
- `isMinimaxResolvedTtsRoute()`
- `cloneResolvedRoute()`
- `clearResolvedRouteCache()`
- `applyRotatedApiKeysToRoutes()`
- `applyRotatedApiKeyToRoute()`
- `serializeGlobalSource()`
- `getSerializedGlobalSourceById()`
- `listSourceApiKeysMap()`
- `listSourceApiKeys()`
- `normalizeSourceApiKeyInputs()`
- `normalizeVertexServiceAccountJson()`
- `serializeSourceCredentials()`
- `pickPrimarySourceApiKey()`
- `selectNextSourceApiKey()`
- `listActiveSourceApiKeysForRotation()`
- `touchSourceApiKeyLastUsed()`
- `serializeGlobalModel()`
- `serializeAppModelRoute()`
- `serializeAppDefaultModelSlot()`
- `serializeModelSourceRoutes()`
- `isModelSourceRoutesTableAvailable()`
- `ensureModelSourceRoutesTableReady()`
- `listGlobalModelSourceRoutesMap()`
- `normalizeModelSourceRouteInputs()`
- `normalizeRouteKey()`
- `getGlobalModelById()`
- `getGlobalModelRowById()`
- `listAppDefaultModelSlotsForAppId()`
- `getGlobalSourceById()`
- `getActiveGlobalSourceById()`
- `ensureOutboundProxyExists()`
- `findRequestedActiveGlobalModel()`
- `findDefaultActiveGlobalModel()`
- `findActiveAppRoute()`
- `findAppDefaultActiveModel()`
- `findAppDefaultSlotModelsForCapability()`
- `ensureGlobalSourceExists()`
- `ensureGlobalModelExists()`
- `clearDefaultGlobalModels()`
- `ensureAppById()`
- `ensureAppBySlug()`
- `normalizeBaseUrl()`
- `resolveRunningHubModelEndpointPath()`
- `normalizeEndpointPath()`
- `normalizeCapability()`
- `normalizeAppDefaultModelSlot()`
- `normalizeNullableModelId()`
- `normalizeExecutionMode()`
- `defaultPricingModeForCapability()`
- `defaultEndpointPathForCapability()`
- `defaultEndpointPathForApiType()`
- `isMinimaxTtsApiType()`
- `isDashscopeCosyVoiceTtsApiType()`
- `isVoiceCloneApiType()`
- `isOpenRouterApiType()`
- `isOpenRouterSource()`
- `normalizeEndpointPathForProvider()`
- `isDashscopeNativeApiType()`
- `isDashscopeVideoRetalkModel()`
- `isDashscopeSource()`
- `isAliyunIceSource()`
- `resolveAliyunIceAccessKeySecret()`
- `normalizeAliyunIceEndpoint()`
- `extractAliyunRegionFromEndpoint()`
- `normalizeAliyunIceProbeResponse()`
- `normalizeDashscopeNativeBaseUrl()`
- `joinDashscopeNativeUrl()`
- `normalizeDashscopeImageSize()`
- `isDashscopeQwenImageModel()`
- `resolveDashscopeWan27VideoMode()`
- `resolveDashscopeImageProbeEndpointPath()`
- `isGoogleSource()`
- `isVertexAiSource()`
- `isAnthropicSource()`
- `normalizeAnthropicBaseUrl()`
- `shouldUseAnthropicBearerAuth()`
- `normalizeAnthropicHeaders()`
- `buildAnthropicProbeEndpointUrl()`
- `resolveGoogleGenAiBase()`
- `createGoogleGenAiClient()`
- `buildGoogleProbeEndpointUrl()`
- `resolveAiSdkErrorMessage()`
- `buildOpenAiSttProbeForm()`
- `isNoSpeechFoundProbeResponse()`
- `buildTinyWavProbeBuffer()`
- `buildMinimaxSourceProbePayload()`
- `assertRunningHubEndpointPath()`
- `buildTinyPngProbeBuffer()`
- `normalizeMinimaxEndpointPathForBase()`
- `normalizeObject()`
- `normalizeStringObject()`
- `joinUrl()`
- `safeJsonPreview()`
- `truncate()`
- `tryParseJsonObject()`
- `minimaxTtsProbeHasPlayableAudio()`
- `extractMinimaxAsyncTaskId()`
- `getNestedString()`
- `isValidModelKey()`
- `buildArchivedModelKey()`
- `normalizeRmbPerMToken()`
- `normalizeRmbPerCall()`
- `normalizeRmbPerMinute()`
- `normalizePointsPerMToken()`
- `normalizePointsPerCall()`
- `normalizePointsPerMinute()`
- `normalizeCostRmb()`
- `normalizeNullableDecimal()`
- `normalizeBilledUnitLabel()`
- `normalizeNullableString()`
- `normalizeNullableUuid()`
- `normalizeNullableBigInt()`
- `normalizeNullableInt()`
- `toFiniteInteger()`
- `toFiniteNumber()`
- `normalizePositiveInt()`
- `prepareUsageFactsForRead()`
- `refreshUsageFactsFromWatermark()`
- `getMissingUsageFactDays()`
- `refreshUsageFactsForDays()`
- `refreshUsageFactsForDay()`
- `resolveUsageRange()`
- `normalizeUsageSuccess()`
- `buildUsageLedgerJoinSql()`
- `buildUsageEffectivePointsCostSql()`
- `buildUsagePointsEstimatedSql()`
- `buildUsagePointsPricingSourceSql()`
- `toDateOnly()`
- `backfillUsagePointsForRange()`
- `maskSecret()`
- `ensureSchema()`
- `initSchema()`

### AiUpstreamClientService
- 服务文件：`src/modules/ai-chat/ai-upstream-client.service.ts`
- 核心方法：
- `filterResponseHeaders()`
- `readText()`
- `withGatewayHeaders()`
- `buildGatewayRequestId()`
- `assertRequestBodyWithinLimit()`
- `redactUrl()`
- `readPositiveInt()`

### AiVideoResultProxyService
- 服务文件：`src/modules/ai-chat/ai-video-result-proxy.service.ts`
- 核心方法：
- `digest()`
- `_transform()`
- `resolveVideoUrls()`
- `cleanupExpiredAssets()`
- `findAsset()`
- `claimAsset()`
- `getSettings()`
- `normalizeSettings()`
- `buildObjectKey()`
- `hashValue()`
- `isExpired()`
- `parseContentLength()`
- `normalizeVideoMimeType()`
- `extensionForMimeType()`
- `asObject()`
- `boundedInt()`
- `truncate()`

### AiVoicesService
- 服务文件：`src/modules/ai-chat/ai-voices.service.ts`
- 核心方法：
- `onModuleInit()`
- `cloneVoice()`
- `listVoices()`
- `getVoiceByPublicId()`
- `deleteVoice()`
- `resolveVoiceForTts()`
- `applyResolvedVoiceToPayload()`
- `filterRoutesForVoice()`
- `filterSpeechRoutes()`
- `listAdminVoices()`
- `createMigrationJob()`
- `getMigrationJob()`
- `activateMapping()`
- `migrateVoice()`
- `retryClone()`
- `processMigrationJobs()`
- `processMigrationJobItems()`
- `persistSample()`
- `downloadVoiceSample()`
- `parseWavDurationMs()`
- `extractAudioDurationMs()`
- `checkFfprobeAvailable()`
- `readJsonResponse()`
- `assertMinimaxBaseRespOk()`
- `isMinimaxDurationViolation()`
- `resolveVoiceCloneRoute()`
- `resolveLinkedTtsModelForCloneRoute()`
- `resolveRouteByModelAndSource()`
- `findVoiceRow()`
- `findUserOwnedVoiceRow()`
- `resolveApp()`
- `assertAllowedAudio()`
- `serializeVoice()`
- `extractPublicVoiceId()`
- `isVoiceCloneRoute()`
- `isVoiceCloneApiType()`
- `isMinimaxRoute()`
- `isDashscopeCosyVoiceRoute()`
- `normalizeDashscopeLanguageHints()`
- `assertDashscopeCosyVoiceLanguageHint()`
- `assertDashscopeCosyVoiceTargetModelSupported()`
- `resolveDashscopeVoicePrefix()`
- `extractProviderVoiceId()`
- `extractMinimaxFileId()`
- `getNestedString()`
- `getNestedNumber()`
- `ensureSchema()`
- `createSchema()`
- `normalizeObject()`
- `normalizeString()`
- `boundInt()`
- `generatePublicVoiceId()`
- `generateVoiceCloneTraceId()`
- `generateProviderVoiceId()`
- `isAllowedVoiceSampleKey()`
- `sha256()`
- `joinUrl()`
- `resolveMinimaxFileUploadEndpoint()`
- `resolveMinimaxVoiceCloneEndpoint()`
- `resolveDashscopeCosyVoiceCloneEndpoint()`
- `minimaxBaseUrl()`
- `normalizeMinimaxVoiceCloneEndpointPath()`
- `fileNameForMimeType()`
- `redactProviderRequest()`
- `stripQuery()`
- `serializeJsonRow()`
- `invalidateVoiceCache()`
- `truncate()`

### AiDebugAuthService
- 服务文件：`src/modules/ai-chat/guards/ai-debug-auth.service.ts`
- 核心方法：
- `onModuleInit()`
- `authenticateRequest()`
- `resolveAppSlug()`
- `warnIfProductionConfigured()`
- `assertEnabledConfigIsUsable()`
- `isEnabled()`
- `expectedToken()`
- `isProductionLike()`
- `extractBearerToken()`
- `normalizeString()`
- `secureEquals()`

## 5. 数据库/存储依赖（自动扫描）
- `ai`
- `ai_app_capability_defaults`
- `ai_app_default_model_slots`
- `ai_app_model_routes`
- `ai_async_video_tasks`
- `ai_global_models`
- `ai_global_source_api_keys`
- `ai_global_sources`
- `ai_model_source_routes`
- `ai_usage_daily_facts`
- `ai_usage_fact_refresh_state`
- `ai_usage_logs`
- `ai_usage_user_daily_facts`
- `ai_video_result_assets`
- `ai_voice_assets`
- `ai_voice_migration_items`
- `ai_voice_migration_jobs`
- `ai_voice_provider_mappings`
- `api`
- `app_ai_points_settings`
- `app_settings`
- `apps`
- `daily_agg`
- `days`
- `lateral`
- `outbound_proxies`
- `pg_constraint`
- `skip`
- `user_ai_points_ledger`
- `user_ai_points_reservations`
- `user_ai_points_wallets`
- `users`

## 6. 模块依赖（自动扫描）
- `..`
- `api-keys`
- `auth`
- `outbound-proxy`
- `upload`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
