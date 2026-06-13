import { useEffect, useMemo, useState } from 'react';
import AiUsageInsightsPanel from '@/pages/platform/components/AiUsageInsightsPanel';
import {
  PlatformAiUsageBreakdown,
  PlatformAiModelItem,
  PlatformAiSourceItem,
  PlatformAiUsageLogItem,
  PlatformAiUsageSummary,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type CapabilityFilter = 'ALL' | 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
type SuccessFilter = 'ALL' | 'SUCCESS' | 'FAILED';
type RangePreset = '7' | '30' | '90' | '180' | '365' | 'custom';

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

export default function GlobalAiUsagePage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [summary, setSummary] = useState<PlatformAiUsageSummary | null>(null);
  const [breakdown, setBreakdown] = useState<PlatformAiUsageBreakdown | null>(null);
  const [logs, setLogs] = useState<PlatformAiUsageLogItem[]>([]);
  const [sources, setSources] = useState<PlatformAiSourceItem[]>([]);
  const [models, setModels] = useState<PlatformAiModelItem[]>([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);

  const [rangePreset, setRangePreset] = useState<RangePreset>('30');
  const [customFrom, setCustomFrom] = useState(() => formatDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [customTo, setCustomTo] = useState(() => formatDateInput(new Date()));
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>('ALL');
  const [modelIdFilter, setModelIdFilter] = useState('');
  const [sourceIdFilter, setSourceIdFilter] = useState('');
  const [successFilter, setSuccessFilter] = useState<SuccessFilter>('ALL');

  const modelOptions = useMemo(
    () => models.map((item) => ({ value: item.id, label: `${item.display_name || item.model_key} / ${item.model_key}` })),
    [models],
  );

  const sourceOptions = useMemo(
    () => sources.map((item) => ({ id: item.id, name: item.name, provider_type: item.provider_type })),
    [sources],
  );

  const buildParams = () => {
    const params: Record<string, unknown> = {};
    if (rangePreset === 'custom') {
      Object.assign(params, resolveCustomIsoRange(customFrom, customTo));
    } else {
      params.days = Number(rangePreset);
    }
    if (capabilityFilter !== 'ALL') params.capability = capabilityFilter;
    if (modelIdFilter) params.model_id = modelIdFilter;
    if (sourceIdFilter) params.source_id = sourceIdFilter;
    if (successFilter === 'SUCCESS') params.success = true;
    if (successFilter === 'FAILED') params.success = false;
    return params;
  };

  const loadSummaryData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const params = buildParams();
      const [sourcesResp, modelsResp, summaryResp, logsResp] = await Promise.all([
        platformApi.listGlobalAiSources(),
        platformApi.listGlobalAiModels(),
        platformApi.getGlobalAiUsageSummary(params),
        platformApi.listGlobalAiUsageLogs({ ...params, page: 1, page_size: 20 }),
      ]);
      const sourceData = pickApiData<{ items: PlatformAiSourceItem[] }>(sourcesResp);
      const modelData = pickApiData<{ items: PlatformAiModelItem[] }>(modelsResp);
      const summaryData = pickApiData<PlatformAiUsageSummary>(summaryResp);
      const logsData = pickApiData<{ items: PlatformAiUsageLogItem[] } & Record<string, unknown>>(logsResp);
      setSources(sourceData?.items || []);
      setModels(modelData?.items || []);
      setSummary(summaryData || null);
      setLogs((logsData?.items || []) as PlatformAiUsageLogItem[]);
      return params;
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 AI 调用统计失败') });
      return null;
    } finally {
      setLoading(false);
    }
  };

  const loadBreakdownData = async (paramsOverride?: Record<string, unknown> | null) => {
    const params = paramsOverride || buildParams();
    setBreakdownLoading(true);
    try {
      const breakdownResp = await platformApi.getGlobalAiUsageBreakdown(params);
      const breakdownData = pickApiData<PlatformAiUsageBreakdown>(breakdownResp);
      setBreakdown(breakdownData || null);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 AI 调用分布失败') });
    } finally {
      setBreakdownLoading(false);
    }
  };

  const loadData = async () => {
    const params = await loadSummaryData();
    if (params) {
      void loadBreakdownData(params);
    }
  };

  useEffect(() => {
    if (rangePreset === 'custom' && (!customFrom || !customTo)) {
      return;
    }
    setBreakdown(null);
    loadData();
  }, [rangePreset, customFrom, customTo, capabilityFilter, modelIdFilter, sourceIdFilter, successFilter]);

  const handleRangePresetChange = (value: RangePreset) => {
    if (value === 'custom' && (!customFrom || !customTo)) {
      setCustomFrom(formatDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
      setCustomTo(formatDateInput(new Date()));
    }
    setRangePreset(value);
  };

  return (
    <div className="platform-page ai-hub-page">
      <div className="platform-page-head">
        <div>
          <h1>AI 调用统计</h1>
          <p>查看平台维度的调用量、积分消耗、RMB 成本、来源分布和最近调用日志。</p>
        </div>
      </div>

      <AiUsageInsightsPanel
        title="平台 AI 调用统计"
        description="统一按能力、模型、来源和用户查看调用与扣费口径，支持自定义时间窗口。"
        summary={summary}
        breakdown={breakdown}
        logs={logs}
        loading={loading}
        breakdownLoading={breakdownLoading}
        message={message}
        rangePreset={rangePreset}
        onRangePresetChange={handleRangePresetChange}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
        capabilityFilter={capabilityFilter}
        onCapabilityFilterChange={setCapabilityFilter}
        modelIdFilter={modelIdFilter}
        onModelIdFilterChange={setModelIdFilter}
        sourceIdFilter={sourceIdFilter}
        onSourceIdFilterChange={setSourceIdFilter}
        successFilter={successFilter}
        onSuccessFilterChange={setSuccessFilter}
        modelOptions={modelOptions}
        sourceOptions={sourceOptions}
        onRefresh={loadData}
        showAppColumn
        showSourceColumn
      />
    </div>
  );
}
