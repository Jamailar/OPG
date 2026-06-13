import { useEffect, useMemo, useState } from 'react';
import { platformApi, PlatformOAuthCredentialTestResult, PlatformWechatOpenAppItem } from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

interface WechatOpenAppFormState {
  name: string;
  app_id: string;
  app_secret: string;
  is_active: boolean;
}

const EMPTY_FORM: WechatOpenAppFormState = {
  name: '',
  app_id: '',
  app_secret: '',
  is_active: true,
};

export default function GlobalWechatAppsPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [items, setItems] = useState<PlatformWechatOpenAppItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState('');
  const [formVisible, setFormVisible] = useState(false);
  const [form, setForm] = useState<WechatOpenAppFormState>(EMPTY_FORM);

  const currentAction = useMemo(() => (editingId ? '更新微信登录应用' : '新建微信登录应用'), [editingId]);

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await platformApi.listGlobalWechatOpenApps();
      const payload = pickApiData<{ items: PlatformWechatOpenAppItem[] }>(response);
      setItems(payload?.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载微信登录应用失败') });
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

  const openEdit = (item: PlatformWechatOpenAppItem) => {
    setEditingId(item.id);
    setForm({
      name: item.name,
      app_id: item.app_id,
      app_secret: '',
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
    if (!form.app_id.trim()) {
      setMessage({ type: 'error', text: '请输入 AppID' });
      return;
    }
    if (!editingId && !form.app_secret.trim()) {
      setMessage({ type: 'error', text: '新建时必须填写 AppSecret' });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        name: form.name.trim(),
        app_id: form.app_id.trim(),
        app_secret: form.app_secret.trim() || undefined,
        is_active: form.is_active,
      };
      if (editingId) {
        await platformApi.updateGlobalWechatOpenApp(editingId, payload);
        setMessage({ type: 'success', text: '微信登录应用已更新' });
      } else {
        await platformApi.createGlobalWechatOpenApp({
          name: payload.name,
          app_id: payload.app_id,
          app_secret: payload.app_secret || '',
          is_active: payload.is_active,
        });
        setMessage({ type: 'success', text: '微信登录应用已创建' });
      }
      closeForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: PlatformWechatOpenAppItem) => {
    if (!window.confirm(`确认删除微信登录应用「${item.name}」？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalWechatOpenApp(item.id);
      setMessage({ type: 'success', text: '微信登录应用已删除' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除失败') });
    }
  };

  const handleTest = async (item: PlatformWechatOpenAppItem) => {
    setTestingId(item.id);
    setMessage(null);
    try {
      const result = pickApiData<PlatformOAuthCredentialTestResult>(await platformApi.testGlobalWechatOpenApp(item.id));
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
          <h1>微信登录应用池</h1>
          <p>统一管理网站应用 AppID / AppSecret，租户仅选择引用，不再重复保存密钥。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
            {loading ? '刷新中...' : '刷新列表'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={openCreate}>
            新建微信应用
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
                <p><code>{item.app_id}</code></p>
              </div>
              <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                {item.is_active ? 'ACTIVE' : 'INACTIVE'}
              </span>
            </div>

            <div className="tenant-card-meta">
              <div>
                <span>Secret</span>
                <strong>{item.app_secret_masked || '-'}</strong>
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
            <div className="loading">还没有微信登录应用</div>
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
                placeholder="例如：Demo App WeChat Login"
              />
            </div>
            <div className="form-group">
              <label>AppID</label>
              <input
                value={form.app_id}
                onChange={(event) => setForm((prev) => ({ ...prev, app_id: event.target.value }))}
                placeholder="wx1234567890abcdef"
              />
            </div>
            <div className="form-group platform-form-span-2">
              <label>{editingId ? 'AppSecret（留空则保持不变）' : 'AppSecret'}</label>
              <input
                value={form.app_secret}
                onChange={(event) => setForm((prev) => ({ ...prev, app_secret: event.target.value }))}
                placeholder={editingId ? '不修改可留空' : '请输入 AppSecret'}
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
