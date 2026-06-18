import { useEffect, useMemo, useState } from 'react';
import {
  PlatformAiSourceItem,
  PlatformAppAiModelRouteItem,
  PlatformObservabilityAuditEvent,
  PlatformObservabilityEventsResponse,
  PlatformObservabilityRequestEvent,
  PlatformTaskDetail,
  PlatformTaskItem,
  PlatformTasksResponse,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';
import AppAiUsagePanel from './AppAiUsagePanel';

type LogMode = 'requests' | 'audit' | 'ai' | 'tasks';

type Props = {
  appId: string;
  aiSources: PlatformAiSourceItem[];
  modelRoutes: PlatformAppAiModelRouteItem[];
};

const TASK_STATUS_OPTIONS = ['', 'queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled', 'expired'];

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function requestStatusClass(status?: number | null) {
  if (!status) return 'info';
  if (status >= 500) return 'error';
  if (status >= 400) return 'warning';
  return 'success';
}

function taskStatusClass(status?: string | null) {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'expired') return 'error';
  if (status === 'running' || status === 'retrying') return 'info';
  if (status === 'cancelled') return 'muted';
  return 'warning';
}

function progressValue(task: PlatformTaskItem) {
  const parsed = Number(task.progress ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

export default function AppLogsPanel({ appId, aiSources, modelRoutes }: Props) {
  const [mode, setMode] = useState<LogMode>('requests');
  const [requestId, setRequestId] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [requestEvents, setRequestEvents] = useState<PlatformObservabilityRequestEvent[]>([]);
  const [auditEvents, setAuditEvents] = useState<PlatformObservabilityAuditEvent[]>([]);
  const [tasks, setTasks] = useState<PlatformTaskItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [taskDetail, setTaskDetail] = useState<PlatformTaskDetail | null>(null);

  const eventQuery = useMemo(
    () => ({
      request_id: requestId.trim() || undefined,
      module: moduleFilter.trim() || undefined,
      days: '7',
      page_size: 80,
    }),
    [moduleFilter, requestId],
  );

  const taskQuery = useMemo(
    () => ({
      request_id: requestId.trim() || undefined,
      module: moduleFilter.trim() || undefined,
      status: taskStatus || undefined,
      days: 7,
      page_size: 80,
    }),
    [moduleFilter, requestId, taskStatus],
  );

  const loadTaskDetail = async (taskId: string) => {
    if (!taskId) return;
    setDetailLoading(true);
    try {
      const payload = pickApiData<PlatformTaskDetail>(await platformApi.getAppTask(appId, taskId));
      setTaskDetail(payload || null);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载任务详情失败'));
    } finally {
      setDetailLoading(false);
    }
  };

  const loadData = async () => {
    if (mode === 'ai') return;
    setLoading(true);
    setMessage('');
    try {
      if (mode === 'requests') {
        const payload = pickApiData<PlatformObservabilityEventsResponse<PlatformObservabilityRequestEvent>>(
          await platformApi.listAppRequestEvents(appId, eventQuery),
        );
        setRequestEvents(payload?.items || []);
      } else if (mode === 'audit') {
        const payload = pickApiData<PlatformObservabilityEventsResponse<PlatformObservabilityAuditEvent>>(
          await platformApi.listAppAuditEvents(appId, eventQuery),
        );
        setAuditEvents(payload?.items || []);
      } else {
        const payload = pickApiData<PlatformTasksResponse>(await platformApi.listAppTasks(appId, taskQuery));
        const nextTasks = payload?.items || [];
        setTasks(nextTasks);
        const nextSelected = selectedTaskId && nextTasks.some((item) => item.id === selectedTaskId)
          ? selectedTaskId
          : nextTasks[0]?.id || '';
        setSelectedTaskId(nextSelected);
        if (nextSelected) {
          await loadTaskDetail(nextSelected);
        } else {
          setTaskDetail(null);
        }
      }
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载日志失败'));
    } finally {
      setLoading(false);
    }
  };

  const selectTask = (taskId: string) => {
    setSelectedTaskId(taskId);
    void loadTaskDetail(taskId);
  };

  useEffect(() => {
    void loadData();
  }, [appId, mode, taskStatus]);

  const selectedTask = taskDetail?.task || tasks.find((item) => item.id === selectedTaskId) || null;

  return (
    <div className="app-logs-panel">
      <section className="card">
        <div className="ai-hub-filter-row">
          <div className="segmented-control">
            <button className={mode === 'requests' ? 'active' : ''} onClick={() => setMode('requests')} type="button">请求</button>
            <button className={mode === 'audit' ? 'active' : ''} onClick={() => setMode('audit')} type="button">审计</button>
            <button className={mode === 'ai' ? 'active' : ''} onClick={() => setMode('ai')} type="button">AI</button>
            <button className={mode === 'tasks' ? 'active' : ''} onClick={() => setMode('tasks')} type="button">任务</button>
          </div>
          {mode === 'tasks' && (
            <select className="platform-filter-input" value={taskStatus} onChange={(event) => setTaskStatus(event.target.value)}>
              {TASK_STATUS_OPTIONS.map((item) => <option key={item || 'all'} value={item}>{item || 'all'}</option>)}
            </select>
          )}
          {mode !== 'ai' && (
            <>
              <input
                className="platform-filter-input"
                value={requestId}
                onChange={(event) => setRequestId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadData();
                }}
                placeholder="request id"
              />
              <input
                className="platform-filter-input"
                value={moduleFilter}
                onChange={(event) => setModuleFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadData();
                }}
                placeholder="module"
              />
              <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading} type="button">
                {loading ? '查询中...' : '查询'}
              </button>
            </>
          )}
        </div>
        {message && <div className="alert alert-error">{message}</div>}
      </section>

      {mode === 'ai' && (
        <div className="app-logs-ai-panel">
          <AppAiUsagePanel appId={appId} aiSources={aiSources} modelRoutes={modelRoutes} />
        </div>
      )}

      {mode === 'requests' && (
        <section className="card">
          <div className="platform-table-wrap">
            <table className="platform-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模块</th>
                  <th>状态</th>
                  <th>路径</th>
                  <th>耗时</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {requestEvents.map((item) => (
                  <tr key={item.id}>
                    <td>{formatTime(item.created_at)}</td>
                    <td>{item.module}</td>
                    <td><span className={`status-tag ${requestStatusClass(item.status_code)}`}>{item.status_code || (item.success === false ? 'ERR' : 'OK')}</span></td>
                    <td>{item.request_path || item.operation || '-'}</td>
                    <td>{item.latency_ms === null || item.latency_ms === undefined ? '-' : `${item.latency_ms} ms`}</td>
                    <td><code>{item.request_id || '-'}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!requestEvents.length && <div className="loading">暂无请求事件</div>}
          </div>
        </section>
      )}

      {mode === 'audit' && (
        <section className="card">
          <div className="platform-table-wrap">
            <table className="platform-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模块</th>
                  <th>动作</th>
                  <th>资源</th>
                  <th>Actor</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((item) => (
                  <tr key={item.id}>
                    <td>{formatTime(item.created_at)}</td>
                    <td>{item.module}</td>
                    <td>{item.action}</td>
                    <td>{item.resource_type}{item.resource_id ? ` / ${item.resource_id}` : ''}</td>
                    <td><code>{item.actor_user_id || '-'}</code></td>
                    <td><code>{item.request_id || '-'}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!auditEvents.length && <div className="loading">暂无审计事件</div>}
          </div>
        </section>
      )}

      {mode === 'tasks' && (
        <>
          <section className="card">
            <div className="platform-api-table-wrap">
              <table className="table table-sticky">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>任务</th>
                    <th>进度</th>
                    <th>队列</th>
                    <th>Worker</th>
                    <th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((item) => (
                    <tr key={item.id} className={selectedTaskId === item.id ? 'table-row-selected' : ''} onClick={() => selectTask(item.id)}>
                      <td><span className={`status-tag ${taskStatusClass(item.status)}`}>{item.status}</span></td>
                      <td><strong>{item.module}</strong><div className="tenant-analytics-table-sub">{item.action}</div></td>
                      <td>{progressValue(item)}%</td>
                      <td>{item.queue_name || '-'}</td>
                      <td><code>{item.worker_id || '-'}</code></td>
                      <td>{formatTime(item.updated_at || item.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!tasks.length && <div className="loading">暂无任务</div>}
            </div>
          </section>

          {selectedTask && (
            <section className="card">
              <div className="platform-section-head">
                <div>
                  <h3>{selectedTask.module} / {selectedTask.action}</h3>
                  <p><code>{selectedTask.id}</code></p>
                </div>
                <span className={`status-tag ${taskStatusClass(selectedTask.status)}`}>{selectedTask.status}</span>
              </div>
              {detailLoading ? <div className="loading">加载中...</div> : (
                <div className="grid">
                  <div className="user-info-item"><label>Request</label><div><code>{selectedTask.request_id || '-'}</code></div></div>
                  <div className="user-info-item"><label>Source</label><div>{selectedTask.source_type || '-'}{selectedTask.source_id ? ` / ${selectedTask.source_id}` : ''}</div></div>
                  <div className="user-info-item"><label>Created</label><div>{formatTime(selectedTask.created_at)}</div></div>
                  <div className="user-info-item"><label>Error</label><div>{selectedTask.error_code || selectedTask.error_message || '-'}</div></div>
                </div>
              )}

              <div className="platform-api-table-wrap">
                <table className="table">
                  <thead><tr><th>Seq</th><th>时间</th><th>类型</th><th>阶段</th></tr></thead>
                  <tbody>
                    {(taskDetail?.events || []).map((item) => (
                      <tr key={item.id}><td>{item.seq}</td><td>{formatTime(item.created_at)}</td><td>{item.event_type}</td><td>{item.stage || '-'}</td></tr>
                    ))}
                  </tbody>
                </table>
                {taskDetail && taskDetail.events.length === 0 && <div className="loading">暂无事件</div>}
              </div>

              <div className="platform-api-table-wrap">
                <table className="table">
                  <thead><tr><th>Seq</th><th>流</th><th>日志</th><th>时间</th></tr></thead>
                  <tbody>
                    {(taskDetail?.logs || []).map((item) => (
                      <tr key={item.id}><td>{item.seq}</td><td>{item.stream}</td><td><code>{item.message_redacted}</code></td><td>{formatTime(item.created_at)}</td></tr>
                    ))}
                  </tbody>
                </table>
                {taskDetail && taskDetail.logs.length === 0 && <div className="loading">暂无日志</div>}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
