import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import AiModelPlaygroundPanel from '@/pages/platform/components/AiModelPlaygroundPanel';
import { PlatformAiModelItem, PlatformAiSourceItem, PlatformAppItem, platformApi } from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

export default function GlobalAiPlaygroundPage() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [sources, setSources] = useState<PlatformAiSourceItem[]>([]);
  const [models, setModels] = useState<PlatformAiModelItem[]>([]);

  const initialModelId = searchParams.get('model_id');

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [appsResp, sourcesResp, modelsResp] = await Promise.all([
        platformApi.listApps(true),
        platformApi.listGlobalAiSources(),
        platformApi.listGlobalAiModels(),
      ]);
      setApps(pickApiData<{ items: PlatformAppItem[] }>(appsResp)?.items || []);
      setSources(pickApiData<{ items: PlatformAiSourceItem[] }>(sourcesResp)?.items || []);
      setModels(pickApiData<{ items: PlatformAiModelItem[] }>(modelsResp)?.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 Playground 数据失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  return (
    <div className="platform-page ai-playground-page">
      <div className="ai-playground-page-head">
        <div>
          <h1>AI Playground</h1>
          <p>直接调试文本、图片、语音、转录和视频模型，快速判断是否可以对外开放。</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {message ? <div className={`alert alert-${message.type}`}>{message.text}</div> : null}

      <AiModelPlaygroundPanel
        apps={apps}
        models={models}
        sources={sources}
        initialModelId={initialModelId}
      />
    </div>
  );
}
