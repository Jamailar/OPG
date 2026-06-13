import { useEffect, useMemo, useState } from 'react';
import {
  PlatformIntegrationApiKeyItem,
  PlatformRuntimeSettings,
  PlatformSmtpProviderItem,
  PlatformStorageProviderItem,
  PlatformStorageProviderType,
  platformApi,
} from '@/lib/api';
import { pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

type RuntimeSettingsForm = {
  api_base_url: string;
  admin_frontend_url: string;
  cors_origins_text: string;
  session_policy_text: string;
  payments_scheduler_text: string;
  ai_gateway_tuning_text: string;
  oauth_settings_text: string;
  integration_settings_text: string;
};

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

type SmtpProviderForm = {
  id: string;
  name: string;
  host: string;
  port: string;
  secure: boolean;
  from_email: string;
  from_name: string;
  username: string;
  password: string;
};

const EMPTY_FORM: RuntimeSettingsForm = {
  api_base_url: '',
  admin_frontend_url: '',
  cors_origins_text: '',
  session_policy_text: '{}',
  payments_scheduler_text: '{}',
  ai_gateway_tuning_text: '{}',
  oauth_settings_text: '{}',
  integration_settings_text: '{}',
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

const EMPTY_SMTP_FORM: SmtpProviderForm = {
  id: '',
  name: 'Default SMTP',
  host: '',
  port: '465',
  secure: true,
  from_email: '',
  from_name: '',
  username: '',
  password: '',
};

function formatJson(value: unknown) {
  return JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2);
}

function toForm(settings: PlatformRuntimeSettings): RuntimeSettingsForm {
  return {
    api_base_url: settings.api_base_url || '',
    admin_frontend_url: settings.admin_frontend_url || '',
    cors_origins_text: (settings.cors_origins || []).join('\n'),
    session_policy_text: formatJson(settings.session_policy),
    payments_scheduler_text: formatJson(settings.payments_scheduler),
    ai_gateway_tuning_text: formatJson(settings.ai_gateway_tuning),
    oauth_settings_text: formatJson(settings.oauth_settings),
    integration_settings_text: formatJson(settings.integration_settings),
  };
}

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

function toSmtpForm(provider?: PlatformSmtpProviderItem | null): SmtpProviderForm {
  if (!provider) return EMPTY_SMTP_FORM;
  return {
    id: provider.id,
    name: provider.name || 'Default SMTP',
    host: provider.config?.host || '',
    port: String(provider.config?.port || 465),
    secure: provider.config?.secure === undefined ? true : !!provider.config.secure,
    from_email: provider.config?.from_email || '',
    from_name: provider.config?.from_name || '',
    username: '',
    password: '',
  };
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const text = value.trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  textarea,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  textarea?: boolean;
  rows?: number;
}) {
  return (
    <div className={textarea ? 'form-group platform-form-span-2' : 'form-group'}>
      <label>{label}</label>
      {textarea ? (
        <textarea rows={rows} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}

export default function PlatformRuntimeSettingsPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [settings, setSettings] = useState<PlatformRuntimeSettings | null>(null);
  const [form, setForm] = useState<RuntimeSettingsForm>(EMPTY_FORM);
  const [storageProviders, setStorageProviders] = useState<PlatformStorageProviderItem[]>([]);
  const [storageForm, setStorageForm] = useState<StorageProviderForm>(EMPTY_STORAGE_FORM);
  const [storageSaving, setStorageSaving] = useState(false);
  const [storageTesting, setStorageTesting] = useState(false);
  const [smtpProviders, setSmtpProviders] = useState<PlatformSmtpProviderItem[]>([]);
  const [smtpForm, setSmtpForm] = useState<SmtpProviderForm>(EMPTY_SMTP_FORM);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [apiKeys, setApiKeys] = useState<PlatformIntegrationApiKeyItem[]>([]);
  const [apiKeyName, setApiKeyName] = useState('Feedback Admin API');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [createdToken, setCreatedToken] = useState('');

  const sources = useMemo(() => Object.entries(settings?.config_sources || {}), [settings]);

  const loadSettings = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const next = await platformApi.getRuntimeSettings();
      const [storage, keys, smtp] = await Promise.all([
        platformApi.listStorageProviders(),
        platformApi.listIntegrationApiKeys(),
        platformApi.listSmtpProviders(),
      ]);
      setSettings(next);
      setForm(toForm(next));
      const providers = storage.items || [];
      setStorageProviders(providers);
      setStorageForm(toStorageForm(providers.find((item) => item.is_default) || providers[0]));
      const smtpItems = smtp.items || [];
      setSmtpProviders(smtpItems);
      setSmtpForm(toSmtpForm(smtpItems.find((item) => item.is_default) || smtpItems[0]));
      setApiKeys(keys.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载平台设置失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  const updateForm = (patch: Partial<RuntimeSettingsForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const updateStorageForm = (patch: Partial<StorageProviderForm>) => {
    setStorageForm((prev) => ({ ...prev, ...patch }));
  };

  const resetStorageForm = (providerType: PlatformStorageProviderType = 'ALIYUN_OSS') => {
    setStorageForm({
      ...EMPTY_STORAGE_FORM,
      provider_type: providerType,
      name: providerType === 'ALIYUN_OSS' ? 'Aliyun OSS' : providerType === 'R2' ? 'Cloudflare R2' : 'S3 Storage',
    });
  };

  const updateSmtpForm = (patch: Partial<SmtpProviderForm>) => {
    setSmtpForm((prev) => ({ ...prev, ...patch }));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        api_base_url: form.api_base_url.trim() || null,
        admin_frontend_url: form.admin_frontend_url.trim() || null,
        cors_origins: form.cors_origins_text
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean),
        session_policy: parseJsonObject(form.session_policy_text, 'Session Policy'),
        payments_scheduler: parseJsonObject(form.payments_scheduler_text, 'Payments Scheduler'),
        ai_gateway_tuning: parseJsonObject(form.ai_gateway_tuning_text, 'AI Gateway Tuning'),
        oauth_settings: parseJsonObject(form.oauth_settings_text, 'OAuth Settings'),
        integration_settings: parseJsonObject(form.integration_settings_text, 'Integration Settings'),
      };
      const next = await platformApi.updateRuntimeSettings(payload);
      setSettings(next);
      setForm(toForm(next));
      setMessage({ type: 'success', text: '已保存' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, error?.message || '保存平台设置失败') });
    } finally {
      setSaving(false);
    }
  };

  const saveStorageProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setStorageSaving(true);
    setMessage(null);
    try {
      const payload = {
        provider_type: storageForm.provider_type,
        name: storageForm.name.trim() || (storageForm.provider_type === 'ALIYUN_OSS' ? 'Aliyun OSS' : storageForm.provider_type),
        is_active: true,
        is_default: storageForm.is_default,
        config: {
          endpoint: storageForm.endpoint.trim(),
          bucket: storageForm.bucket.trim(),
          region: storageForm.region.trim() || undefined,
          cdn_base_url: storageForm.cdn_base_url.trim() || undefined,
          cdn_auth_enabled: storageForm.cdn_auth_enabled,
          cdn_auth_window_seconds: Number(storageForm.cdn_auth_window_seconds || 120),
          timeout_ms: Number(storageForm.timeout_ms || 300000),
        },
        secrets: {
          access_key_id: storageForm.access_key_id.trim() || undefined,
          access_key_secret: storageForm.access_key_secret.trim() || undefined,
          cdn_auth_key: storageForm.cdn_auth_key.trim() || undefined,
        },
      };
      const saved = storageForm.id
        ? await platformApi.updateStorageProvider(storageForm.id, payload)
        : await platformApi.createStorageProvider(payload);
      const storage = await platformApi.listStorageProviders();
      setStorageProviders(storage.items || []);
      setStorageForm(toStorageForm(saved));
      setMessage({ type: 'success', text: '对象存储已保存' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, error?.message || '保存对象存储失败') });
    } finally {
      setStorageSaving(false);
    }
  };

  const deleteStorageProvider = async () => {
    if (!storageForm.id) return;
    setMessage(null);
    try {
      await platformApi.deleteStorageProvider(storageForm.id);
      const storage = await platformApi.listStorageProviders();
      const providers = storage.items || [];
      setStorageProviders(providers);
      setStorageForm(toStorageForm(providers.find((item) => item.is_default) || providers[0]));
      setMessage({ type: 'success', text: '对象存储已删除' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除对象存储失败') });
    }
  };

  const testStorageProvider = async () => {
    if (!storageForm.id) {
      setMessage({ type: 'error', text: '请先保存对象存储' });
      return;
    }
    setStorageTesting(true);
    setMessage(null);
    try {
      const result = await platformApi.testStorageProvider(storageForm.id);
      setMessage({ type: result.ok ? 'success' : 'error', text: result.message || '测试完成' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '测试对象存储失败') });
    } finally {
      setStorageTesting(false);
    }
  };

  const saveSmtpProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setSmtpSaving(true);
    setMessage(null);
    try {
      const payload = {
        name: smtpForm.name.trim() || 'Default SMTP',
        is_active: true,
        is_default: true,
        config: {
          host: smtpForm.host.trim(),
          port: Number(smtpForm.port || 465),
          secure: smtpForm.secure,
          from_email: smtpForm.from_email.trim(),
          from_name: smtpForm.from_name.trim() || undefined,
        },
        secrets: {
          username: smtpForm.username.trim() || undefined,
          password: smtpForm.password.trim() || undefined,
        },
      };
      const saved = smtpForm.id
        ? await platformApi.updateSmtpProvider(smtpForm.id, payload)
        : await platformApi.createSmtpProvider(payload);
      const smtp = await platformApi.listSmtpProviders();
      setSmtpProviders(smtp.items || []);
      setSmtpForm(toSmtpForm(saved));
      setMessage({ type: 'success', text: 'SMTP 已保存' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, error?.message || '保存 SMTP 失败') });
    } finally {
      setSmtpSaving(false);
    }
  };

  const testSmtpProvider = async () => {
    if (!smtpForm.id) {
      setMessage({ type: 'error', text: '请先保存 SMTP' });
      return;
    }
    setSmtpTesting(true);
    setMessage(null);
    try {
      const result = await platformApi.testSmtpProvider(smtpForm.id);
      setMessage({ type: result.ok ? 'success' : 'error', text: result.message || '测试完成' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '测试 SMTP 失败') });
    } finally {
      setSmtpTesting(false);
    }
  };

  const createApiKey = async (event: React.FormEvent) => {
    event.preventDefault();
    setApiKeySaving(true);
    setCreatedToken('');
    setMessage(null);
    try {
      const created = await platformApi.createIntegrationApiKey({
        name: apiKeyName.trim() || 'Feedback Admin API',
        scopes: ['feedback:admin'],
      });
      setCreatedToken(created.token || '');
      const keys = await platformApi.listIntegrationApiKeys();
      setApiKeys(keys.items || []);
      setMessage({ type: 'success', text: '集成密钥已创建' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '创建集成密钥失败') });
    } finally {
      setApiKeySaving(false);
    }
  };

  const revokeApiKey = async (apiKeyId: string) => {
    setMessage(null);
    try {
      await platformApi.revokeIntegrationApiKey(apiKeyId);
      const keys = await platformApi.listIntegrationApiKeys();
      setApiKeys(keys.items || []);
      setMessage({ type: 'success', text: '集成密钥已撤销' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '撤销集成密钥失败') });
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>平台设置</h1>
          <p>运行时配置</p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={loadSettings} disabled={loading || saving}>
          刷新
        </button>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <div className="platform-stats-grid compact">
        {sources.map(([key, value]) => (
          <div className="platform-stat-card" key={key}>
            <span>{key}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <form className="platform-card" onSubmit={save}>
        <div className="platform-form-grid">
          <Field
            label="API Base URL"
            value={form.api_base_url}
            placeholder="https://api.example.com"
            onChange={(value) => updateForm({ api_base_url: value })}
          />
          <Field
            label="Admin Frontend URL"
            value={form.admin_frontend_url}
            placeholder="https://admin.example.com"
            onChange={(value) => updateForm({ admin_frontend_url: value })}
          />
          <Field
            label="CORS Origins"
            value={form.cors_origins_text}
            placeholder="https://admin.example.com"
            textarea
            rows={4}
            onChange={(value) => updateForm({ cors_origins_text: value })}
          />
          <Field
            label="Session Policy"
            value={form.session_policy_text}
            textarea
            rows={5}
            onChange={(value) => updateForm({ session_policy_text: value })}
          />
          <Field
            label="Payments Scheduler"
            value={form.payments_scheduler_text}
            textarea
            rows={5}
            onChange={(value) => updateForm({ payments_scheduler_text: value })}
          />
          <Field
            label="AI Gateway Tuning"
            value={form.ai_gateway_tuning_text}
            textarea
            rows={7}
            onChange={(value) => updateForm({ ai_gateway_tuning_text: value })}
          />
          <Field
            label="OAuth Settings"
            value={form.oauth_settings_text}
            textarea
            rows={5}
            onChange={(value) => updateForm({ oauth_settings_text: value })}
          />
          <Field
            label="Integration Settings"
            value={form.integration_settings_text}
            textarea
            rows={5}
            onChange={(value) => updateForm({ integration_settings_text: value })}
          />
        </div>

        <div className="platform-form-actions">
          <button className="btn btn-primary" type="submit" disabled={saving || loading}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </form>

      <form className="platform-card" onSubmit={saveStorageProvider}>
        <div className="platform-page-head">
          <div>
            <h1>对象存储</h1>
            <p>{storageProviders.length ? `已配置 ${storageProviders.length} 个 provider` : '未配置'}</p>
          </div>
          <div className="platform-actions-row">
            <button className="btn btn-secondary" type="button" onClick={() => resetStorageForm()} disabled={storageSaving}>
              新建
            </button>
            <button className="btn btn-secondary" type="button" onClick={testStorageProvider} disabled={storageTesting || !storageForm.id}>
              {storageTesting ? '测试中...' : '测试'}
            </button>
          </div>
        </div>

        {storageProviders.length > 0 && (
          <div className="platform-chip-row">
            {storageProviders.map((provider) => (
              <button
                className={`platform-chip ${storageForm.id === provider.id ? 'active' : ''}`}
                key={provider.id}
                type="button"
                onClick={() => setStorageForm(toStorageForm(provider))}
              >
                {provider.name}
                {provider.is_default ? ' · 默认' : ''}
              </button>
            ))}
          </div>
        )}

        <div className="platform-form-grid">
          <div className="form-group">
            <label>类型</label>
            <select
              value={storageForm.provider_type}
              onChange={(event) => updateStorageForm({ provider_type: event.target.value as PlatformStorageProviderType })}
            >
              <option value="ALIYUN_OSS">Aliyun OSS</option>
              <option value="S3">S3</option>
              <option value="R2">Cloudflare R2</option>
            </select>
          </div>
          <Field label="名称" value={storageForm.name} onChange={(value) => updateStorageForm({ name: value })} />
          <Field label="Endpoint" value={storageForm.endpoint} placeholder={storageForm.provider_type === 'ALIYUN_OSS' ? 'oss-cn-shanghai.aliyuncs.com' : 'https://s3.example.com'} onChange={(value) => updateStorageForm({ endpoint: value })} />
          <Field label="Bucket" value={storageForm.bucket} onChange={(value) => updateStorageForm({ bucket: value })} />
          <Field label="Region" value={storageForm.region} placeholder={storageForm.provider_type === 'R2' ? 'auto' : 'us-east-1'} onChange={(value) => updateStorageForm({ region: value })} />
          <Field label="CDN Base URL" value={storageForm.cdn_base_url} placeholder="https://cdn.example.com" onChange={(value) => updateStorageForm({ cdn_base_url: value })} />
          <Field label="Access Key ID" value={storageForm.access_key_id} onChange={(value) => updateStorageForm({ access_key_id: value })} />
          <Field label="Access Key Secret" value={storageForm.access_key_secret} onChange={(value) => updateStorageForm({ access_key_secret: value })} />
          <Field label="CDN Auth Key" value={storageForm.cdn_auth_key} onChange={(value) => updateStorageForm({ cdn_auth_key: value })} />
          <Field label="Timeout MS" value={storageForm.timeout_ms} onChange={(value) => updateStorageForm({ timeout_ms: value })} />
          <Field label="CDN Auth Window Seconds" value={storageForm.cdn_auth_window_seconds} onChange={(value) => updateStorageForm({ cdn_auth_window_seconds: value })} />
          <div className="form-group">
            <label>CDN Auth</label>
            <select
              value={storageForm.cdn_auth_enabled ? 'true' : 'false'}
              onChange={(event) => updateStorageForm({ cdn_auth_enabled: event.target.value === 'true' })}
            >
              <option value="false">关闭</option>
              <option value="true">开启</option>
            </select>
          </div>
          <div className="form-group">
            <label>默认 Bucket</label>
            <select
              value={storageForm.is_default ? 'true' : 'false'}
              onChange={(event) => updateStorageForm({ is_default: event.target.value === 'true' })}
            >
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          </div>
        </div>

        <div className="platform-form-actions">
          <button className="btn btn-primary" type="submit" disabled={storageSaving || loading}>
            {storageSaving ? '保存中...' : '保存对象存储'}
          </button>
          {storageForm.id && (
            <button className="btn btn-secondary" type="button" onClick={deleteStorageProvider} disabled={storageSaving || loading}>
              删除
            </button>
          )}
        </div>
      </form>

      <form className="platform-card" onSubmit={saveSmtpProvider}>
        <div className="platform-page-head">
          <div>
            <h1>SMTP</h1>
            <p>{smtpProviders.length ? `已配置 ${smtpProviders.length} 个 provider` : '邮件发送'}</p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={testSmtpProvider} disabled={smtpTesting || !smtpForm.id}>
            {smtpTesting ? '测试中...' : '测试'}
          </button>
        </div>

        <div className="platform-form-grid">
          <Field label="名称" value={smtpForm.name} onChange={(value) => updateSmtpForm({ name: value })} />
          <Field label="Host" value={smtpForm.host} placeholder="smtp.example.com" onChange={(value) => updateSmtpForm({ host: value })} />
          <Field label="Port" value={smtpForm.port} onChange={(value) => updateSmtpForm({ port: value })} />
          <div className="form-group">
            <label>Secure</label>
            <select value={smtpForm.secure ? 'true' : 'false'} onChange={(event) => updateSmtpForm({ secure: event.target.value === 'true' })}>
              <option value="true">SSL/TLS</option>
              <option value="false">STARTTLS</option>
            </select>
          </div>
          <Field label="From Email" value={smtpForm.from_email} onChange={(value) => updateSmtpForm({ from_email: value })} />
          <Field label="From Name" value={smtpForm.from_name} onChange={(value) => updateSmtpForm({ from_name: value })} />
          <Field label="Username" value={smtpForm.username} onChange={(value) => updateSmtpForm({ username: value })} />
          <Field label="Password" value={smtpForm.password} onChange={(value) => updateSmtpForm({ password: value })} />
        </div>

        <div className="platform-form-actions">
          <button className="btn btn-primary" type="submit" disabled={smtpSaving || loading}>
            {smtpSaving ? '保存中...' : '保存 SMTP'}
          </button>
        </div>
      </form>

      <form className="platform-card" onSubmit={createApiKey}>
        <div className="platform-page-head">
          <div>
            <h1>集成密钥</h1>
            <p>Feedback Admin API</p>
          </div>
        </div>

        {createdToken && (
          <div className="alert alert-info">
            <code>{createdToken}</code>
          </div>
        )}

        <div className="platform-form-grid">
          <Field label="名称" value={apiKeyName} onChange={setApiKeyName} />
          <div className="form-group">
            <label>Scope</label>
            <input value="feedback:admin" disabled />
          </div>
        </div>

        <div className="platform-form-actions">
          <button className="btn btn-primary" type="submit" disabled={apiKeySaving}>
            {apiKeySaving ? '生成中...' : '生成密钥'}
          </button>
        </div>

        <div className="table-container" style={{ marginTop: 16 }}>
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>前缀</th>
                <th>状态</th>
                <th>最近使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td><code>{item.key_prefix}</code></td>
                  <td>{item.status}</td>
                  <td>{item.last_used_at ? new Date(item.last_used_at).toLocaleString() : '-'}</td>
                  <td>
                    {item.status === 'ACTIVE' && (
                      <button className="btn btn-danger btn-sm" type="button" onClick={() => void revokeApiKey(item.id)}>
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {apiKeys.length === 0 && (
                <tr>
                  <td colSpan={5}>暂无密钥</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </form>
    </div>
  );
}
