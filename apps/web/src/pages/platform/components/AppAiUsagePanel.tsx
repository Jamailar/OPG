import { useEffect, useMemo, useState } from 'react';
import AiUsageInsightsPanel from '@/pages/platform/components/AiUsageInsightsPanel';
import {
  PlatformAppAiUsageBreakdown,
  PlatformAppAiModelRouteItem,
  PlatformAppAiUsageLogsResponse,
  PlatformAppAiUsageSummary,
  PlatformAiSourceItem,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type CapabilityFilter = 'ALL' | 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
type SuccessFilter = 'ALL' | 'SUCCESS' | 'FAILED';
type RangePreset = '7' | '30' | '90' | '180' | '365' | 'custom';

type Props = {
  appId: string;
  aiSources: PlatformAiSourceItem[];
  modelRoutes: PlatformAppAiModelRouteItem[];
};

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

export default function AppAiUsagePanel({ appId, aiSources, modelRoutes }: Props) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [summary, setSummary] = useState<PlatformAppAiUsageSummary | null>(null);
  const [breakdown, setBreakdown] = useState<PlatformAppAiUsageBreakdown | null>(null);
  const [logs, setLogs] = useState<PlatformAppAiUsageLogsResponse['items']>([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);

  const [rangePreset, setRangePreset] = useState<RangePreset>('30');
  const [customFrom, setCustomFrom] = useState(() => formatDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [customTo, setCustomTo] = useState(() => formatDateInput(new Date()));
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>('ALL');
  const [modelIdFilter, setModelIdFilter] = useState('');
  const [sourceIdFilter, setSourceIdFilter] = useState('');
  const [successFilter, setSuccessFilter] = useState<SuccessFilter>('ALL');

  const modelOptions = useMemo(
    () => modelRoutes
      .filter((item) => item.model.is_active)
      .map((item) => ({ value: item.model_id, label: `${item.model.display_name || item.model.model_key} / ${item.model.model_key}` })),
    [modelRoutes],
  );

  const sourceOptions = useMemo(
    () => aiSources.map((item) => ({ id: item.id, name: item.name, provider_type: item.provider_type })),
    [aiSources],
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
      const [summaryResp, logsResp] = await Promise.all([
        platformApi.getAppAiUsageSummary(appId, params),
        platformApi.listAppAiUsageLogs(appId, { ...params, page: 1, page_size: 20 }),
      ]);
      const summaryData = pickApiData<PlatformAppAiUsageSummary>(summaryResp);
      const logsData = pickApiData<PlatformAppAiUsageLogsResponse>(logsResp);
      setSummary(summaryData || null);
      setLogs(logsData?.items || []);
      return params;
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载应用 AI 调用统计失败') });
      return null;
    } finally {
      setLoading(false);
    }
  };

  const loadBreakdownData = async (paramsOverride?: Record<string, unknown> | null) => {
    const params = paramsOverride || buildParams();
    setBreakdownLoading(true);
    try {
      const response = await platformApi.getAppAiUsageBreakdown(appId, params);
      const data = pickApiData<PlatformAppAiUsageBreakdown>(response);
      setBreakdown(data || null);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载应用 AI 调用分布失败') });
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
  }, [appId, rangePreset, customFrom, customTo, capabilityFilter, modelIdFilter, sourceIdFilter, successFilter]);

  const handleRangePresetChange = (value: RangePreset) => {
    if (value === 'custom' && (!customFrom || !customTo)) {
      setCustomFrom(formatDateInput(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
      setCustomTo(formatDateInput(new Date()));
    }
    setRangePreset(value);
  };

  return (
    <div className="platform-page">
      <AiUsageInsightsPanel
        title="应用 AI 调用统计"
        description="按应用维度查看请求量、积分消耗、RMB 成本、每日趋势和最近调用日志。"
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
        showSourceColumn
      />
    </div>
  );
}
