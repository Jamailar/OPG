import { useEffect, useMemo, useState } from 'react';
import {
  platformApi,
  PlatformOutboundProxyCheckLogItem,
  PlatformOutboundProxyItem,
  PlatformOutboundProxyProtocol,
  PlatformOutboundProxyStatus,
  PlatformOutboundProxyTestResult,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type FormMode = 'standard' | 'quick';

type ProxyForm = {
  id?: string;
  name: string;
  protocol: PlatformOutboundProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  clear_password: boolean;
  region: string;
  status: PlatformOutboundProxyStatus;
};

const EMPTY_FORM: ProxyForm = {
  name: '',
  protocol: 'http',
  host: '',
  port: '8080',
  username: '',
  password: '',
  clear_password: false,
  region: '',
  status: 'active',
};

const PROTOCOL_OPTIONS: Array<{ value: 'all' | PlatformOutboundProxyProtocol; label: string }> = [
  { value: 'all', label: '全部协议' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
];

const STATUS_OPTIONS: Array<{ value: 'all' | PlatformOutboundProxyStatus; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '可用' },
  { value: 'unhealthy', label: '异常' },
  { value: 'disabled', label: '禁用' },
  { value: 'checking', label: '检测中' },
];

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function formatAddress(item: PlatformOutboundProxyItem) {
  return `${item.host}:${item.port}`;
}

function formatStatus(status: string) {
  if (status === 'active') return '可用';
  if (status === 'unhealthy') return '异常';
  if (status === 'disabled') return '禁用';
  if (status === 'checking') return '检测中';
  return status || '-';
}

function statusClass(status: string) {
  if (status === 'active') return 'success';
  if (status === 'disabled') return 'warning';
  return 'error';
}

export default function OutboundProxiesPage() {
  const [items, setItems] = useState<PlatformOutboundProxyItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [protocol, setProtocol] = useState<'all' | PlatformOutboundProxyProtocol>('all');
  const [status, setStatus] = useState<'all' | PlatformOutboundProxyStatus>('all');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('standard');
  const [form, setForm] = useState<ProxyForm>(EMPTY_FORM);
  const [quickText, setQuickText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<PlatformOutboundProxyCheckLogItem[]>([]);
  const [lastTestResult, setLastTestResult] = useState<PlatformOutboundProxyTestResult | null>(null);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id)),
    [items, selectedIds],
  );
  const allSelected = items.length > 0 && selectedIds.length === items.length;

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await platformApi.listOutboundProxies({
        q: query || undefined,
        protocol,
        status,
      });
      const payload = pickApiData<{ items: PlatformOutboundProxyItem[] }>(response);
      const nextItems = payload?.items || [];
      setItems(nextItems);
      setSelectedIds((prev) => prev.filter((id) => nextItems.some((item) => item.id === id)));
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载代理失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [protocol, status]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setQuickText('');
    setFormMode('standard');
    setFormOpen(true);
  };

  const openEdit = (item: PlatformOutboundProxyItem) => {
    setForm({
      id: item.id,
      name: item.name,
      protocol: item.protocol as PlatformOutboundProxyProtocol,
      host: item.host,
      port: String(item.port || ''),
      username: item.username || '',
      password: '',
      clear_password: false,
      region: item.region || '',
      status: item.status as PlatformOutboundProxyStatus,
    });
    setFormMode('standard');
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setQuickText('');
  };

  const saveProxy = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      if (formMode === 'quick') {
        const result = pickApiData<{ imported: number; failed: number }>(
          await platformApi.importOutboundProxies({ text: quickText }),
        );
        setMessage({ type: result?.failed ? 'error' : 'success', text: `已导入 ${result?.imported || 0} 个，失败 ${result?.failed || 0} 个` });
        closeForm();
        await loadData();
        return;
      }
      const payload: {
        name: string;
        protocol: PlatformOutboundProxyProtocol;
        host: string;
        port: number;
        username: string | null;
        password?: string;
        clear_password: boolean;
        region: string | null;
        status: PlatformOutboundProxyStatus;
      } = {
        name: form.name.trim(),
        protocol: form.protocol,
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim() || null,
        password: form.password.trim() || undefined,
        clear_password: form.clear_password,
        region: form.region.trim() || null,
        status: form.status,
      };
      if (form.id) {
        const updatePayload = { ...payload };
        if (!form.password.trim()) {
          delete updatePayload.password;
        }
        await platformApi.updateOutboundProxy(form.id, updatePayload);
        setMessage({ type: 'success', text: '代理已更新' });
      } else {
        await platformApi.createOutboundProxy(payload);
        setMessage({ type: 'success', text: '代理已创建' });
      }
      closeForm();
      await loadData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存代理失败') });
    } finally {
      setSaving(false);
    }
  };

  const runBatchTest = async (quality: boolean) => {
    setChecking(true);
    setMessage(null);
    setLastTestResult(null);
    try {
      const result = pickApiData<{ total: number; ok: number; failed: number }>(
        await platformApi.batchTestOutboundProxies({
          ids: selectedIds.length ? selectedIds : undefined,
          quality,
          concurrency: 5,
        }),
      );
      setMessage({ type: result?.failed ? 'error' : 'success', text: `检测完成：可用 ${result?.ok || 0} 个，异常 ${result?.failed || 0} 个` });
      await loadData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '检测失败') });
    } finally {
      setChecking(false);
    }
  };

  const testOne = async (item: PlatformOutboundProxyItem, quality = false) => {
    setChecking(true);
    setMessage(null);
    setLastTestResult(null);
    try {
      const result = pickApiData<PlatformOutboundProxyTestResult>(
        await platformApi.testOutboundProxy(item.id, { quality }),
      );
      setLastTestResult(result || null);
      setMessage({ type: result?.ok ? 'success' : 'error', text: result?.ok ? '代理可用' : '代理不可用' });
      await loadData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '检测失败') });
    } finally {
      setChecking(false);
    }
  };

  const deleteItems = async (targets: PlatformOutboundProxyItem[]) => {
    if (!targets.length) {
      setMessage({ type: 'error', text: '请选择代理' });
      return;
    }
    if (!window.confirm(`确认删除 ${targets.length} 个代理？`)) {
      return;
    }
    setMessage(null);
    try {
      for (const item of targets) {
        await platformApi.deleteOutboundProxy(item.id);
      }
      setMessage({ type: 'success', text: '代理已删除' });
      setSelectedIds([]);
      await loadData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除代理失败') });
    }
  };

  const importProxies = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = pickApiData<{ imported: number; failed: number }>(
        await platformApi.importOutboundProxies({ text: importText }),
      );
      setMessage({ type: result?.failed ? 'error' : 'success', text: `已导入 ${result?.imported || 0} 个，失败 ${result?.failed || 0} 个` });
      setImportOpen(false);
      setImportText('');
      await loadData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '导入失败') });
    } finally {
      setSaving(false);
    }
  };

  const exportProxies = async () => {
    try {
      const payload = pickApiData<Record<string, unknown>>(await platformApi.exportOutboundProxies());
      const blob = new Blob([JSON.stringify(payload || {}, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `outbound-proxies-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '导出失败') });
    }
  };

  const openLogs = async (item: PlatformOutboundProxyItem) => {
    setLogsOpen(true);
    setLogs([]);
    try {
      const response = await platformApi.listOutboundProxyCheckLogs(item.id, { limit: 50 });
      const payload = pickApiData<{ items: PlatformOutboundProxyCheckLogItem[] }>(response);
      setLogs(payload?.items || []);
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载检测记录失败') });
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>代理 IP</h1>
          <p>配置 AI 和 Google 登录可选择的出站代理。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => runBatchTest(false)} disabled={checking}>
            测试连接
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => runBatchTest(true)} disabled={checking}>
            批量质量检测
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => deleteItems(selectedItems)} disabled={!selectedItems.length}>
            删除
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(true)}>
            导入
          </button>
          <button className="btn btn-secondary btn-sm" onClick={exportProxies}>
            导出
          </button>
          <button className="btn btn-sm" onClick={openCreate}>
            添加代理
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="card">
        <div className="ai-hub-filter-row">
          <input
            className="platform-filter-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') loadData();
            }}
            placeholder="搜索代理..."
          />
          <select value={protocol} onChange={(event) => setProtocol(event.target.value as typeof protocol)}>
            {PROTOCOL_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            {STATUS_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
            查询
          </button>
        </div>

        {lastTestResult && (
          <div className={`ai-hub-test-result ${lastTestResult.ok ? 'success' : 'error'}`}>
            <strong>{lastTestResult.ok ? '检测通过' : '检测失败'}</strong>
            <div>状态：{formatStatus(lastTestResult.status)}</div>
            <div>通过：{lastTestResult.success_count}/{lastTestResult.total_count}</div>
          </div>
        )}

        <div className="table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => setSelectedIds(event.target.checked ? items.map((item) => item.id) : [])}
                  />
                </th>
                <th>名称</th>
                <th>协议</th>
                <th>地址</th>
                <th>认证</th>
                <th>地理位置</th>
                <th>引用数</th>
                <th>延迟</th>
                <th>状态</th>
                <th>最近检测</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(item.id)}
                      onChange={(event) => {
                        setSelectedIds((prev) => (
                          event.target.checked
                            ? [...prev, item.id]
                            : prev.filter((id) => id !== item.id)
                        ));
                      }}
                    />
                  </td>
                  <td>{item.name}</td>
                  <td>{String(item.protocol).toUpperCase()}</td>
                  <td><code>{formatAddress(item)}</code></td>
                  <td>{item.username || item.has_password ? '已配置' : '-'}</td>
                  <td>
                    <div>{item.region || '-'}</div>
                    <code>{item.detected_ip || ''}</code>
                  </td>
                  <td>{item.reference_count}</td>
                  <td>{item.latency_ms === null || item.latency_ms === undefined ? '-' : `${item.latency_ms} ms`}</td>
                  <td><span className={`status-tag ${statusClass(item.status)}`}>{formatStatus(item.status)}</span></td>
                  <td>{formatTime(item.last_checked_at)}</td>
                  <td>
                    <div className="btn-group">
                      <button className="btn btn-secondary btn-sm" onClick={() => testOne(item)} disabled={checking}>测试</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => testOne(item, true)} disabled={checking}>质量</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => openLogs(item)}>日志</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(item)}>编辑</button>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteItems([item])}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!items.length && (
          <div className="credential-empty">
            <div className="loading">暂无代理</div>
            <button className="btn btn-sm" onClick={openCreate}>添加代理</button>
          </div>
        )}
      </section>

      {formOpen && (
        <div className="modal-overlay" onClick={saving ? undefined : closeForm}>
          <section className="modal modal-lg" onClick={(event) => event.stopPropagation()}>
            <div className="platform-section-head">
              <h3>{form.id ? '编辑代理' : '添加代理'}</h3>
              <div className="btn-group">
                {!form.id && (
                  <>
                    <button className={`btn btn-secondary btn-sm ${formMode === 'standard' ? 'active' : ''}`} type="button" onClick={() => setFormMode('standard')}>
                      标准添加
                    </button>
                    <button className={`btn btn-secondary btn-sm ${formMode === 'quick' ? 'active' : ''}`} type="button" onClick={() => setFormMode('quick')}>
                      快捷添加
                    </button>
                  </>
                )}
                <button className="btn btn-secondary btn-sm" type="button" onClick={closeForm} disabled={saving}>关闭</button>
              </div>
            </div>

            <form onSubmit={saveProxy} className="platform-form-grid">
              {formMode === 'quick' && !form.id ? (
                <div className="form-group platform-form-span-2">
                  <label>代理地址</label>
                  <textarea
                    value={quickText}
                    onChange={(event) => setQuickText(event.target.value)}
                    rows={6}
                    placeholder={'http://user:pass@host:8080\nsocks5://host:1080'}
                    required
                  />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label>名称</label>
                    <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label>协议</label>
                    <select value={form.protocol} onChange={(event) => setForm((prev) => ({ ...prev, protocol: event.target.value as PlatformOutboundProxyProtocol }))}>
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>主机</label>
                    <input value={form.host} onChange={(event) => setForm((prev) => ({ ...prev, host: event.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label>端口</label>
                    <input value={form.port} onChange={(event) => setForm((prev) => ({ ...prev, port: event.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label>用户名</label>
                    <input value={form.username} onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))} placeholder="可选" />
                  </div>
                  <div className="form-group">
                    <label>{form.id ? '密码（留空则保持不变）' : '密码'}</label>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                      placeholder={form.id ? '不修改可留空' : '可选'}
                    />
                  </div>
                  {form.id && (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={form.clear_password}
                        onChange={(event) => setForm((prev) => ({ ...prev, clear_password: event.target.checked }))}
                      />
                      清空密码
                    </label>
                  )}
                  <div className="form-group">
                    <label>地区</label>
                    <input value={form.region} onChange={(event) => setForm((prev) => ({ ...prev, region: event.target.value }))} placeholder="可选" />
                  </div>
                  <div className="form-group">
                    <label>状态</label>
                    <select value={form.status} onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value as PlatformOutboundProxyStatus }))}>
                      <option value="active">可用</option>
                      <option value="unhealthy">异常</option>
                      <option value="disabled">禁用</option>
                    </select>
                  </div>
                </>
              )}

              <div className="platform-form-actions platform-form-span-2">
                <button className="btn" type="submit" disabled={saving}>
                  {saving ? '保存中...' : formMode === 'quick' && !form.id ? '导入代理' : form.id ? '保存更新' : '创建代理'}
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeForm} disabled={saving}>取消</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {importOpen && (
        <div className="modal-overlay" onClick={saving ? undefined : () => setImportOpen(false)}>
          <section className="modal modal-lg" onClick={(event) => event.stopPropagation()}>
            <div className="platform-section-head">
              <h3>导入代理</h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(false)} disabled={saving}>关闭</button>
            </div>
            <div className="form-group">
              <label>代理列表</label>
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                rows={8}
                placeholder={'http://user:pass@host:8080\nsocks5://host:1080'}
              />
            </div>
            <div className="platform-form-actions">
              <button className="btn" onClick={importProxies} disabled={saving || !importText.trim()}>
                {saving ? '导入中...' : '导入'}
              </button>
              <button className="btn btn-secondary" onClick={() => setImportOpen(false)} disabled={saving}>取消</button>
            </div>
          </section>
        </div>
      )}

      {logsOpen && (
        <div className="modal-overlay" onClick={() => setLogsOpen(false)}>
          <section className="modal modal-lg" onClick={(event) => event.stopPropagation()}>
            <div className="platform-section-head">
              <h3>检测记录</h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setLogsOpen(false)}>关闭</button>
            </div>
            <div className="table-wrap">
              <table className="platform-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>HTTP</th>
                    <th>延迟</th>
                    <th>出口 IP</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td>{formatTime(log.created_at)}</td>
                      <td>{log.check_type}</td>
                      <td>{log.success ? '成功' : '失败'}</td>
                      <td>{log.status_code ?? '-'}</td>
                      <td>{log.latency_ms === null || log.latency_ms === undefined ? '-' : `${log.latency_ms} ms`}</td>
                      <td><code>{log.detected_ip || '-'}</code></td>
                      <td>{log.error_message || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!logs.length && <div className="loading">暂无检测记录</div>}
          </section>
        </div>
      )}
    </div>
  );
}
