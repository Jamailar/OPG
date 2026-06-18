import { FormEvent, useEffect, useState } from 'react';
import {
  PlatformStorageProviderItem,
  PlatformStorageProviderType,
  platformApi,
} from '@/lib/api';
import { pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

type StorageProviderForm = {
  id: string;
  provider_type: PlatformStorageProviderType;
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  is_default: boolean;
  cdn_base_url: string;
  cdn_auth_enabled: boolean;
  cdn_auth_window_seconds: string;
  timeout_ms: string;
  access_key_id: string;
  access_key_secret: string;
  cdn_auth_key: string;
};

const EMPTY_STORAGE_FORM: StorageProviderForm = {
  id: '',
  provider_type: 'ALIYUN_OSS',
  name: 'Aliyun OSS',
  endpoint: '',
  bucket: '',
  region: '',
  is_default: true,
  cdn_base_url: '',
  cdn_auth_enabled: false,
  cdn_auth_window_seconds: '120',
  timeout_ms: '300000',
  access_key_id: '',
  access_key_secret: '',
  cdn_auth_key: '',
};

function toStorageForm(provider?: PlatformStorageProviderItem | null): StorageProviderForm {
  if (!provider) return EMPTY_STORAGE_FORM;
  return {
    id: provider.id,
    provider_type: provider.provider_type || 'ALIYUN_OSS',
    name: provider.name || 'Aliyun OSS',
    endpoint: provider.config?.endpoint || '',
    bucket: provider.config?.bucket || '',
    region: provider.config?.region || '',
    is_default: !!provider.is_default,
    cdn_base_url: provider.config?.cdn_base_url || '',
    cdn_auth_enabled: !!provider.config?.cdn_auth_enabled,
    cdn_auth_window_seconds: String(provider.config?.cdn_auth_window_seconds || 120),
    timeout_ms: String(provider.config?.timeout_ms || 300000),
    access_key_id: '',
    access_key_secret: '',
    cdn_auth_key: '',
  };
}

function defaultProviderName(providerType: PlatformStorageProviderType): string {
  if (providerType === 'ALIYUN_OSS') return 'Aliyun OSS';
  if (providerType === 'R2') return 'Cloudflare R2';
  return 'S3 Storage';
}

function providerTypeLabel(providerType: PlatformStorageProviderType): string {
  if (providerType === 'ALIYUN_OSS') return 'Aliyun OSS';
  if (providerType === 'R2') return 'Cloudflare R2';
  return 'S3';
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

export default function PlatformStorageSettingsPage() {
  const [providers, setProviders] = useState<PlatformStorageProviderItem[]>([]);
  const [form, setForm] = useState<StorageProviderForm>(EMPTY_STORAGE_FORM);
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState('');
  const [message, setMessage] = useState<Message>(null);

  const loadProviders = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const storage = await platformApi.listStorageProviders();
      const items = storage.items || [];
      setProviders(items);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载对象存储失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProviders();
  }, []);

  const updateForm = (patch: Partial<StorageProviderForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const resetForm = (providerType: PlatformStorageProviderType = 'ALIYUN_OSS', isDefault = providers.length === 0) => {
    setForm({
      ...EMPTY_STORAGE_FORM,
      provider_type: providerType,
      name: defaultProviderName(providerType),
      is_default: isDefault,
    });
  };

  const openCreateProvider = () => {
    resetForm();
    setMessage(null);
    setEditorOpen(true);
  };

  const editProvider = (provider: PlatformStorageProviderItem) => {
    setForm(toStorageForm(provider));
    setMessage(null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditorOpen(false);
  };

  const saveProvider = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        provider_type: form.provider_type,
        name: form.name.trim() || defaultProviderName(form.provider_type),
        is_active: true,
        is_default: form.is_default,
        config: {
          endpoint: form.endpoint.trim(),
          bucket: form.bucket.trim(),
          region: form.region.trim() || undefined,
          cdn_base_url: form.cdn_base_url.trim() || undefined,
          cdn_auth_enabled: form.cdn_auth_enabled,
          cdn_auth_window_seconds: Number(form.cdn_auth_window_seconds || 120),
          timeout_ms: Number(form.timeout_ms || 300000),
        },
        secrets: {
          access_key_id: form.access_key_id.trim() || undefined,
          access_key_secret: form.access_key_secret.trim() || undefined,
          cdn_auth_key: form.cdn_auth_key.trim() || undefined,
        },
      };
      const saved = form.id
        ? await platformApi.updateStorageProvider(form.id, payload)
        : await platformApi.createStorageProvider(payload);
      const storage = await platformApi.listStorageProviders();
      setProviders(storage.items || []);
      setForm(toStorageForm(saved));
      setMessage({ type: 'success', text: '对象存储已保存' });
      setEditorOpen(false);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, error?.message || '保存对象存储失败') });
    } finally {
      setSaving(false);
    }
  };

  const deleteProvider = async (provider: PlatformStorageProviderItem) => {
    setMessage(null);
    try {
      await platformApi.deleteStorageProvider(provider.id);
      const storage = await platformApi.listStorageProviders();
      setProviders(storage.items || []);
      setMessage({ type: 'success', text: '对象存储已删除' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除对象存储失败') });
    }
  };

  const testProvider = async (provider: PlatformStorageProviderItem) => {
    setTesting(true);
    setTestingProviderId(provider.id);
    setMessage(null);
    try {
      const result = await platformApi.testStorageProvider(provider.id);
      setMessage({ type: result.ok ? 'success' : 'error', text: result.message || '测试完成' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '测试对象存储失败') });
    } finally {
      setTesting(false);
      setTestingProviderId('');
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>对象存储</h1>
          <p>{providers.length ? `已配置 ${providers.length} 个 provider` : '未配置'}</p>
        </div>
        <div className="platform-actions-row">
          <button className="btn btn-secondary" type="button" onClick={loadProviders} disabled={loading || saving}>
            刷新
          </button>
          <button className="btn btn-primary" type="button" onClick={openCreateProvider} disabled={saving}>
            新建
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="platform-card storage-provider-list-card">
        <div className="platform-api-table-wrap">
          <table className="table storage-provider-table">
            <thead>
              <tr>
                <th>Bucket</th>
                <th>类型</th>
                <th>Endpoint</th>
                <th>Region</th>
                <th>CDN</th>
                <th>状态</th>
                <th>密钥</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td>
                    <div className="storage-name-cell">
                      <strong>{provider.config?.bucket || '-'}</strong>
                      <span>{provider.name}</span>
                    </div>
                  </td>
                  <td>{providerTypeLabel(provider.provider_type)}</td>
                  <td>
                    <code>{provider.config?.endpoint || '-'}</code>
                  </td>
                  <td>{provider.config?.region || '-'}</td>
                  <td>{provider.config?.cdn_base_url || '-'}</td>
                  <td>
                    <div className="storage-status-stack">
                      <span className={`status-tag ${provider.is_active ? 'success' : 'warning'}`}>
                        {provider.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                      {provider.is_default && <span className="status-tag info">默认</span>}
                    </div>
                  </td>
                  <td>
                    <div className="storage-secret-list">
                      <span className={provider.secret_status?.access_key_id?.configured ? 'is-configured' : ''}>AK</span>
                      <span className={provider.secret_status?.access_key_secret?.configured ? 'is-configured' : ''}>SK</span>
                      <span className={provider.secret_status?.cdn_auth_key?.configured ? 'is-configured' : ''}>CDN</span>
                    </div>
                  </td>
                  <td>{formatDateTime(provider.updated_at)}</td>
                  <td>
                    <div className="btn-group storage-row-actions">
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => editProvider(provider)}>
                        编辑
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => void testProvider(provider)}
                        disabled={testing && testingProviderId === provider.id}
                      >
                        {testingProviderId === provider.id ? '测试中...' : '测试'}
                      </button>
                      <button className="btn btn-danger btn-sm" type="button" onClick={() => void deleteProvider(provider)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!providers.length && (
                <tr>
                  <td colSpan={9}>
                    <div className="storage-empty-row">{loading ? '加载中...' : '暂无 Bucket'}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editorOpen && (
        <div className="modal-overlay" onClick={saving ? undefined : closeEditor}>
          <section className="modal modal-lg storage-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="platform-section-head">
              <h3>{form.id ? '编辑 Bucket' : '新建 Bucket'}</h3>
              <button className="btn btn-secondary btn-sm" type="button" onClick={closeEditor} disabled={saving}>
                关闭
              </button>
            </div>

            <form className="platform-form-grid" onSubmit={saveProvider}>
              <div className="form-group">
                <label>类型</label>
                <select
                  value={form.provider_type}
                  onChange={(event) => {
                    const providerType = event.target.value as PlatformStorageProviderType;
                    updateForm({ provider_type: providerType, name: form.name || defaultProviderName(providerType) });
                  }}
                >
                  <option value="ALIYUN_OSS">Aliyun OSS</option>
                  <option value="S3">S3</option>
                  <option value="R2">Cloudflare R2</option>
                </select>
              </div>
              <Field label="名称" value={form.name} onChange={(value) => updateForm({ name: value })} />
              <Field
                label="Endpoint"
                value={form.endpoint}
                placeholder={form.provider_type === 'ALIYUN_OSS' ? 'oss-cn-shanghai.aliyuncs.com' : 'https://s3.example.com'}
                onChange={(value) => updateForm({ endpoint: value })}
              />
              <Field label="Bucket" value={form.bucket} onChange={(value) => updateForm({ bucket: value })} />
              <Field
                label="Region"
                value={form.region}
                placeholder={form.provider_type === 'R2' ? 'auto' : 'us-east-1'}
                onChange={(value) => updateForm({ region: value })}
              />
              <Field label="CDN Base URL" value={form.cdn_base_url} placeholder="https://cdn.example.com" onChange={(value) => updateForm({ cdn_base_url: value })} />
              <Field label="Access Key ID" value={form.access_key_id} onChange={(value) => updateForm({ access_key_id: value })} />
              <Field label="Access Key Secret" value={form.access_key_secret} onChange={(value) => updateForm({ access_key_secret: value })} />
              <Field label="CDN Auth Key" value={form.cdn_auth_key} onChange={(value) => updateForm({ cdn_auth_key: value })} />
              <Field label="Timeout MS" value={form.timeout_ms} onChange={(value) => updateForm({ timeout_ms: value })} />
              <Field label="CDN Auth Window Seconds" value={form.cdn_auth_window_seconds} onChange={(value) => updateForm({ cdn_auth_window_seconds: value })} />
              <div className="form-group">
                <label>CDN Auth</label>
                <select
                  value={form.cdn_auth_enabled ? 'true' : 'false'}
                  onChange={(event) => updateForm({ cdn_auth_enabled: event.target.value === 'true' })}
                >
                  <option value="false">关闭</option>
                  <option value="true">开启</option>
                </select>
              </div>
              <div className="form-group">
                <label>默认 Bucket</label>
                <select
                  value={form.is_default ? 'true' : 'false'}
                  onChange={(event) => updateForm({ is_default: event.target.value === 'true' })}
                >
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              </div>

              <div className="platform-form-actions platform-form-span-2">
                <button className="btn btn-primary" type="submit" disabled={saving || loading}>
                  {saving ? '保存中...' : form.id ? '保存更新' : '创建 Bucket'}
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeEditor} disabled={saving}>
                  取消
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
