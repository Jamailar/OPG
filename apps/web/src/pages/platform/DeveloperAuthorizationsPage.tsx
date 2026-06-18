import { useEffect, useMemo, useState } from 'react';
import {
  DeveloperAuthorizationGrant,
  DeveloperAuthorizationScope,
  PlatformAppItem,
  platformApi,
} from '@/lib/api';

function pickApiData<T>(response: T | { data?: T }): T {
  return (response as { data?: T })?.data || (response as T);
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function riskClass(risk: string) {
  if (risk === 'high') return 'error';
  if (risk === 'medium') return 'warning';
  return 'success';
}

export default function DeveloperAuthorizationsPage() {
  const [grants, setGrants] = useState<DeveloperAuthorizationGrant[]>([]);
  const [scopeCatalog, setScopeCatalog] = useState<DeveloperAuthorizationScope[]>([]);
  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<{ name: string; scopes: string[]; allowed_app_ids: string[] }>({
    name: '',
    scopes: [],
    allowed_app_ids: [],
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const selectedGrant = useMemo(
    () => grants.find((item) => item.id === selectedId) || grants[0] || null,
    [grants, selectedId],
  );

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (!selectedGrant) {
      setDraft({ name: '', scopes: [], allowed_app_ids: [] });
      return;
    }
    setSelectedId(selectedGrant.id);
    setDraft({
      name: selectedGrant.name,
      scopes: selectedGrant.scopes || [],
      allowed_app_ids: selectedGrant.allowed_app_ids || [],
    });
  }, [selectedGrant?.id]);

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [grantsResp, scopesResp, appsResp] = await Promise.all([
        platformApi.listDeveloperAuthorizationGrants(),
        platformApi.listDeveloperAuthorizationScopes(),
        platformApi.listApps(true),
      ]);
      const nextGrants = pickApiData<{ items: DeveloperAuthorizationGrant[]; scope_catalog: DeveloperAuthorizationScope[] }>(grantsResp);
      const nextScopes = pickApiData<{ items: DeveloperAuthorizationScope[] }>(scopesResp);
      const nextApps = pickApiData<{ items: PlatformAppItem[] }>(appsResp);
      setGrants(nextGrants.items || []);
      setScopeCatalog(nextScopes.items || nextGrants.scope_catalog || []);
      setApps(nextApps.items || []);
      setSelectedId((current) => current || nextGrants.items?.[0]?.id || '');
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.response?.data?.message || error?.message || '加载失败' });
    } finally {
      setLoading(false);
    }
  };

  const toggleScope = (scope: string) => {
    setDraft((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(scope) ? prev.scopes.filter((item) => item !== scope) : [...prev.scopes, scope],
    }));
  };

  const toggleApp = (appId: string) => {
    setDraft((prev) => ({
      ...prev,
      allowed_app_ids: prev.allowed_app_ids.includes(appId)
        ? prev.allowed_app_ids.filter((item) => item !== appId)
        : [...prev.allowed_app_ids, appId],
    }));
  };

  const saveGrant = async () => {
    if (!selectedGrant) return;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await platformApi.updateDeveloperAuthorizationGrant(selectedGrant.id, {
        name: draft.name,
        scopes: draft.scopes,
        allowed_app_ids: draft.allowed_app_ids,
      });
      setGrants((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setMessage({ type: 'success', text: '已保存' });
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.response?.data?.message || error?.message || '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const revokeGrant = async () => {
    if (!selectedGrant) return;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await platformApi.revokeDeveloperAuthorizationGrant(selectedGrant.id);
      setGrants((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setMessage({ type: 'success', text: '已撤销' });
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.response?.data?.message || error?.message || '撤销失败' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-header">
        <div>
          <h1>开发者授权</h1>
          <p>管理 SDK、Codex 和本地开发工具的授权范围。</p>
        </div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadData()} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {message ? <div className={`message ${message.type}`}>{message.text}</div> : null}

      <div className="platform-grid-two">
        <section className="card">
          <div className="platform-section-head">
            <h3>授权记录</h3>
            <span className="status-tag info">{grants.length}</span>
          </div>
          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr><th>名称</th><th>应用</th><th>Scope</th><th>状态</th><th>最近使用</th></tr>
              </thead>
              <tbody>
                {grants.map((grant) => (
                  <tr key={grant.id} className={grant.id === selectedGrant?.id ? 'selected-row' : ''} onClick={() => setSelectedId(grant.id)}>
                    <td>
                      <strong>{grant.name}</strong>
                      <br />
                      <small>{grant.key_prefix}...{grant.key_last4}</small>
                    </td>
                    <td>{grant.allowed_apps.map((app) => app.slug).join(', ') || '-'}</td>
                    <td>{grant.scopes.length}</td>
                    <td><span className={`status-tag ${grant.status === 'ACTIVE' ? 'success' : 'muted'}`}>{grant.status}</span></td>
                    <td>{formatDateTime(grant.last_used_at)}</td>
                  </tr>
                ))}
                {!grants.length ? (
                  <tr><td colSpan={5}>{loading ? '加载中...' : '暂无授权'}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head">
            <h3>授权范围</h3>
            {selectedGrant ? <span className="status-tag">{selectedGrant.status}</span> : null}
          </div>
          {selectedGrant ? (
            <>
              <div className="platform-form-grid compact">
                <label className="platform-form-span-2">
                  名称
                  <input value={draft.name} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} />
                </label>
                <label>
                  授权用户
                  <input readOnly value={selectedGrant.user_email || selectedGrant.user_id || '-'} />
                </label>
                <label>
                  创建时间
                  <input readOnly value={formatDateTime(selectedGrant.created_at)} />
                </label>
              </div>

              <div className="platform-section-head compact"><h4>允许 App</h4></div>
              <div className="platform-permission-grid">
                {apps.map((app) => (
                  <label key={app.id} className="platform-permission-item">
                    <input
                      type="checkbox"
                      checked={draft.allowed_app_ids.includes(app.id)}
                      onChange={() => toggleApp(app.id)}
                      disabled={selectedGrant.status !== 'ACTIVE'}
                    />
                    <span>{app.slug}</span>
                  </label>
                ))}
              </div>

              <div className="platform-section-head compact"><h4>Scopes</h4></div>
              <div className="platform-permission-grid">
                {scopeCatalog.map((scope) => (
                  <label key={scope.key} className="platform-permission-item">
                    <input
                      type="checkbox"
                      checked={draft.scopes.includes(scope.key)}
                      onChange={() => toggleScope(scope.key)}
                      disabled={selectedGrant.status !== 'ACTIVE'}
                    />
                    <span>{scope.label}</span>
                    <small className={`status-tag ${riskClass(scope.risk)}`}>{scope.risk}</small>
                  </label>
                ))}
              </div>

              <div className="platform-form-actions">
                <button className="btn btn-sm" type="button" onClick={() => void saveGrant()} disabled={saving || selectedGrant.status !== 'ACTIVE'}>
                  {saving ? '保存中...' : '保存'}
                </button>
                <button className="btn btn-danger btn-sm" type="button" onClick={() => void revokeGrant()} disabled={saving || selectedGrant.status !== 'ACTIVE'}>
                  撤销
                </button>
              </div>
            </>
          ) : (
            <div className="loading">{loading ? '加载中...' : '请选择授权'}</div>
          )}
        </section>
      </div>
    </div>
  );
}
