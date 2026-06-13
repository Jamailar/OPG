import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  PlatformAiModelItem,
  PlatformAiPlaygroundResult,
  PlatformAiSourceItem,
  PlatformAppItem,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type CapabilityFilter = 'ALL' | PlatformAiModelItem['capability'];

interface AiModelPlaygroundPanelProps {
  apps: PlatformAppItem[];
  models: PlatformAiModelItem[];
  sources: PlatformAiSourceItem[];
  initialModelId?: string | null;
}

type UploadedAsset = {
  name: string;
  mimeType: string;
  base64: string;
};

type RunHistoryItem = {
  id: string;
  createdAt: string;
  appName: string;
  modelLabel: string;
  capability: PlatformAiModelItem['capability'];
  resultType: string;
  taskStatus: string | null;
  summary: string;
};

const CAPABILITY_LABELS: Record<PlatformAiModelItem['capability'], string> = {
  chat: '对话',
  embedding: '向量',
  tts: '语音合成',
  stt: '语音转录',
  image: '图片生成',
  video: '视频生成',
};

const PLAYGROUND_CAPABILITY_OPTIONS: Array<{ value: CapabilityFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'chat', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'tts', label: '语音' },
  { value: 'stt', label: '转录' },
  { value: 'video', label: '视频' },
  { value: 'embedding', label: '向量' },
];

const CAPABILITY_DESCRIPTIONS: Record<PlatformAiModelItem['capability'], string> = {
  chat: '编写提示词并检查回复结构、稳定性和风格控制。',
  embedding: '输入文本并快速检查向量维度与返回片段。',
  tts: '测试语音风格、输出格式和播放效果。',
  stt: '上传音频，验证转录质量、停顿和专有名词识别。',
  image: '验证提示词、负向提示词和尺寸设置对图片结果的影响。',
  video: '提交视频任务，观察任务状态、结果链接和生成稳定性。',
};

const IMAGE_SIZE_OPTIONS = ['1024x1024', '1280x720', '720x1280', '1536x1024'];
const VIDEO_RESOLUTION_OPTIONS = ['480P', '720P', '1080P'];
const VIDEO_DURATION_OPTIONS = [5, 10];
const TTS_FORMAT_OPTIONS = ['mp3', 'wav', 'pcm'];

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || '');
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const rawBase64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(rawBase64);
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

export default function AiModelPlaygroundPanel({
  apps,
  models,
  sources,
  initialModelId,
}: AiModelPlaygroundPanelProps) {
  const [message, setMessage] = useState<Message>(null);
  const [running, setRunning] = useState(false);
  const [queryingTask, setQueryingTask] = useState(false);
  const [result, setResult] = useState<PlatformAiPlaygroundResult | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryItem[]>([]);

  const [selectedAppId, setSelectedAppId] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>('ALL');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState('');

  const [chatPrompt, setChatPrompt] = useState('请用一句话返回当前模型已经连通。');
  const [chatSystemPrompt, setChatSystemPrompt] = useState('');
  const [embeddingInput, setEmbeddingInput] = useState('AI 模型调试向量样本');
  const [ttsText, setTtsText] = useState('这是平台模型调试台的语音合成测试。');
  const [ttsVoice, setTtsVoice] = useState('alloy');
  const [ttsFormat, setTtsFormat] = useState('mp3');
  const [sttAsset, setSttAsset] = useState<UploadedAsset | null>(null);
  const [imagePrompt, setImagePrompt] = useState('一张高质感产品主视觉海报，主体清晰，构图稳定，适合后台调试验证');
  const [imageNegativePrompt, setImageNegativePrompt] = useState('');
  const [imageSize, setImageSize] = useState('1024x1024');
  const [imageCount, setImageCount] = useState('1');
  const [videoPrompt, setVideoPrompt] = useState('一个产品展示镜头，光线自然，动作平稳，主体清晰，适合检验视频生成质量');
  const [videoNegativePrompt, setVideoNegativePrompt] = useState('');
  const [videoResolution, setVideoResolution] = useState('720P');
  const [videoDuration, setVideoDuration] = useState('5');
  const [videoMode, setVideoMode] = useState<'sync' | 'async'>('async');
  const [extraPayloadJson, setExtraPayloadJson] = useState('{}');

  useEffect(() => {
    if (!selectedAppId && apps[0]) {
      setSelectedAppId(apps[0].id);
    }
  }, [apps, selectedAppId]);

  useEffect(() => {
    if (!models.length) {
      return;
    }
    if (initialModelId) {
      const matched = models.find((item) => item.id === initialModelId);
      if (matched) {
        setSelectedModelId(matched.id);
        setCapabilityFilter(matched.capability);
        return;
      }
    }
    if (!selectedModelId && models[0]) {
      setSelectedModelId(models[0].id);
    }
  }, [initialModelId, models, selectedModelId]);

  const filteredModels = useMemo(
    () => (
      capabilityFilter === 'ALL'
        ? models
        : models.filter((item) => item.capability === capabilityFilter)
    ),
    [capabilityFilter, models],
  );

  useEffect(() => {
    if (!filteredModels.length) {
      setSelectedModelId('');
      return;
    }
    if (!filteredModels.some((item) => item.id === selectedModelId)) {
      setSelectedModelId(filteredModels[0].id);
    }
  }, [filteredModels, selectedModelId]);

  const selectedModel = useMemo(
    () => models.find((item) => item.id === selectedModelId) || null,
    [models, selectedModelId],
  );

  useEffect(() => {
    if (selectedModel?.default_source_id) {
      setSelectedSourceId(selectedModel.default_source_id);
    }
  }, [selectedModel?.id, selectedModel?.default_source_id]);

  const selectedSource = useMemo(
    () => sources.find((item) => item.id === selectedSourceId) || null,
    [sources, selectedSourceId],
  );

  const selectedApp = useMemo(
    () => apps.find((item) => item.id === selectedAppId) || null,
    [apps, selectedAppId],
  );

  const currentCapability = selectedModel?.capability || 'chat';

  const currentTemplates = useMemo(() => {
    const base = {
      chat: [
        {
          label: '客服回复',
          apply: () => {
            setChatSystemPrompt('你是专业客服助手，回答要明确、简洁、可执行。');
            setChatPrompt('用户说：支付成功了，但会员没有到账。请给出排查步骤。');
          },
        },
        {
          label: '结构化输出',
          apply: () => {
            setChatSystemPrompt('请始终输出 JSON，包含 title、risk_level、actions 三个字段。');
            setChatPrompt('分析一条“视频生成失败，任务状态卡住 20 分钟”的工单。');
          },
        },
      ],
      embedding: [
        {
          label: '检索样本',
          apply: () => setEmbeddingInput('如何比较不同图片生成模型的细节还原能力'),
        },
        {
          label: '分类样本',
          apply: () => setEmbeddingInput('订单退款异常排查流程'),
        },
      ],
      tts: [
        {
          label: '播报短句',
          apply: () => {
            setTtsText('欢迎进入平台 AI 调试台，本次测试用于检查语音质量和稳定性。');
            setTtsFormat('mp3');
          },
        },
        {
          label: '长句停顿',
          apply: () => {
            setTtsText('今天我们需要重点检查三件事：发音是否自然，停顿是否稳定，以及长句末尾是否被截断。');
            setTtsFormat('wav');
          },
        },
      ],
      stt: [
        {
          label: '转录提示',
          apply: () => setMessage({ type: 'success', text: '上传一段包含口语停顿和专有名词的音频，更容易看出 STT 真实水平。' }),
        },
      ],
      image: [
        {
          label: '商品主图',
          apply: () => {
            setImagePrompt('一张护肤品电商主图，白色背景，玻璃瓶身，柔和高光，商业摄影质感');
            setImageNegativePrompt('模糊，低清晰度，畸变，多余物体');
            setImageSize('1024x1024');
          },
        },
        {
          label: '海报风格',
          apply: () => {
            setImagePrompt('一张科技产品发布海报，强烈视觉中心，干净排版感，电影级灯光');
            setImageNegativePrompt('文字乱码，重复元素，杂乱背景');
            setImageSize('1280x720');
          },
        },
      ],
      video: [
        {
          label: '产品展示',
          apply: () => {
            setVideoPrompt('桌面上的智能硬件产品缓慢旋转展示，镜头平稳推进，背景干净，光影自然');
            setVideoNegativePrompt('抖动，闪烁，畸形，模糊');
            setVideoResolution('720P');
            setVideoDuration('5');
            setVideoMode('async');
          },
        },
        {
          label: '人物口播',
          apply: () => {
            setVideoPrompt('人物正面口播镜头，嘴型自然，视线稳定，背景简洁，光线均匀');
            setVideoNegativePrompt('肢体扭曲，嘴型错乱，背景闪烁');
            setVideoResolution('1080P');
            setVideoDuration('5');
            setVideoMode('async');
          },
        },
      ],
    };
    return base[currentCapability];
  }, [currentCapability]);

  const buildExtraPayload = () => {
    const raw = extraPayloadJson.trim();
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('额外参数必须是 JSON 对象');
      }
      return parsed as Record<string, unknown>;
    } catch (error: any) {
      throw new Error(error?.message || '额外参数不是有效 JSON');
    }
  };

  const buildPayload = () => {
    const extraPayload = buildExtraPayload();
    switch (currentCapability) {
      case 'chat':
        return {
          messages: [
            ...(chatSystemPrompt.trim() ? [{ role: 'system', content: chatSystemPrompt.trim() }] : []),
            { role: 'user', content: chatPrompt.trim() || 'ping' },
          ],
          ...extraPayload,
        };
      case 'embedding':
        return {
          input: embeddingInput.trim() || 'AI 模型调试向量样本',
          ...extraPayload,
        };
      case 'tts':
        return {
          input: ttsText.trim() || '这是平台模型调试台的语音合成测试。',
          voice: ttsVoice.trim() || 'alloy',
          response_format: ttsFormat,
          return_audio_binary: true,
          prefer_sync_tts: true,
          ...extraPayload,
        };
      case 'stt':
        if (!sttAsset) {
          throw new Error('请先上传音频文件');
        }
        return {
          response_format: 'verbose_json',
          __multipart: {
            file_base64: sttAsset.base64,
            file_name: sttAsset.name,
            file_mime_type: sttAsset.mimeType || 'audio/mpeg',
          },
          ...extraPayload,
        };
      case 'image':
        return {
          prompt: imagePrompt.trim() || '测试图片',
          size: imageSize,
          n: Number(imageCount) || 1,
          ...(imageNegativePrompt.trim() ? { negative_prompt: imageNegativePrompt.trim() } : {}),
          response_format: 'b64_json',
          ...extraPayload,
        };
      case 'video':
        return {
          prompt: videoPrompt.trim() || '测试视频',
          resolution: videoResolution,
          duration: Number(videoDuration) || 5,
          ...(videoNegativePrompt.trim() ? { negative_prompt: videoNegativePrompt.trim() } : {}),
          ...extraPayload,
        };
      default:
        return extraPayload;
    }
  };

  const appendRunHistory = (nextResult: PlatformAiPlaygroundResult) => {
    setRunHistory((prev) => {
      const item: RunHistoryItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        appName: selectedApp?.name || selectedApp?.slug || '-',
        modelLabel: nextResult.route.display_name || nextResult.route.model_key,
        capability: nextResult.capability,
        resultType: nextResult.result_type,
        taskStatus: nextResult.task_status || null,
        summary:
          nextResult.text
          || nextResult.video_url
          || nextResult.task_id
          || nextResult.images[0]?.url
          || nextResult.response_excerpt
          || '返回成功',
      };
      return [item, ...prev].slice(0, 8);
    });
  };

  const runPlayground = async () => {
    if (!selectedAppId) {
      setMessage({ type: 'error', text: '请先选择测试应用' });
      return;
    }
    if (!selectedModel) {
      setMessage({ type: 'error', text: '请先选择模型' });
      return;
    }
    setRunning(true);
    setMessage(null);
    try {
      const response = await platformApi.runGlobalAiModelPlayground({
        app_id: selectedAppId,
        model_id: selectedModel.id,
        source_id: selectedSourceId || undefined,
        video_mode: currentCapability === 'video' ? videoMode : undefined,
        payload: buildPayload(),
      });
      const data = pickApiData<PlatformAiPlaygroundResult>(response) || (response as PlatformAiPlaygroundResult);
      setResult(data);
      appendRunHistory(data);
      setMessage({
        type: 'success',
        text:
          currentCapability === 'video' && data.task_id && videoMode === 'async'
            ? '视频任务已提交，可以继续刷新任务状态。'
            : '调试调用已完成。',
      });
    } catch (error: any) {
      setResult(null);
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '模型调试调用失败') });
    } finally {
      setRunning(false);
    }
  };

  const queryVideoTask = async () => {
    if (!selectedAppId || !selectedModel) {
      setMessage({ type: 'error', text: '请先选择测试应用和模型' });
      return;
    }
    if (!result?.task_id) {
      setMessage({ type: 'error', text: '当前没有可查询的视频任务' });
      return;
    }
    setQueryingTask(true);
    setMessage(null);
    try {
      const response = await platformApi.queryGlobalAiModelPlayground({
        app_id: selectedAppId,
        model_id: selectedModel.id,
        source_id: selectedSourceId || undefined,
        payload: {
          task_id: result.task_id,
        },
      });
      const data = pickApiData<PlatformAiPlaygroundResult>(response) || (response as PlatformAiPlaygroundResult);
      setResult(data);
      appendRunHistory(data);
      setMessage({ type: 'success', text: '任务状态已刷新。' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '查询视频任务失败') });
    } finally {
      setQueryingTask(false);
    }
  };

  const handleAudioUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setSttAsset({
        name: file.name,
        mimeType: file.type || 'audio/mpeg',
        base64,
      });
      setMessage({ type: 'success', text: `已载入音频文件：${file.name}` });
      setResult(null);
    } catch (error: any) {
      setSttAsset(null);
      setMessage({ type: 'error', text: error?.message || '读取音频文件失败' });
    } finally {
      event.target.value = '';
    }
  };

  const audioPreviewSrc = result?.audio_url
    || (result?.audio_base64 ? `data:${result.audio_mime_type || 'audio/mpeg'};base64,${result.audio_base64}` : null);

  const currentCapabilityDescription = CAPABILITY_DESCRIPTIONS[currentCapability];
  const currentEndpointPath = result?.route.endpoint_path || selectedModel?.endpoint_path || '-';
  const resultStatusTone = result?.task_status
    ? (String(result.task_status).toUpperCase().includes('FAIL') ? 'error' : 'success')
    : 'info';

  return (
    <div className="ai-playground-workbench">
      <section className="card ai-playground-shell">
        <div className="ai-playground-shell-top">
          <div className="ai-playground-shell-copy">
            <span className="ai-playground-kicker">AI Playground</span>
            <h2>像真正使用模型一样，直接验证输出质量</h2>
            <p>选择应用、模型和供应商，发送真实请求，立即查看文本、图片、音频、视频和调试细节。</p>
          </div>
          <div className="ai-playground-metrics" aria-label="playground-overview">
            <article className="ai-playground-metric">
              <span>应用</span>
              <strong>{apps.length}</strong>
            </article>
            <article className="ai-playground-metric">
              <span>模型</span>
              <strong>{models.length}</strong>
            </article>
            <article className="ai-playground-metric">
              <span>供应商</span>
              <strong>{sources.length}</strong>
            </article>
          </div>
        </div>

        <div className="ai-playground-capability-tabs" role="tablist" aria-label="能力筛选">
          {PLAYGROUND_CAPABILITY_OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`ai-playground-capability-tab ${capabilityFilter === item.value ? 'active' : ''}`}
              onClick={() => setCapabilityFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="ai-playground-toolbar">
          <label className="ai-playground-field">
            <span>测试应用</span>
            <select value={selectedAppId} onChange={(event) => setSelectedAppId(event.target.value)}>
              {apps.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} / {item.slug}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-playground-field">
            <span>模型</span>
            <select value={selectedModelId} onChange={(event) => setSelectedModelId(event.target.value)}>
              {filteredModels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.display_name || item.model_key} / {item.model_key}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-playground-field">
            <span>测试源</span>
            <select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}>
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} / {item.provider_type}
                </option>
              ))}
            </select>
          </label>

          <div className="ai-playground-run-slot">
            {currentCapability === 'video' && result?.task_id ? (
              <button className="btn btn-secondary btn-sm" onClick={queryVideoTask} disabled={queryingTask}>
                {queryingTask ? '刷新中...' : '刷新任务'}
              </button>
            ) : null}
            <button className="btn btn-primary btn-sm" onClick={runPlayground} disabled={running || !selectedModel}>
              {running ? '调用中...' : '运行'}
            </button>
          </div>
        </div>

        <div className="ai-playground-meta-strip">
          <div className="ai-playground-meta-chip">
            <span>当前能力</span>
            <strong>{selectedModel ? CAPABILITY_LABELS[selectedModel.capability] : '-'}</strong>
          </div>
          <div className="ai-playground-meta-chip">
            <span>上游模型</span>
            <strong>{selectedModel?.upstream_model || '-'}</strong>
          </div>
          <div className="ai-playground-meta-chip">
            <span>供应商</span>
            <strong>{selectedSource?.provider_type || '-'}</strong>
          </div>
          <div className="ai-playground-meta-chip wide">
            <span>接口路径</span>
            <strong>{currentEndpointPath}</strong>
          </div>
        </div>
      </section>

      {message ? <div className={`alert alert-${message.type}`}>{message.text}</div> : null}

      {!apps.length || !models.length ? (
        <div className="ai-hub-empty">需要先准备应用和模型，Playground 才能开始调试。</div>
      ) : (
        <div className="ai-playground-stage">
          <section className="card ai-playground-editor-panel">
            <div className="ai-playground-panel-head">
              <div>
                <h3>{selectedModel ? CAPABILITY_LABELS[selectedModel.capability] : '输入面板'}</h3>
                <p>{currentCapabilityDescription}</p>
              </div>
              <div className="ai-playground-template-grid">
                {currentTemplates.map((item) => (
                  <button key={item.label} type="button" className="ai-playground-template-pill" onClick={item.apply}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="ai-playground-prompt-surface">
              {currentCapability === 'chat' ? (
                <div className="ai-playground-editor-stack">
                  <label className="ai-playground-field span-2">
                    <span>系统提示词</span>
                    <textarea
                      rows={4}
                      value={chatSystemPrompt}
                      onChange={(event) => setChatSystemPrompt(event.target.value)}
                      placeholder="可选"
                    />
                  </label>
                  <label className="ai-playground-field span-2">
                    <span>用户消息</span>
                    <textarea
                      rows={12}
                      value={chatPrompt}
                      onChange={(event) => setChatPrompt(event.target.value)}
                    />
                  </label>
                </div>
              ) : null}

              {currentCapability === 'embedding' ? (
                <div className="ai-playground-editor-stack">
                  <label className="ai-playground-field span-2">
                    <span>向量输入</span>
                    <textarea rows={12} value={embeddingInput} onChange={(event) => setEmbeddingInput(event.target.value)} />
                  </label>
                </div>
              ) : null}

              {currentCapability === 'tts' ? (
                <div className="ai-playground-editor-stack">
                  <label className="ai-playground-field span-2">
                    <span>合成文本</span>
                    <textarea rows={10} value={ttsText} onChange={(event) => setTtsText(event.target.value)} />
                  </label>
                  <label className="ai-playground-field">
                    <span>音色</span>
                    <input value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)} />
                  </label>
                  <label className="ai-playground-field">
                    <span>输出格式</span>
                    <select value={ttsFormat} onChange={(event) => setTtsFormat(event.target.value)}>
                      {TTS_FORMAT_OPTIONS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}

              {currentCapability === 'stt' ? (
                <div className="ai-playground-editor-stack">
                  <label className="ai-playground-field span-2">
                    <span>上传音频</span>
                    <input type="file" accept="audio/*" onChange={handleAudioUpload} />
                  </label>
                  <div className="ai-playground-upload-card span-2">
                    <strong>{sttAsset ? sttAsset.name : '未选择音频文件'}</strong>
                    <span>{sttAsset ? `${sttAsset.mimeType} · ${(sttAsset.base64.length / 1024).toFixed(1)} KB(base64)` : '支持直接上传音频做转录测试'}</span>
                  </div>
                </div>
              ) : null}

              {currentCapability === 'image' ? (
                <div className="ai-playground-editor-stack">
                  <label className="ai-playground-field span-2">
                    <span>图片提示词</span>
                    <textarea rows={10} value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} />
                  </label>
                  <label className="ai-playground-field span-2">
                    <span>负向提示词</span>
                    <textarea rows={5} value={imageNegativePrompt} onChange={(event) => setImageNegativePrompt(event.target.value)} placeholder="可选" />
                  </label>
                  <label className="ai-playground-field">
                    <span>尺寸</span>
                    <select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>
                      {IMAGE_SIZE_OPTIONS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ai-playground-field">
                    <span>张数</span>
                    <input value={imageCount} onChange={(event) => setImageCount(event.target.value)} />
                  </label>
                </div>
              ) : null}

              {currentCapability === 'video' ? (
                <div className="ai-playground-editor-stack">
                  <label className="ai-playground-field span-2">
                    <span>视频提示词</span>
                    <textarea rows={10} value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} />
                  </label>
                  <label className="ai-playground-field span-2">
                    <span>负向提示词</span>
                    <textarea rows={5} value={videoNegativePrompt} onChange={(event) => setVideoNegativePrompt(event.target.value)} placeholder="可选" />
                  </label>
                  <label className="ai-playground-field">
                    <span>分辨率</span>
                    <select value={videoResolution} onChange={(event) => setVideoResolution(event.target.value)}>
                      {VIDEO_RESOLUTION_OPTIONS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ai-playground-field">
                    <span>时长（秒）</span>
                    <select value={videoDuration} onChange={(event) => setVideoDuration(event.target.value)}>
                      {VIDEO_DURATION_OPTIONS.map((item) => (
                        <option key={item} value={String(item)}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ai-playground-field">
                    <span>提交方式</span>
                    <select value={videoMode} onChange={(event) => setVideoMode(event.target.value as 'sync' | 'async')}>
                      <option value="async">异步任务</option>
                      <option value="sync">同步等待</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </div>

            <div className="ai-playground-params-card">
              <div className="ai-playground-section-label">
                <strong>额外参数</strong>
                <span>需要覆盖默认请求参数时，再填写 JSON。</span>
              </div>
              <label className="ai-playground-field">
                <textarea
                  rows={6}
                  value={extraPayloadJson}
                  onChange={(event) => setExtraPayloadJson(event.target.value)}
                  placeholder='例如：{"temperature":0.2}'
                />
              </label>
            </div>
          </section>

          <aside className="ai-playground-side">
            <section className="card ai-playground-preview-panel">
              <div className="ai-playground-panel-head compact">
                <div>
                  <h3>结果预览</h3>
                  <p>先看输出，再决定是否继续微调参数。</p>
                </div>
                {result ? (
                  <div className="ai-playground-result-summary">
                    <span className="status-tag info">{result.result_type}</span>
                    {result.task_status ? <span className={`status-tag ${resultStatusTone}`}>{result.task_status}</span> : null}
                  </div>
                ) : null}
              </div>

              <div className="ai-playground-preview-surface">
                {result ? (
                  <div className="ai-playground-inspector-stack">
                    {result.task_id ? <code className="ai-playground-task-code">{result.task_id}</code> : null}

                    {result.text ? (
                      <div className="ai-playground-preview-block">
                        <span>文本结果</span>
                        <pre>{result.text}</pre>
                      </div>
                    ) : null}

                    {audioPreviewSrc ? (
                      <div className="ai-playground-preview-block">
                        <span>音频结果</span>
                        <audio controls className="ai-playground-audio" src={audioPreviewSrc} />
                      </div>
                    ) : null}

                    {result.images.length > 0 ? (
                      <div className="ai-playground-preview-block">
                        <span>图片结果</span>
                        <div className="ai-playground-media-grid">
                          {result.images.map((item, index) => {
                            const src = item.url || (item.b64_json ? `data:${item.mime_type || 'image/png'};base64,${item.b64_json}` : '');
                            return src ? <img key={`${src}-${index}`} src={src} alt={`playground-${index + 1}`} /> : null;
                          })}
                        </div>
                      </div>
                    ) : null}

                    {result.videos.length > 0 || result.video_url ? (
                      <div className="ai-playground-preview-block">
                        <span>视频结果</span>
                        <div className="ai-playground-media-grid">
                          {(result.videos.length > 0 ? result.videos : [{ url: result.video_url }]).map((item, index) =>
                            item.url ? <video key={`${item.url}-${index}`} src={item.url} controls className="ai-playground-video" /> : null
                          )}
                        </div>
                      </div>
                    ) : null}

                    {result.capability === 'embedding' ? (
                      <div className="ai-playground-vector-card">
                        <strong>{result.embedding_count} 条向量</strong>
                        <span>维度：{result.embedding_dimensions}</span>
                        <code>{result.embedding_preview.join(', ') || '无预览数据'}</code>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="ai-playground-empty-state">
                    <strong>尚未运行</strong>
                    <p>输入提示词并点击运行，这里会显示文本、图片、音频、视频或向量结果。</p>
                  </div>
                )}
              </div>
            </section>

            <section className="card ai-playground-diagnostics-panel">
              <div className="ai-playground-panel-head compact">
                <div>
                  <h3>诊断信息</h3>
                  <p>确认路由、返回片段和原始响应。</p>
                </div>
              </div>

              {result ? (
                <div className="ai-playground-diagnostics-stack">
                  <div className="ai-playground-context-card">
                    <div>
                      <span>应用</span>
                      <strong>{result.route.app_slug}</strong>
                    </div>
                    <div>
                      <span>上游模型</span>
                      <strong>{result.route.upstream_model}</strong>
                    </div>
                    <div>
                      <span>API 类型</span>
                      <strong>{result.route.api_type}</strong>
                    </div>
                    <div>
                      <span>接口路径</span>
                      <strong>{result.route.endpoint_path}</strong>
                    </div>
                  </div>

                  <details className="ai-playground-debug-block" open={currentCapability === 'video'}>
                    <summary>响应片段</summary>
                    <pre>{result.response_excerpt || '无响应片段'}</pre>
                  </details>

                  <details className="ai-playground-debug-block">
                    <summary>原始响应</summary>
                    <pre>{stringifyJson(result.raw_data || {})}</pre>
                  </details>
                </div>
              ) : (
                <div className="ai-hub-empty">运行后可查看接口路径、响应片段和原始响应。</div>
              )}
            </section>

            <section className="card ai-playground-history-panel">
              <div className="ai-playground-panel-head compact">
                <div>
                  <h3>最近运行</h3>
                  <p>快速回看最近几次结果。</p>
                </div>
              </div>
              {runHistory.length === 0 ? (
                <div className="ai-hub-empty">还没有运行记录</div>
              ) : (
                <div className="ai-playground-history-list">
                  {runHistory.map((item) => (
                    <article key={item.id} className="ai-playground-history-item">
                      <div className="ai-playground-history-head">
                        <strong>{item.modelLabel}</strong>
                        <span>{formatDateTime(item.createdAt)}</span>
                      </div>
                      <div className="ai-playground-history-meta">
                        <span>{item.appName}</span>
                        <span>{CAPABILITY_LABELS[item.capability]}</span>
                        <span>{item.resultType}</span>
                        {item.taskStatus ? <span>{item.taskStatus}</span> : null}
                      </div>
                      <p>{item.summary}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
