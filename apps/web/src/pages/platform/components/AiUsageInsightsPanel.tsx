import {
  PlatformAiUsageBreakdown,
  PlatformAiSourceItem,
  PlatformAiUsageLogItem,
  PlatformAiUsageSummary,
} from '@/lib/api';
import TrendMultiLineChart from '@/pages/platform/components/TrendMultiLineChart';

type CapabilityValue = 'ALL' | 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
type SuccessValue = 'ALL' | 'SUCCESS' | 'FAILED';
type RangePresetValue = '7' | '30' | '90' | '180' | '365' | 'custom';

type ModelOption = {
  value: string;
  label: string;
  capability?: string;
};

type SourceOption = Pick<PlatformAiSourceItem, 'id' | 'name' | 'provider_type'>;

type Props = {
  title: string;
  description: string;
  summary: PlatformAiUsageSummary | null;
  breakdown: PlatformAiUsageBreakdown | null;
  logs: PlatformAiUsageLogItem[];
  loading: boolean;
  breakdownLoading?: boolean;
  message?: { type: 'success' | 'error'; text: string } | null;
  rangePreset: RangePresetValue;
  onRangePresetChange: (value: RangePresetValue) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  capabilityFilter: CapabilityValue;
  onCapabilityFilterChange: (value: CapabilityValue) => void;
  modelIdFilter: string;
  onModelIdFilterChange: (value: string) => void;
  sourceIdFilter: string;
  onSourceIdFilterChange: (value: string) => void;
  successFilter: SuccessValue;
  onSuccessFilterChange: (value: SuccessValue) => void;
  modelOptions: ModelOption[];
  sourceOptions: SourceOption[];
  onRefresh: () => void;
  showAppColumn?: boolean;
  showSourceColumn?: boolean;
};

const CAPABILITY_OPTIONS: Array<{ value: CapabilityValue; label: string }> = [
  { value: 'ALL', label: '全部能力' },
  { value: 'chat', label: '语言模型' },
  { value: 'embedding', label: '嵌入' },
  { value: 'tts', label: '音频生成' },
  { value: 'stt', label: '转录' },
  { value: 'image', label: '图片生成' },
  { value: 'video', label: '视频生成' },
];

const SUCCESS_OPTIONS: Array<{ value: SuccessValue; label: string }> = [
  { value: 'ALL', label: '全部结果' },
  { value: 'SUCCESS', label: '成功' },
  { value: 'FAILED', label: '失败' },
];

const CAPABILITY_LABELS: Record<Exclude<CapabilityValue, 'ALL'>, string> = {
  chat: '语言模型',
  embedding: '嵌入',
  tts: '音频生成',
  stt: '转录',
  image: '图片生成',
  video: '视频生成',
};

function formatDateTime(input?: string | null) {
  if (!input) return '-';
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString();
}

function formatCount(value?: number | null) {
  return Number(value || 0).toLocaleString();
}

function formatRmb(value?: number | null) {
  return `¥${Number(value || 0).toFixed(4)}`;
}

function formatPoints(value?: number | null) {
  return `${Number(value || 0).toFixed(2)} 积分`;
}

function formatPercent(value?: number | null) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatCapability(value?: string | null) {
  if (!value) return '-';
  return CAPABILITY_LABELS[value as Exclude<CapabilityValue, 'ALL'>] || value;
}

function formatLatency(value?: number | null) {
  return `${Math.round(Number(value || 0))} ms`;
}

function formatBilledUnits(value?: number | null, label?: string | null) {
  const safeValue = Number(value || 0);
  if (label === 'minute') return `${safeValue.toFixed(2)} 分钟`;
  if (label === 'second') return `${safeValue.toFixed(2)} 秒`;
  if (label === 'character') return `${Math.round(safeValue).toLocaleString()} 字符`;
  if (label === 'image') return `${safeValue.toFixed(0)} 张`;
  if (label === 'call') return `${safeValue.toFixed(0)} 次`;
  if (label === 'output_token') return `${Math.round(safeValue).toLocaleString()} 输出 token`;
  return `${Math.round(safeValue).toLocaleString()} token`;
}

function formatTokenBreakdown(log: PlatformAiUsageLogItem) {
  const promptTokens = Number(log.prompt_tokens || 0);
  const completionTokens = Number(log.completion_tokens || 0);
  const totalTokens = Number(log.total_tokens || 0);
  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) {
    return '未返回 token';
  }
  return `输入 ${formatCount(promptTokens)} / 输出 ${formatCount(completionTokens)} / 总 ${formatCount(totalTokens)}`;
}

function formatRange(summary: PlatformAiUsageSummary | null, preset: RangePresetValue) {
  if (!summary?.range?.from || !summary?.range?.to) {
    return preset === 'custom' ? '自定义时间范围' : `最近 ${preset} 天`;
  }
  return `${formatDateTime(summary.range.from)} - ${formatDateTime(summary.range.to)}`;
}

function getStatusNote(summary: PlatformAiUsageSummary | null, logs: PlatformAiUsageLogItem[]) {
  const requestsTotal = Number(summary?.overview?.requests_total || 0);
  const totalPoints = Number(summary?.overview?.total_points_cost || 0);
  const estimatedCount = Number(summary?.overview?.estimated_points_requests || 0);
  if (requestsTotal <= 0 && logs.length <= 0) {
    return '无 AI 调用';
  }
  if (estimatedCount > 0) {
    return '积分未完成回填';
  }
  if (requestsTotal > 0 && totalPoints <= 0) {
    return '只有日志无积分';
  }
  return '数据已对齐';
}

function EmptyNote({ message }: { message: string }) {
  return <div className="ai-hub-empty">{message}</div>;
}

export default function AiUsageInsightsPanel({
  title,
  description,
  summary,
  breakdown,
  logs,
  loading,
  breakdownLoading = false,
  message,
  rangePreset,
  onRangePresetChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  capabilityFilter,
  onCapabilityFilterChange,
  modelIdFilter,
  onModelIdFilterChange,
  sourceIdFilter,
  onSourceIdFilterChange,
  successFilter,
  onSuccessFilterChange,
  modelOptions,
  sourceOptions,
  onRefresh,
  showAppColumn = false,
  showSourceColumn = true,
}: Props) {
  const overview = summary?.overview || {
    requests_total: 0,
    success_total: 0,
    error_total: 0,
    total_tokens: 0,
    total_billed_units: 0,
    total_cost_rmb: 0,
    total_points_cost: 0,
    active_users_total: 0,
    avg_latency_ms: 0,
    estimated_points_requests: 0,
  };

  const successRate = overview.requests_total > 0 ? (overview.success_total / overview.requests_total) * 100 : 0;
  const errorRate = overview.requests_total > 0 ? (overview.error_total / overview.requests_total) * 100 : 0;
  const statusNote = getStatusNote(summary, logs);
  const recentFailedLogs = logs.filter((log) => !log.success).slice(0, 5);

  return (
    <section className="card ai-usage-shell">
      <div className="platform-section-head ai-usage-header">
        <div>
          <h3>{title}</h3>
          <p className="ai-hub-note">{description}</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {message ? <div className={`alert alert-${message.type}`}>{message.text}</div> : null}

      <div className="ai-usage-filter-grid">
        <label>
          <span>时间范围</span>
          <select value={rangePreset} onChange={(event) => onRangePresetChange(event.target.value as RangePresetValue)}>
            <option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option>
            <option value="90">最近 90 天</option>
            <option value="180">最近 180 天</option>
            <option value="365">最近 365 天</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <label>
          <span>能力类型</span>
          <select value={capabilityFilter} onChange={(event) => onCapabilityFilterChange(event.target.value as CapabilityValue)}>
            {CAPABILITY_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>模型</span>
          <select value={modelIdFilter} onChange={(event) => onModelIdFilterChange(event.target.value)}>
            <option value="">全部模型</option>
            {modelOptions.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>来源供应商</span>
          <select value={sourceIdFilter} onChange={(event) => onSourceIdFilterChange(event.target.value)}>
            <option value="">全部来源</option>
            {sourceOptions.map((item) => (
              <option key={item.id} value={item.id}>{item.name} / {item.provider_type}</option>
            ))}
          </select>
        </label>
        <label>
          <span>结果</span>
          <select value={successFilter} onChange={(event) => onSuccessFilterChange(event.target.value as SuccessValue)}>
            {SUCCESS_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        {rangePreset === 'custom' ? (
          <>
            <label>
              <span>开始日期</span>
              <input type="date" value={customFrom} onChange={(event) => onCustomFromChange(event.target.value)} />
            </label>
            <label>
              <span>结束日期</span>
              <input type="date" value={customTo} onChange={(event) => onCustomToChange(event.target.value)} />
            </label>
          </>
        ) : null}
      </div>

      <div className="ai-hub-usage-range">
        统计窗口：{formatRange(summary, rangePreset)}
        <span className="ai-usage-status-note">{statusNote}</span>
      </div>

      <div className="ai-hub-usage-overview-grid ai-usage-overview-grid-wide">
        <article className="platform-stat-card"><span>总请求数</span><strong>{formatCount(overview.requests_total)}</strong></article>
        <article className="platform-stat-card"><span>成功率</span><strong>{formatPercent(successRate)}</strong></article>
        <article className="platform-stat-card"><span>失败请求</span><strong>{formatCount(overview.error_total)}</strong></article>
        <article className="platform-stat-card"><span>失败占比</span><strong>{formatPercent(errorRate)}</strong></article>
        <article className="platform-stat-card"><span>积分消耗</span><strong>{formatPoints(overview.total_points_cost)}</strong></article>
        <article className="platform-stat-card"><span>RMB 成本</span><strong>{formatRmb(overview.total_cost_rmb)}</strong></article>
        <article className="platform-stat-card"><span>总 Token</span><strong>{formatCount(overview.total_tokens)}</strong></article>
        <article className="platform-stat-card"><span>总计费单位</span><strong>{formatCount(overview.total_billed_units)}</strong></article>
        <article className="platform-stat-card"><span>活跃调用用户</span><strong>{formatCount(overview.active_users_total)}</strong></article>
        <article className="platform-stat-card"><span>平均延迟</span><strong>{formatLatency(overview.avg_latency_ms)}</strong></article>
      </div>

      {(overview.error_total > 0 || successFilter === 'FAILED') && (
        <section className="ai-hub-usage-panel">
          <div className="platform-section-head">
            <div>
              <h4>失败诊断</h4>
              <p className="ai-hub-note">失败请求会保留在统计里，最近失败项会展示错误原因，便于直接排查。</p>
            </div>
            <div className="ai-usage-failure-actions">
              {successFilter !== 'FAILED' ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onSuccessFilterChange('FAILED')}>
                  只看失败
                </button>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onSuccessFilterChange('ALL')}>
                  恢复全部
                </button>
              )}
            </div>
          </div>

          <div className="ai-usage-failure-summary">
            <article className="ai-usage-failure-kpi">
              <span>失败请求数</span>
              <strong>{formatCount(overview.error_total)}</strong>
              <em>当前统计窗口内累计失败</em>
            </article>
            <article className="ai-usage-failure-kpi">
              <span>失败占比</span>
              <strong>{formatPercent(errorRate)}</strong>
              <em>总请求中的失败比例</em>
            </article>
            <article className="ai-usage-failure-kpi">
              <span>当前筛选</span>
              <strong>{successFilter === 'FAILED' ? '仅失败' : '全部结果'}</strong>
              <em>可切换到失败筛选查看完整失败日志</em>
            </article>
          </div>

          {recentFailedLogs.length ? (
            <div className="ai-usage-failure-list">
              {recentFailedLogs.map((log) => (
                <article key={log.id} className="ai-usage-failure-item">
                  <div className="ai-usage-failure-item-head">
                    <div>
                      <strong>{log.display_name || log.model_key}</strong>
                      <div className="ai-hub-usage-subline">
                        {formatCapability(log.capability)}
                        {showAppColumn ? ` / ${log.app_slug || '-'}` : ''}
                        {showSourceColumn ? ` / ${log.source_name || '-'}` : ''}
                      </div>
                    </div>
                    <span className="status-tag error">ERROR</span>
                  </div>
                  <div className="ai-usage-failure-item-meta">
                    <span>时间 {formatDateTime(log.created_at)}</span>
                    <span>用户 {log.user_display_name || log.user_email || log.user_id || '匿名/系统'}</span>
                    <span>时延 {formatLatency(log.latency_ms)}</span>
                  </div>
                  <div className="ai-usage-failure-item-error">
                    {log.error_message || '未记录错误详情'}
                  </div>
                  <div className="ai-hub-usage-subline">
                    {log.request_path || log.endpoint_path || '未记录请求路径'}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyNote message={successFilter === 'FAILED' ? '当前筛选条件下暂无失败调用' : '最近调用里暂无失败项，可切换结果为失败查看更早记录'} />
          )}
        </section>
      )}

      <div className="ai-hub-usage-detail-grid ai-usage-top-grid">
        <section className="ai-hub-usage-panel">
          <div className="platform-section-head">
            <h4>按日趋势</h4>
            <span className="platform-filter-hint">请求 / 积分 / 成本 / Token</span>
          </div>
          <TrendMultiLineChart
            data={(summary?.daily || []).map((item) => ({
              label: item.day,
              requests_total: Number(item.requests_total || 0),
              total_points_cost: Number(item.total_points_cost || 0),
              total_cost_rmb: Number(item.total_cost_rmb || 0),
              total_tokens: Number(item.total_tokens || 0),
              active_users: Number(item.active_users || 0),
            }))}
            series={[
              { key: 'requests_total', label: '请求数', color: '#C65C34' },
              { key: 'total_points_cost', label: '积分消耗', color: '#2563EB', formatter: formatPoints, strokeWidth: 4 },
              { key: 'total_cost_rmb', label: 'RMB 成本', color: '#4F665D', formatter: formatRmb },
              { key: 'total_tokens', label: 'Token', color: '#8B5CF6' },
            ]}
            emptyText="当前时间范围暂无调用趋势数据"
            tooltipExtras={(datum) => [{ label: '活跃用户', value: formatCount(Number(datum.active_users || 0)) }]}
            className="ai-usage-line-chart-theme"
          />
        </section>

        <section className="ai-hub-usage-panel">
          <div className="platform-section-head">
            <h4>能力分布</h4>
            <span className="platform-filter-hint">按积分消耗排序</span>
          </div>
          <div className="ai-hub-usage-daily ai-usage-ranking-list">
            {(breakdown?.by_capability || []).map((item) => (
              <div key={item.capability} className="ai-hub-usage-daily-row">
                <div className="ai-hub-usage-daily-head">
                  <span>{formatCapability(item.capability)}</span>
                  <strong>{formatPoints(item.total_points_cost)}</strong>
                </div>
                <div className="ai-hub-usage-daily-bar"><div style={{ width: `${overview.total_points_cost > 0 ? Math.max(2, (Number(item.total_points_cost || 0) / overview.total_points_cost) * 100) : 0}%` }} /></div>
                <div className="ai-hub-usage-daily-foot ai-usage-daily-foot-wide">
                  <span>请求 {formatCount(item.requests_total)}</span>
                  <span>成本 {formatRmb(item.total_cost_rmb)}</span>
                  <span>延迟 {formatLatency(item.avg_latency_ms)}</span>
                </div>
              </div>
            ))}
          </div>
          {breakdownLoading ? <EmptyNote message="能力分布加载中..." /> : !breakdown?.by_capability?.length ? <EmptyNote message="当前筛选条件下暂无能力分布" /> : null}
        </section>
      </div>

      <div className="ai-hub-usage-detail-grid">
        <section className="ai-hub-usage-panel">
          <div className="platform-section-head">
            <h4>模型分布</h4>
            <span className="platform-filter-hint">Top {Math.min(breakdown?.by_model?.length || 0, 12)}</span>
          </div>
          <div className="platform-api-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>能力</th>
                  <th>请求</th>
                  <th>积分</th>
                  <th>RMB</th>
                  <th>活跃用户</th>
                  <th>延迟</th>
                </tr>
              </thead>
              <tbody>
                {(breakdown?.by_model || []).slice(0, 12).map((item) => (
                  <tr key={item.model_id}>
                    <td>
                      <strong>{item.display_name || item.model_key}</strong>
                      <div className="ai-hub-usage-subline">{item.model_key}</div>
                    </td>
                    <td>{formatCapability(item.capability)}</td>
                    <td>{formatCount(item.requests_total)}</td>
                    <td>{formatPoints(item.total_points_cost)}</td>
                    <td>{formatRmb(item.total_cost_rmb)}</td>
                    <td>{formatCount(item.active_users_total)}</td>
                    <td>{formatLatency(item.avg_latency_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {breakdownLoading ? <EmptyNote message="模型分布加载中..." /> : !breakdown?.by_model?.length ? <EmptyNote message="当前筛选条件下暂无模型统计" /> : null}
        </section>

        <section className="ai-hub-usage-panel">
          <div className="platform-section-head">
            <h4>来源供应商分布</h4>
            <span className="platform-filter-hint">按积分消耗排序</span>
          </div>
          <div className="platform-api-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>供应商</th>
                  <th>请求</th>
                  <th>积分</th>
                  <th>RMB</th>
                  <th>延迟</th>
                </tr>
              </thead>
              <tbody>
                {(breakdown?.by_source || []).map((item) => (
                  <tr key={item.source_id}>
                    <td>{item.source_name}</td>
                    <td>{item.provider_type}</td>
                    <td>{formatCount(item.requests_total)}</td>
                    <td>{formatPoints(item.total_points_cost)}</td>
                    <td>{formatRmb(item.total_cost_rmb)}</td>
                    <td>{formatLatency(item.avg_latency_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {breakdownLoading ? <EmptyNote message="来源分布加载中..." /> : !breakdown?.by_source?.length ? <EmptyNote message="当前筛选条件下暂无来源分布" /> : null}
        </section>
      </div>

      <section className="ai-hub-usage-panel">
        <div className="platform-section-head">
          <h4>调用用户 Top</h4>
          <span className="platform-filter-hint">按积分消耗排序</span>
        </div>
        <div className="platform-api-table-wrap">
          <table>
            <thead>
              <tr>
                <th>用户</th>
                <th>请求</th>
                <th>积分</th>
                <th>RMB</th>
                <th>最近调用</th>
              </tr>
            </thead>
            <tbody>
              {(breakdown?.top_users || []).map((item) => (
                <tr key={item.user_id}>
                  <td>
                    <strong>{item.user_display_name || item.user_email || item.user_id}</strong>
                    <div className="ai-hub-usage-subline">{item.user_email || item.user_id}</div>
                  </td>
                  <td>{formatCount(item.requests_total)}</td>
                  <td>{formatPoints(item.total_points_cost)}</td>
                  <td>{formatRmb(item.total_cost_rmb)}</td>
                  <td>{formatDateTime(item.last_called_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {breakdownLoading ? <EmptyNote message="用户排名加载中..." /> : !breakdown?.top_users?.length ? <EmptyNote message="当前筛选条件下暂无调用用户排名" /> : null}
      </section>

      <section className="ai-hub-usage-panel">
        <div className="platform-section-head">
          <h4>最近调用日志</h4>
          <span className="platform-filter-hint">{loading ? '加载中...' : `共 ${formatCount(logs.length)} 条`}</span>
        </div>
        <div className="platform-api-table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                {showAppColumn ? <th>应用</th> : null}
                <th>用户</th>
                <th>模型</th>
                {showSourceColumn ? <th>来源</th> : null}
                <th>能力</th>
                <th>计费量</th>
                <th>积分</th>
                <th>RMB</th>
                <th>时延</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{formatDateTime(log.created_at)}</td>
                  {showAppColumn ? <td>{log.app_slug}</td> : null}
                  <td>
                    <strong>{log.user_display_name || log.user_email || log.user_id || '-'}</strong>
                    <div className="ai-hub-usage-subline">{log.user_email || log.user_id || '匿名/系统'}</div>
                  </td>
                  <td>
                    <strong>{log.display_name || log.model_key}</strong>
                    <div className="ai-hub-usage-subline">{log.model_key}</div>
                  </td>
                  {showSourceColumn ? <td>{log.source_name}</td> : null}
                  <td>{formatCapability(log.capability)}</td>
                  <td>
                    {formatBilledUnits(log.billed_units, log.billed_unit_label)}
                    <div className="ai-hub-usage-subline">{formatTokenBreakdown(log)}</div>
                  </td>
                  <td>
                    {formatPoints(log.points_cost)}
                    {log.points_cost_is_estimated ? <div className="ai-hub-usage-subline">估算</div> : null}
                  </td>
                  <td>{formatRmb(log.estimated_cost_rmb)}</td>
                  <td>{formatLatency(log.latency_ms)}</td>
                  <td>
                    <span className={`status-tag ${log.success ? 'success' : 'error'}`}>{log.success ? 'SUCCESS' : 'ERROR'}</span>
                    {!log.success && log.error_message ? <div className="ai-hub-usage-error">{log.error_message}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!logs.length && <EmptyNote message="当前筛选条件下暂无调用日志" />}
      </section>
    </section>
  );
}
