import { useEffect, useMemo, useState } from 'react';
import { platformApi, PlatformGoogleOAuthClientItem, PlatformOAuthCredentialTestResult } from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

interface GoogleOAuthClientFormState {
  name: string;
  client_id: string;
  client_secret: string;
  is_active: boolean;
}

const EMPTY_FORM: GoogleOAuthClientFormState = {
  name: '',
  client_id: '',
  client_secret: '',
  is_active: true,
};

export default function GlobalGoogleOAuthClientsPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [items, setItems] = useState<PlatformGoogleOAuthClientItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState('');
  const [formVisible, setFormVisible] = useState(false);
  const [form, setForm] = useState<GoogleOAuthClientFormState>(EMPTY_FORM);

  const currentAction = useMemo(() => (editingId ? '更新 Google 登录应用' : '新建 Google 登录应用'), [editingId]);

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await platformApi.listGlobalGoogleOAuthClients();
      const payload = pickApiData<{ items: PlatformGoogleOAuthClientItem[] }>(response);
      setItems(payload?.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 Google 登录应用失败') });
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

  const openEdit = (item: PlatformGoogleOAuthClientItem) => {
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
        await platformApi.updateGlobalGoogleOAuthClient(editingId, payload);
        setMessage({ type: 'success', text: 'Google 登录应用已更新' });
      } else {
        await platformApi.createGlobalGoogleOAuthClient(payload);
        setMessage({ type: 'success', text: 'Google 登录应用已创建' });
      }
      closeForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: PlatformGoogleOAuthClientItem) => {
    if (!window.confirm(`确认删除 Google 登录应用「${item.name}」？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalGoogleOAuthClient(item.id);
      setMessage({ type: 'success', text: 'Google 登录应用已删除' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除失败') });
    }
  };

  const handleTest = async (item: PlatformGoogleOAuthClientItem) => {
    setTestingId(item.id);
    setMessage(null);
    try {
      const result = pickApiData<PlatformOAuthCredentialTestResult>(await platformApi.testGlobalGoogleOAuthClient(item.id));
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
          <h1>Google 登录应用池</h1>
          <p>保存 Google OAuth Client ID，租户可选择启用的登录应用。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
            {loading ? '刷新中...' : '刷新列表'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={openCreate}>
            新建 Google 应用
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="card">
        <div className="platform-section-head">
          <h3>使用说明</h3>
        </div>
        <div className="settings-help">
          <ol>
            <li>在 Google Cloud Console 创建 OAuth 2.0 Client，应用类型选择 Web application。</li>
            <li>把租户 App 的网页登录域名加入 Authorized JavaScript origins。</li>
            <li>复制 Client ID，在这里新建 Google 登录应用；Client Secret 可留空。</li>
            <li>保存后点击测试。测试通过后，到租户工作台选择这个 Google 登录应用并保存。</li>
            <li>租户 App 登录页读取 Google 登录配置后，使用该 Client ID 获取 Google id_token，再提交登录。</li>
          </ol>
          <div className="tenant-card-meta">
            <div>
              <span>Client ID</span>
              <strong>必须填写</strong>
            </div>
            <div>
              <span>Client Secret</span>
              <strong>可选</strong>
            </div>
            <div>
              <span>测试</span>
              <strong>检查 Client ID 与 Google OpenID 配置</strong>
            </div>
            <div>
              <span>启用位置</span>
              <strong>租户工作台</strong>
            </div>
          </div>
        </div>
      </section>

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
            <div className="loading">还没有 Google 登录应用</div>
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
                placeholder="例如：主站 Google 登录"
              />
            </div>
            <div className="form-group platform-form-span-2">
              <label>Client ID</label>
              <input
                value={form.client_id}
                onChange={(event) => setForm((prev) => ({ ...prev, client_id: event.target.value }))}
                placeholder="xxxx.apps.googleusercontent.com"
              />
            </div>
            <div className="form-group platform-form-span-2">
              <label>{editingId ? 'Client Secret（留空则保持不变）' : 'Client Secret'}</label>
              <input
                value={form.client_secret}
                onChange={(event) => setForm((prev) => ({ ...prev, client_secret: event.target.value }))}
                placeholder={editingId ? '不修改可留空' : '可选'}
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
