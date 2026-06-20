import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  PlatformAppItem,
  PlatformConnectorActionItem,
  PlatformConnectorCredentialItem,
  PlatformConnectorItem,
  PlatformConnectorRunItem,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type ConnectorForm = {
  slug: string;
  name: string;
  base_url: string;
  timeout_ms: string;
};

type CredentialForm = {
  slug: string;
  auth_mode: string;
  public_config: string;
  secrets: string;
};

type ActionForm = {
  slug: string;
  method: string;
  path_template: string;
  credential_id: string;
  input_schema: string;
  request_mapping: string;
  response_mapping: string;
};

const EMPTY_CONNECTOR: ConnectorForm = {
  slug: '',
  name: '',
  base_url: '',
  timeout_ms: '60000',
};

const EMPTY_CREDENTIAL: CredentialForm = {
  slug: 'default',
  auth_mode: 'bearer',
  public_config: '{}',
  secrets: '{"token":""}',
};

const EMPTY_ACTION: ActionForm = {
  slug: '',
  method: 'POST',
  path_template: '/',
  credential_id: '',
  input_schema: '{}',
  request_mapping: '{"body":"{{input}}"}',
  response_mapping: '{}',
};

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const raw = value.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function statusClass(status?: string | null) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'ACTIVE' || normalized === 'SUCCEEDED') return 'success';
  if (normalized === 'FAILED' || normalized === 'TIMEOUT') return 'error';
  if (normalized === 'RUNNING') return 'info';
  return 'warning';
}

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function stringify(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

export default function PlatformConnectorsPage() {
  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [connectors, setConnectors] = useState<PlatformConnectorItem[]>([]);
  const [selectedConnectorId, setSelectedConnectorId] = useState('');
  const [credentials, setCredentials] = useState<PlatformConnectorCredentialItem[]>([]);
  const [actions, setActions] = useState<PlatformConnectorActionItem[]>([]);
  const [runs, setRuns] = useState<PlatformConnectorRunItem[]>([]);
  const [connectorForm, setConnectorForm] = useState<ConnectorForm>(EMPTY_CONNECTOR);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(EMPTY_CREDENTIAL);
  const [actionForm, setActionForm] = useState<ActionForm>(EMPTY_ACTION);
  const [testInput, setTestInput] = useState('{"input":{}}');
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState('');
  const [message, setMessage] = useState('');

  const selectedConnector = useMemo(
    () => connectors.find((item) => item.id === selectedConnectorId) || null,
    [connectors, selectedConnectorId],
  );

  const selectedAction = useMemo(
    () => actions.find((item) => item.slug === actionForm.slug) || actions[0] || null,
    [actionForm.slug, actions],
  );

  const loadApps = async () => {
    const payload = pickApiData<{ items: PlatformAppItem[] }>(await platformApi.listApps(true));
    const nextApps = payload?.items || [];
    setApps(nextApps);
    setSelectedAppId((current) => (current && nextApps.some((item) => item.id === current) ? current : nextApps[0]?.id || ''));
  };

  const loadConnectors = async (appId: string) => {
    if (!appId) {
      setConnectors([]);
      setSelectedConnectorId('');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const payload = pickApiData<{ items: PlatformConnectorItem[] }>(await platformApi.listAppConnectors(appId));
      const nextItems = payload?.items || [];
      setConnectors(nextItems);
      setSelectedConnectorId((current) => (current && nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id || ''));
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载 Connectors 失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadConnectorDetail = async (connectorId: string) => {
    if (!selectedAppId || !connectorId) {
      setCredentials([]);
      setActions([]);
      setRuns([]);
      return;
    }
    try {
      const [credentialPayload, actionPayload, runPayload] = await Promise.all([
        platformApi.listConnectorCredentials(selectedAppId, connectorId),
        platformApi.listConnectorActions(selectedAppId, connectorId),
        platformApi.listConnectorRuns(selectedAppId, connectorId),
      ]);
      const nextCredentials = pickApiData<{ items: PlatformConnectorCredentialItem[] }>(credentialPayload)?.items || [];
      const nextActions = pickApiData<{ items: PlatformConnectorActionItem[] }>(actionPayload)?.items || [];
      const nextRuns = pickApiData<{ items: PlatformConnectorRunItem[] }>(runPayload)?.items || [];
      setCredentials(nextCredentials);
      setActions(nextActions);
      setRuns(nextRuns);
      setActionForm((current) => ({
        ...current,
        credential_id: current.credential_id || nextCredentials[0]?.id || '',
        slug: current.slug || nextActions[0]?.slug || '',
      }));
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '加载 Connector 明细失败'));
    }
  };

  useEffect(() => {
    void loadApps();
  }, []);

  useEffect(() => {
    void loadConnectors(selectedAppId);
  }, [selectedAppId]);

  useEffect(() => {
    void loadConnectorDetail(selectedConnectorId);
  }, [selectedConnectorId, selectedAppId]);

  const createConnector = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedAppId) return;
    setSaving('connector');
    setMessage('');
    try {
      await platformApi.createAppConnector(selectedAppId, {
        slug: connectorForm.slug,
        name: connectorForm.name || connectorForm.slug,
        base_url: connectorForm.base_url,
        timeout_ms: Number(connectorForm.timeout_ms || 60000),
      });
      setConnectorForm(EMPTY_CONNECTOR);
      await loadConnectors(selectedAppId);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '创建 Connector 失败'));
    } finally {
      setSaving('');
    }
  };

  const createCredential = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedAppId || !selectedConnector) return;
    setSaving('credential');
    setMessage('');
    try {
      await platformApi.createConnectorCredential(selectedAppId, selectedConnector.id, {
        slug: credentialForm.slug,
        auth_mode: credentialForm.auth_mode,
        public_config: parseJsonObject(credentialForm.public_config, 'public_config'),
        secrets: parseJsonObject(credentialForm.secrets, 'secrets'),
      });
      await loadConnectorDetail(selectedConnector.id);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '保存凭证失败'));
    } finally {
      setSaving('');
    }
  };

  const createAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedAppId || !selectedConnector) return;
    setSaving('action');
    setMessage('');
    try {
      await platformApi.createConnectorAction(selectedAppId, selectedConnector.id, {
        slug: actionForm.slug,
        method: actionForm.method,
        path_template: actionForm.path_template,
        credential_id: actionForm.credential_id || undefined,
        input_schema: parseJsonObject(actionForm.input_schema, 'input_schema'),
        request_mapping: parseJsonObject(actionForm.request_mapping, 'request_mapping'),
        response_mapping: parseJsonObject(actionForm.response_mapping, 'response_mapping'),
      });
      setActionForm((prev) => ({ ...EMPTY_ACTION, credential_id: prev.credential_id }));
      await loadConnectorDetail(selectedConnector.id);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '创建 Action 失败'));
    } finally {
      setSaving('');
    }
  };

  const invokeAction = async () => {
    if (!selectedAppId || !selectedConnector || !selectedAction) return;
    setSaving('invoke');
    setMessage('');
    setTestResult(null);
    try {
      const payload = parseJsonObject(testInput, '测试输入');
      const result = pickApiData<Record<string, unknown>>(
        await platformApi.invokeConnectorAction(selectedAppId, selectedConnector.id, selectedAction.slug, payload),
      );
      setTestResult(result || null);
      await loadConnectorDetail(selectedConnector.id);
    } catch (error: unknown) {
      setMessage(pickApiErrorMessage(error, '调用失败'));
    } finally {
      setSaving('');
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>Connectors</h1>
        </div>
        <div className="ai-hub-filter-row">
          <select className="platform-filter-input" value={selectedAppId} onChange={(event) => setSelectedAppId(event.target.value)}>
            {apps.map((item) => (
              <option key={item.id} value={item.id}>{item.name || item.slug}</option>
            ))}
          </select>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => loadConnectors(selectedAppId)} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>
      </div>

      {message && <div className="alert alert-error">{message}</div>}

      <div className="platform-grid-two">
        <section className="card">
          <div className="platform-section-head">
            <h3>Connectors</h3>
          </div>
          <div className="platform-api-table-wrap">
            <table className="table table-sticky">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>Actions</th>
                  <th>24h</th>
                  <th>Base URL</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((item) => (
                  <tr key={item.id} className={selectedConnectorId === item.id ? 'table-row-selected' : ''} onClick={() => setSelectedConnectorId(item.id)}>
                    <td>
                      <strong>{item.name}</strong>
                      <div className="tenant-analytics-table-sub">{item.slug}</div>
                    </td>
                    <td><span className={`status-tag ${statusClass(item.status)}`}>{item.status}</span></td>
                    <td>{toNumber(item.action_count)}</td>
                    <td>{toNumber(item.run_count_24h)} / {toNumber(item.failure_count_24h)}</td>
                    <td><code>{item.base_url}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!connectors.length && <div className="loading">暂无 Connector</div>}
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head">
            <h3>Create Connector</h3>
          </div>
          <form className="platform-form-grid compact" onSubmit={createConnector}>
            <label>Slug<input value={connectorForm.slug} onChange={(event) => setConnectorForm((prev) => ({ ...prev, slug: event.target.value }))} /></label>
            <label>Name<input value={connectorForm.name} onChange={(event) => setConnectorForm((prev) => ({ ...prev, name: event.target.value }))} /></label>
            <label className="platform-form-span-2">Base URL<input value={connectorForm.base_url} onChange={(event) => setConnectorForm((prev) => ({ ...prev, base_url: event.target.value }))} /></label>
            <label>Timeout<input value={connectorForm.timeout_ms} onChange={(event) => setConnectorForm((prev) => ({ ...prev, timeout_ms: event.target.value }))} /></label>
            <div className="platform-form-actions">
              <button className="btn btn-sm" type="submit" disabled={saving === 'connector'}>{saving === 'connector' ? '保存中...' : '创建'}</button>
            </div>
          </form>
        </section>
      </div>

      {selectedConnector && (
        <div className="platform-grid-two">
          <section className="card">
            <div className="platform-section-head">
              <h3>Credentials</h3>
            </div>
            <div className="platform-api-table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Slug</th><th>Auth</th><th>Status</th><th>Secrets</th></tr>
                </thead>
                <tbody>
                  {credentials.map((item) => (
                    <tr key={item.id}>
                      <td>{item.slug}</td>
                      <td>{item.auth_mode}</td>
                      <td><span className={`status-tag ${statusClass(item.status)}`}>{item.status}</span></td>
                      <td>{Object.keys(item.secret_status || {}).join(', ') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form className="platform-form-grid compact" onSubmit={createCredential}>
              <label>Slug<input value={credentialForm.slug} onChange={(event) => setCredentialForm((prev) => ({ ...prev, slug: event.target.value }))} /></label>
              <label>Auth<select value={credentialForm.auth_mode} onChange={(event) => setCredentialForm((prev) => ({ ...prev, auth_mode: event.target.value }))}>
                {['none', 'bearer', 'basic', 'api_key_header', 'api_key_query', 'hmac_sha256', 'custom_template'].map((item) => <option key={item} value={item}>{item}</option>)}
              </select></label>
              <label className="platform-form-span-2">Public Config<textarea rows={3} value={credentialForm.public_config} onChange={(event) => setCredentialForm((prev) => ({ ...prev, public_config: event.target.value }))} /></label>
              <label className="platform-form-span-2">Secrets<textarea rows={3} value={credentialForm.secrets} onChange={(event) => setCredentialForm((prev) => ({ ...prev, secrets: event.target.value }))} /></label>
              <div className="platform-form-actions platform-form-span-2">
                <button className="btn btn-sm" type="submit" disabled={saving === 'credential'}>{saving === 'credential' ? '保存中...' : '保存凭证'}</button>
              </div>
            </form>
          </section>

          <section className="card">
            <div className="platform-section-head">
              <h3>Actions</h3>
            </div>
            <div className="platform-api-table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Action</th><th>Route</th><th>Status</th><th>Credential</th></tr>
                </thead>
                <tbody>
                  {actions.map((item) => (
                    <tr key={item.id} className={actionForm.slug === item.slug ? 'table-row-selected' : ''} onClick={() => setActionForm((prev) => ({ ...prev, slug: item.slug, method: item.method, path_template: item.path_template, credential_id: item.credential_id || '' }))}>
                      <td>{item.slug}</td>
                      <td><code>{item.method} {item.path_template}</code></td>
                      <td><span className={`status-tag ${statusClass(item.status)}`}>{item.status}</span></td>
                      <td>{credentials.find((credential) => credential.id === item.credential_id)?.slug || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form className="platform-form-grid compact" onSubmit={createAction}>
              <label>Slug<input value={actionForm.slug} onChange={(event) => setActionForm((prev) => ({ ...prev, slug: event.target.value }))} /></label>
              <label>Method<select value={actionForm.method} onChange={(event) => setActionForm((prev) => ({ ...prev, method: event.target.value }))}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((item) => <option key={item} value={item}>{item}</option>)}
              </select></label>
              <label className="platform-form-span-2">Path<input value={actionForm.path_template} onChange={(event) => setActionForm((prev) => ({ ...prev, path_template: event.target.value }))} /></label>
              <label className="platform-form-span-2">Credential<select value={actionForm.credential_id} onChange={(event) => setActionForm((prev) => ({ ...prev, credential_id: event.target.value }))}>
                <option value="">none</option>
                {credentials.map((item) => <option key={item.id} value={item.id}>{item.slug}</option>)}
              </select></label>
              <label className="platform-form-span-2">Input Schema<textarea rows={3} value={actionForm.input_schema} onChange={(event) => setActionForm((prev) => ({ ...prev, input_schema: event.target.value }))} /></label>
              <label className="platform-form-span-2">Request Mapping<textarea rows={4} value={actionForm.request_mapping} onChange={(event) => setActionForm((prev) => ({ ...prev, request_mapping: event.target.value }))} /></label>
              <label className="platform-form-span-2">Response Mapping<textarea rows={3} value={actionForm.response_mapping} onChange={(event) => setActionForm((prev) => ({ ...prev, response_mapping: event.target.value }))} /></label>
              <div className="platform-form-actions platform-form-span-2">
                <button className="btn btn-sm" type="submit" disabled={saving === 'action'}>{saving === 'action' ? '保存中...' : '创建 Action'}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {selectedConnector && (
        <div className="platform-grid-two">
          <section className="card">
            <div className="platform-section-head">
              <h3>Test</h3>
              {selectedAction && <span className="status-tag info">{selectedAction.slug}</span>}
            </div>
            <textarea rows={8} value={testInput} onChange={(event) => setTestInput(event.target.value)} />
            <div className="platform-form-actions" style={{ marginTop: 12 }}>
              <button className="btn btn-sm" type="button" onClick={invokeAction} disabled={!selectedAction || saving === 'invoke'}>
                {saving === 'invoke' ? '调用中...' : '调用'}
              </button>
            </div>
            {testResult && <pre className="platform-code-block">{stringify(testResult)}</pre>}
          </section>

          <section className="card">
            <div className="platform-section-head">
              <h3>Runs</h3>
            </div>
            <div className="platform-api-table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Status</th><th>HTTP</th><th>Latency</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {runs.map((item) => (
                    <tr key={item.id}>
                      <td><span className={`status-tag ${statusClass(item.status)}`}>{item.status}</span></td>
                      <td>{item.status_code ?? '-'}</td>
                      <td>{item.latency_ms ?? '-'}</td>
                      <td>{formatTime(item.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!runs.length && <div className="loading">暂无运行记录</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
