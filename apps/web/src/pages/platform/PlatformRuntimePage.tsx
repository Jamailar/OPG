import { useEffect, useMemo, useState } from 'react';
import {
  PlatformAppItem,
  PlatformAppRuntimeOverview,
  PlatformRuntimeOverview,
  PlatformRuntimeTemplate,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusClass(status?: string | null) {
  if (status === 'active' || status === 'succeeded') return 'success';
  if (status === 'warning' || status === 'retrying') return 'warning';
  if (status === 'unhealthy' || status === 'failed') return 'error';
  if (status === 'running') return 'info';
  return 'muted';
}

const STATUS_LABELS: Record<string, string> = {
  active: '活跃',
  succeeded: '成功',
  warning: '告警',
  retrying: '重试中',
  unhealthy: '异常',
  failed: '失败',
  running: '运行中',
};

function formatStatus(status?: string | null) {
  const key = String(status || '').toLowerCase();
  return STATUS_LABELS[key] || status || '-';
}

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function createCount(template: PlatformRuntimeTemplate) {
  const creates = template.creates || {};
  return Object.values(creates).reduce((sum, value) => sum + toNumber(value), 0);
}

export default function PlatformRuntimePage() {
  const [overview, setOverview] = useState<PlatformRuntimeOverview | null>(null);
  const [templates, setTemplates] = useState<PlatformRuntimeTemplate[]>([]);
  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [appOverview, setAppOverview] = useState<PlatformAppRuntimeOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [appLoading, setAppLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [message, setMessage] = useState('');

  const selectedApp = useMemo(
    () => apps.find((item) => item.id === selectedAppId) || null,
    [apps, selectedAppId],
  );

  const loadGlobal = async () => {
    setLoading(true);
    setMessage('');
    try {
      const [overviewPayload, templatesPayload, appsPayload] = await Promise.all([
        platformApi.getPlatformRuntimeOverview({ limit: 40 }),
        platformApi.listRuntimeTemplates(),
        platformApi.listApps(true),
      ]);
      const nextOverview = pickApiData<PlatformRuntimeOverview>(overviewPayload);
      const nextTemplates = pickApiData<{ items: PlatformRuntimeTemplate[] }>(templatesPayload);
      const nextApps = pickApiData<{ items: PlatformAppItem[] }>(appsPayload);
      const nextAppItems = nextApps?.items || [];
      setOverview(nextOverview || null);
      setTemplates(nextTemplates?.items || []);
      setApps(nextAppItems);
      setSelectedAppId((current) => (current && nextAppItems.some((item) => item.id === current) ? current : nextAppItems[0]?.id || ''));
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载运行时失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadAppOverview = async (appId: string) => {
    if (!appId) {
      setAppOverview(null);
      return;
    }
    setAppLoading(true);
    try {
      const payload = pickApiData<PlatformAppRuntimeOverview>(await platformApi.getAppRuntimeOverview(appId, { limit: 50 }));
      setAppOverview(payload || null);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载应用运行时失败'));
    } finally {
      setAppLoading(false);
    }
  };

  const queueGlobalRefresh = async () => {
    setActionLoading('refresh-all');
    setMessage('');
    try {
      const payload = pickApiData(await platformApi.refreshPlatformRuntime()) as any;
      setMessage(`已入队 ${payload?.task?.id || ''}`.trim());
      await loadGlobal();
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '刷新入队失败'));
    } finally {
      setActionLoading('');
    }
  };

  const queueAppRefresh = async () => {
    if (!selectedAppId) return;
    setActionLoading('refresh-app');
    setMessage('');
    try {
      const payload = pickApiData(await platformApi.refreshAppRuntime(selectedAppId)) as any;
      setMessage(`已入队 ${payload?.task?.id || ''}`.trim());
      await loadAppOverview(selectedAppId);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '应用刷新入队失败'));
    } finally {
      setActionLoading('');
    }
  };

  const applyTemplate = async (templateKey: string) => {
    if (!selectedAppId) return;
    setActionLoading(templateKey);
    setMessage('');
    try {
      const payload = pickApiData(await platformApi.applyAppRuntimeTemplate(selectedAppId, templateKey)) as any;
      setMessage(`已入队 ${payload?.task?.id || ''}`.trim());
      await loadAppOverview(selectedAppId);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '模板入队失败'));
    } finally {
      setActionLoading('');
    }
  };

  useEffect(() => {
    void loadGlobal();
  }, []);

  useEffect(() => {
    void loadAppOverview(selectedAppId);
  }, [selectedAppId]);

  const appStats = overview?.apps || {};
  const taskRuntime = overview?.task_runtime;

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>运行时</h1>
        </div>
        <div className="btn-group">
          <span className={`status-tag ${taskRuntime?.queue?.backend === 'bullmq' && taskRuntime.queue.available ? 'success' : 'warning'}`}>
            {taskRuntime?.queue?.backend || 'db'}
          </span>
          <button className="btn btn-secondary btn-sm" type="button" onClick={queueGlobalRefresh} disabled={Boolean(actionLoading)}>
            {actionLoading === 'refresh-all' ? '入队中...' : '刷新注册表'}
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={loadGlobal} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>
      </div>

      {message && <div className="alert alert-info">{message}</div>}

      <div className="platform-stats-grid compact">
        <div className="platform-stat-card">
          <span>应用</span>
          <strong>{toNumber(appStats.total)}</strong>
        </div>
        <div className="platform-stat-card">
          <span>活跃</span>
          <strong>{toNumber(appStats.active)}</strong>
        </div>
        <div className="platform-stat-card">
          <span>模板</span>
          <strong>{overview?.templates?.available || templates.length}</strong>
        </div>
        <div className="platform-stat-card">
          <span>处理器</span>
          <strong>{(taskRuntime as any)?.registered_handlers?.length || 0}</strong>
        </div>
      </div>

      <div className="platform-grid-two">
        <section className="card">
          <div className="platform-section-head">
            <h3>模块状态</h3>
          </div>
          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.modules?.by_status || []).map((item) => (
                  <tr key={item.status}>
                    <td><span className={`status-tag ${statusClass(item.status)}`}>{formatStatus(item.status)}</span></td>
                    <td>{toNumber(item.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!overview?.modules?.by_status?.length && <div className="loading">暂无模块</div>}
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head">
            <h3>分类概览</h3>
          </div>
          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>分类</th>
                  <th>模块</th>
                  <th>质量</th>
                  <th>失败</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.modules?.by_category || []).map((item) => (
                  <tr key={item.category}>
                    <td>{item.category}</td>
                    <td>{toNumber(item.module_count)}</td>
                    <td>{Math.round(toNumber(item.avg_quality_score))}</td>
                    <td>{toNumber(item.failures_24h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!overview?.modules?.by_category?.length && <div className="loading">暂无分类</div>}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="platform-section-head">
          <div className="ai-hub-filter-row">
            <select
              className="platform-filter-input"
              value={selectedAppId}
              onChange={(event) => setSelectedAppId(event.target.value)}
              aria-label="应用"
            >
              {apps.map((item) => (
                <option key={item.id} value={item.id}>{item.name || item.slug}</option>
              ))}
            </select>
            <button className="btn btn-secondary btn-sm" type="button" onClick={queueAppRefresh} disabled={!selectedAppId || Boolean(actionLoading)}>
              {actionLoading === 'refresh-app' ? '入队中...' : '刷新应用'}
            </button>
          </div>
          {selectedApp && <span className="status-tag info">{selectedApp.slug}</span>}
        </div>

        <div className="platform-api-table-wrap">
          <table className="table table-sticky">
            <thead>
              <tr>
                <th>模块</th>
                <th>分类</th>
                <th>状态</th>
                <th>资源</th>
                <th>24h 运行</th>
                <th>24h 失败</th>
                <th>质量</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {(appOverview?.modules || []).map((item) => (
                <tr key={item.module_key}>
                  <td>
                    <strong>{item.display_name}</strong>
                    <div className="tenant-analytics-table-sub">{item.module_key}</div>
                  </td>
                  <td>{item.category}</td>
                  <td><span className={`status-tag ${statusClass(item.status)}`}>{formatStatus(item.status)}</span></td>
                  <td>{toNumber(item.resource_count)}</td>
                  <td>{toNumber(item.run_count_24h)}</td>
                  <td>{toNumber(item.failure_count_24h)}</td>
                  <td>{toNumber(item.quality_score)}</td>
                  <td>{formatTime(item.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {appLoading && <div className="loading">加载中...</div>}
          {!appLoading && !appOverview?.modules?.length && <div className="loading">暂无模块</div>}
        </div>
      </section>

      <section className="card">
        <div className="platform-section-head">
          <h3>运行模板</h3>
        </div>
        <div className="platform-api-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>模板</th>
                <th>分类</th>
                <th>模块</th>
                <th>创建</th>
                <th>版本</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.key}>
                  <td>
                    <strong>{template.name}</strong>
                    <div className="tenant-analytics-table-sub">{template.key}</div>
                  </td>
                  <td>{template.category}</td>
                  <td>{template.modules.length}</td>
                  <td>{createCount(template)}</td>
                  <td>{template.version}</td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => applyTemplate(template.key)}
                      disabled={!selectedAppId || Boolean(actionLoading)}
                    >
                      {actionLoading === template.key ? '入队中...' : '应用'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!templates.length && <div className="loading">暂无模板</div>}
        </div>
      </section>
    </div>
  );
}
