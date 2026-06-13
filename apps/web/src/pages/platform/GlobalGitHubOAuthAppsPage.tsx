import { useEffect, useMemo, useState } from 'react';
import { platformApi, PlatformGitHubOAuthAppItem, PlatformOAuthCredentialTestResult } from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

interface GitHubOAuthAppFormState {
  name: string;
  client_id: string;
  client_secret: string;
  is_active: boolean;
}

const EMPTY_FORM: GitHubOAuthAppFormState = {
  name: '',
  client_id: '',
  client_secret: '',
  is_active: true,
};

export default function GlobalGitHubOAuthAppsPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [items, setItems] = useState<PlatformGitHubOAuthAppItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState('');
  const [formVisible, setFormVisible] = useState(false);
  const [form, setForm] = useState<GitHubOAuthAppFormState>(EMPTY_FORM);

  const currentAction = useMemo(() => (editingId ? '更新 GitHub 登录应用' : '新建 GitHub 登录应用'), [editingId]);

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await platformApi.listGlobalGitHubOAuthApps();
      const payload = pickApiData<{ items: PlatformGitHubOAuthAppItem[] }>(response);
      setItems(payload?.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 GitHub 登录应用失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormVisible(true);
  };

  const openEdit = (item: PlatformGitHubOAuthAppItem) => {
    setEditingId(item.id);
    setForm({
      name: item.name,
      client_id: item.client_id,
      client_secret: '',
      is_active: item.is_active,
    });
    setFormVisible(true);
  };

  const closeForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormVisible(false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: '请输入名称' });
      return;
    }
    if (!form.client_id.trim()) {
      setMessage({ type: 'error', text: '请输入 Client ID' });
      return;
    }
    if (!editingId && !form.client_secret.trim()) {
      setMessage({ type: 'error', text: '新建时必须填写 Client Secret' });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        name: form.name.trim(),
        client_id: form.client_id.trim(),
        client_secret: form.client_secret.trim() || undefined,
        is_active: form.is_active,
      };
      if (editingId) {
        await platformApi.updateGlobalGitHubOAuthApp(editingId, payload);
        setMessage({ type: 'success', text: 'GitHub 登录应用已更新' });
      } else {
        await platformApi.createGlobalGitHubOAuthApp({
          name: payload.name,
          client_id: payload.client_id,
          client_secret: payload.client_secret || '',
          is_active: payload.is_active,
        });
        setMessage({ type: 'success', text: 'GitHub 登录应用已创建' });
      }
      closeForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: PlatformGitHubOAuthAppItem) => {
    if (!window.confirm(`确认删除 GitHub 登录应用「${item.name}」？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalGitHubOAuthApp(item.id);
      setMessage({ type: 'success', text: 'GitHub 登录应用已删除' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除失败') });
    }
  };

  const handleTest = async (item: PlatformGitHubOAuthAppItem) => {
    setTestingId(item.id);
    setMessage(null);
    try {
      const result = pickApiData<PlatformOAuthCredentialTestResult>(await platformApi.testGlobalGitHubOAuthApp(item.id));
      setMessage({
        type: result?.success ? 'success' : 'error',
        text: result?.message || '测试完成',
      });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '测试失败') });
    } finally {
      setTestingId('');
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>GitHub 登录应用池</h1>
          <p>保存 GitHub OAuth App Client ID / Secret，租户可选择启用的登录应用。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
            {loading ? '刷新中...' : '刷新列表'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={openCreate}>
            新建 GitHub 应用
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="tenant-gallery-grid">
        {items.map((item) => (
          <article key={item.id} className="tenant-gallery-card">
            <div className="tenant-card-head">
              <div>
                <h3>{item.name}</h3>
                <p><code>{item.client_id}</code></p>
              </div>
              <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                {item.is_active ? 'ACTIVE' : 'INACTIVE'}
              </span>
            </div>

            <div className="tenant-card-meta">
              <div>
                <span>Secret</span>
                <strong>{item.client_secret_masked || '-'}</strong>
              </div>
              <div>
                <span>最近更新</span>
                <strong>{item.updated_at ? new Date(item.updated_at).toLocaleString() : '-'}</strong>
              </div>
              <div>
                <span>状态</span>
                <strong>{item.is_active ? '可选' : '停用'}</strong>
              </div>
            </div>

            <div className="tenant-card-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => handleTest(item)} disabled={testingId === item.id}>
                {testingId === item.id ? '测试中...' : '测试'}
              </button>
              <button className="btn btn-sm" onClick={() => openEdit(item)}>
                编辑
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => handleDelete(item)}>
                删除
              </button>
            </div>
          </article>
        ))}

        {!items.length && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="loading">还没有 GitHub 登录应用</div>
          </div>
        )}
      </section>

      {formVisible && (
        <section className="card">
          <div className="platform-section-head">
            <h3>{currentAction}</h3>
          </div>
          <form onSubmit={handleSubmit} className="platform-form-grid">
            <div className="form-group">
              <label>名称</label>
              <input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="例如：主站 GitHub 登录"
              />
            </div>
            <div className="form-group">
              <label>Client ID</label>
              <input
                value={form.client_id}
                onChange={(event) => setForm((prev) => ({ ...prev, client_id: event.target.value }))}
                placeholder="GitHub OAuth App Client ID"
              />
            </div>
            <div className="form-group platform-form-span-2">
              <label>{editingId ? 'Client Secret（留空则保持不变）' : 'Client Secret'}</label>
              <input
                value={form.client_secret}
                onChange={(event) => setForm((prev) => ({ ...prev, client_secret: event.target.value }))}
                placeholder={editingId ? '不修改可留空' : '请输入 Client Secret'}
              />
            </div>
            <div className="form-group">
              <label>状态</label>
              <select
                value={form.is_active ? 'ACTIVE' : 'INACTIVE'}
                onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.value === 'ACTIVE' }))}
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
              </select>
            </div>
            <div className="platform-form-actions platform-form-span-2">
              <button className="btn" type="submit" disabled={saving}>
                {saving ? '保存中...' : currentAction}
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeForm}>
                取消
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
