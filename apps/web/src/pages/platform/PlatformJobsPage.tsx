import { useEffect, useMemo, useState } from 'react';
import {
  PlatformTaskDetail,
  PlatformTaskItem,
  PlatformTaskRuntime,
  PlatformTasksResponse,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

const STATUS_OPTIONS = ['', 'queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled', 'expired'];

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function statusClass(status?: string | null) {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'expired') return 'error';
  if (status === 'running' || status === 'retrying') return 'info';
  if (status === 'cancelled') return 'muted';
  return 'warning';
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  retrying: '重试中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  expired: '已过期',
};

function formatStatus(status?: string | null) {
  const key = String(status || '').toLowerCase();
  return STATUS_LABELS[key] || status || '-';
}

function progressValue(task: PlatformTaskItem) {
  const parsed = Number(task.progress ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

export default function PlatformJobsPage() {
  const [runtime, setRuntime] = useState<PlatformTaskRuntime | null>(null);
  const [items, setItems] = useState<PlatformTaskItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<PlatformTaskDetail | null>(null);
  const [status, setStatus] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [requestId, setRequestId] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState('');

  const query = useMemo(
    () => ({
      status: status || undefined,
      module: moduleFilter.trim() || undefined,
      request_id: requestId.trim() || undefined,
      days: 7,
      page_size: 80,
    }),
    [moduleFilter, requestId, status],
  );

  const loadRuntime = async () => {
    const payload = pickApiData<PlatformTaskRuntime>(await platformApi.getPlatformTaskRuntime());
    setRuntime(payload || null);
  };

  const loadTasks = async () => {
    setLoading(true);
    setMessage('');
    try {
      const [taskPayload] = await Promise.all([
        platformApi.listPlatformTasks(query),
        loadRuntime(),
      ]);
      const payload = pickApiData<PlatformTasksResponse>(taskPayload);
      const nextItems = payload?.items || [];
      setItems(nextItems);
      const nextSelectedId = selectedId && nextItems.some((item) => item.id === selectedId)
        ? selectedId
        : nextItems[0]?.id || '';
      setSelectedId(nextSelectedId);
      if (nextSelectedId) {
        await loadDetail(nextSelectedId);
      } else {
        setDetail(null);
      }
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载任务失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (taskId: string) => {
    if (!taskId) return;
    setDetailLoading(true);
    try {
      const payload = pickApiData<PlatformTaskDetail>(await platformApi.getPlatformTask(taskId));
      setDetail(payload || null);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载任务详情失败'));
    } finally {
      setDetailLoading(false);
    }
  };

  const selectTask = (taskId: string) => {
    setSelectedId(taskId);
    void loadDetail(taskId);
  };

  const cancelTask = async (taskId: string) => {
    setMessage('');
    try {
      await platformApi.cancelPlatformTask(taskId);
      await loadTasks();
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '取消任务失败'));
    }
  };

  useEffect(() => {
    void loadTasks();
  }, [status]);

  const selectedTask = detail?.task || items.find((item) => item.id === selectedId) || null;
  const queue = runtime?.queue;

  return (
    <div className="platform-page platform-jobs-page">
      <div className="platform-page-head">
        <div>
          <h1>任务</h1>
          <p>AI、视频、存储和后台批处理任务。</p>
        </div>
        <div className="btn-group">
          <span className={`status-tag ${queue?.backend === 'bullmq' && queue.available ? 'success' : 'warning'}`}>
            {queue?.backend || 'db'}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={loadTasks} disabled={loading} type="button">
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>
      </div>

      {message && <div className="alert alert-error">{message}</div>}

      <section className="card">
        <div className="ai-hub-filter-row">
          <select
            className="platform-filter-input"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="任务状态"
          >
            {STATUS_OPTIONS.map((item) => (
              <option key={item || 'all'} value={item}>
                {item ? formatStatus(item) : '全部'}
              </option>
            ))}
          </select>
          <input
            className="platform-filter-input"
            value={moduleFilter}
            onChange={(event) => setModuleFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void loadTasks();
            }}
            placeholder="模块"
          />
          <input
            className="platform-filter-input"
            value={requestId}
            onChange={(event) => setRequestId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void loadTasks();
            }}
            placeholder="请求 ID"
          />
          <button className="btn btn-secondary btn-sm" onClick={loadTasks} disabled={loading} type="button">
            查询
          </button>
        </div>

        <div className="platform-api-table-wrap">
          <table className="table table-sticky">
            <thead>
              <tr>
                <th>状态</th>
                <th>任务</th>
                <th>进度</th>
                <th>队列</th>
                <th>工作器</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={selectedId === item.id ? 'table-row-selected' : ''}
                  onClick={() => selectTask(item.id)}
                >
                  <td>
                    <span className={`status-tag ${statusClass(item.status)}`}>{formatStatus(item.status)}</span>
                  </td>
                  <td>
                    <strong>{item.module}</strong>
                    <div className="tenant-analytics-table-sub">{item.action}</div>
                  </td>
                  <td>{progressValue(item)}%</td>
                  <td>{item.queue_name || '-'}</td>
                  <td>
                    <code>{item.worker_id || '-'}</code>
                  </td>
                  <td>{formatTime(item.updated_at || item.created_at)}</td>
                  <td>
                    <div className="btn-group">
                      <button className="btn btn-secondary btn-sm" type="button" onClick={(event) => {
                        event.stopPropagation();
                        selectTask(item.id);
                      }}>
                        查看
                      </button>
                      {['queued', 'running', 'retrying'].includes(item.status) && (
                        <button className="btn btn-danger btn-sm" type="button" onClick={(event) => {
                          event.stopPropagation();
                          void cancelTask(item.id);
                        }}>
                          取消
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && <div className="loading">暂无任务</div>}
        </div>
      </section>

      {selectedTask && (
        <section className="card">
          <div className="platform-section-head">
            <div>
              <h3>{selectedTask.module} / {selectedTask.action}</h3>
              <p><code>{selectedTask.id}</code></p>
            </div>
            <span className={`status-tag ${statusClass(selectedTask.status)}`}>{formatStatus(selectedTask.status)}</span>
          </div>
          {detailLoading ? (
            <div className="loading">加载中...</div>
          ) : (
            <div className="grid">
              <div className="user-info-item">
                <label>请求</label>
                <div><code>{selectedTask.request_id || '-'}</code></div>
              </div>
              <div className="user-info-item">
                <label>来源</label>
                <div>{selectedTask.source_type || '-'}{selectedTask.source_id ? ` / ${selectedTask.source_id}` : ''}</div>
              </div>
              <div className="user-info-item">
                <label>创建时间</label>
                <div>{formatTime(selectedTask.created_at)}</div>
              </div>
              <div className="user-info-item">
                <label>错误</label>
                <div>{selectedTask.error_code || selectedTask.error_message || '-'}</div>
              </div>
            </div>
          )}

          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>时间</th>
                  <th>类型</th>
                  <th>阶段</th>
                </tr>
              </thead>
              <tbody>
                {(detail?.events || []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.seq}</td>
                    <td>{formatTime(item.created_at)}</td>
                    <td>{item.event_type}</td>
                    <td>{item.stage || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail && detail.events.length === 0 && <div className="loading">暂无事件</div>}
          </div>

          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>流</th>
                  <th>日志</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {(detail?.logs || []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.seq}</td>
                    <td>{item.stream}</td>
                    <td><code>{item.message_redacted}</code></td>
                    <td>{formatTime(item.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail && detail.logs.length === 0 && <div className="loading">暂无日志</div>}
          </div>
        </section>
      )}
    </div>
  );
}
