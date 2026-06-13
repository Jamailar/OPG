import { useEffect, useMemo, useState } from 'react';
import {
  PlatformSmsProviderConfig,
  PlatformSmsProviderItem,
  PlatformSmsProviderType,
  PlatformSmsSignatureItem,
  PlatformSmsTemplateItem,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type SmsWorkspaceTab = 'providers' | 'signatures' | 'templates';

type SmsProviderForm = {
  id?: string;
  provider_type: PlatformSmsProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  notes: string;
  config: PlatformSmsProviderConfig;
};

type SmsSignatureForm = {
  id?: string;
  provider_id: string;
  sign_name: string;
  is_active: boolean;
  is_default: boolean;
  notes: string;
};

type SmsTemplateForm = {
  id?: string;
  provider_id: string;
  template_code: string;
  template_name: string;
  variables_example_json: string;
  is_active: boolean;
  is_default: boolean;
  notes: string;
};

const DEFAULT_GENERIC_CONFIG: PlatformSmsProviderConfig = {
  enabled: true,
  dispatch_mode: 'SYNC',
  endpoint_url: '',
  http_method: 'POST',
  auth_type: 'NONE',
  auth_header_name: 'Authorization',
  auth_token: '',
  api_key: '',
  content_type: 'JSON',
  phone_field: 'phone',
  code_field: 'code',
  sign_field: 'sign_name',
  template_field: 'template_code',
  timeout_ms: 10000,
};

const DEFAULT_ALIYUN_CONFIG: PlatformSmsProviderConfig = {
  enabled: true,
  dispatch_mode: 'ASYNC',
  endpoint_url: 'https://dysmsapi.aliyuncs.com/',
  region_id: 'cn-hangzhou',
  access_key_id: '',
  access_key_secret: '',
  timeout_ms: 10000,
};

const createProviderConfigByType = (type: PlatformSmsProviderType): PlatformSmsProviderConfig =>
  type === 'GENERIC_API' ? { ...DEFAULT_GENERIC_CONFIG } : { ...DEFAULT_ALIYUN_CONFIG };

const EMPTY_PROVIDER_FORM: SmsProviderForm = {
  provider_type: 'GENERIC_API',
  name: '',
  is_active: true,
  is_default: false,
  notes: '',
  config: createProviderConfigByType('GENERIC_API'),
};

const EMPTY_SIGNATURE_FORM: SmsSignatureForm = {
  provider_id: '',
  sign_name: '',
  is_active: true,
  is_default: false,
  notes: '',
};

const EMPTY_TEMPLATE_FORM: SmsTemplateForm = {
  provider_id: '',
  template_code: '',
  template_name: '',
  variables_example_json: '{\n  "code": "123456"\n}',
  is_active: true,
  is_default: false,
  notes: '',
};

function pickTemplateVariablesExample(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const raw = meta as Record<string, unknown>;
  const candidates = [
    raw.variables_example,
    raw.variables_sample,
    raw.template_params_example,
    raw.template_params_sample,
    raw.template_param_example,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function parseTemplateVariablesExample(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('模板变量示例必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(error?.message || '模板变量示例不是合法 JSON');
  }
}

function toProviderForm(item: PlatformSmsProviderItem): SmsProviderForm {
  return {
    id: item.id,
    provider_type: item.provider_type,
    name: item.name,
    is_active: item.is_active,
    is_default: item.is_default,
    notes: item.notes || '',
    config: {
      ...createProviderConfigByType(item.provider_type),
      ...item.config,
      auth_token: '',
      api_key: '',
      access_key_secret: '',
    },
  };
}

function toSignatureForm(item: PlatformSmsSignatureItem): SmsSignatureForm {
  return {
    id: item.id,
    provider_id: item.provider_id,
    sign_name: item.sign_name,
    is_active: item.is_active,
    is_default: item.is_default,
    notes: item.notes || '',
  };
}

function toTemplateForm(item: PlatformSmsTemplateItem): SmsTemplateForm {
  const variables = pickTemplateVariablesExample(item.meta);
  return {
    id: item.id,
    provider_id: item.provider_id,
    template_code: item.template_code,
    template_name: item.template_name || '',
    variables_example_json: variables ? JSON.stringify(variables, null, 2) : '{\n  "code": "123456"\n}',
    is_active: item.is_active,
    is_default: item.is_default,
    notes: item.notes || '',
  };
}

export default function PlatformSmsServicesPage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const [providers, setProviders] = useState<PlatformSmsProviderItem[]>([]);
  const [signatures, setSignatures] = useState<PlatformSmsSignatureItem[]>([]);
  const [templates, setTemplates] = useState<PlatformSmsTemplateItem[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [activeTab, setActiveTab] = useState<SmsWorkspaceTab>('providers');
  const [editorOpen, setEditorOpen] = useState<SmsWorkspaceTab | ''>('');

  const [providerForm, setProviderForm] = useState<SmsProviderForm>(EMPTY_PROVIDER_FORM);
  const [providerEditing, setProviderEditing] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState('');
  const [providerTestResult, setProviderTestResult] = useState('');

  const [signatureForm, setSignatureForm] = useState<SmsSignatureForm>(EMPTY_SIGNATURE_FORM);
  const [signatureEditing, setSignatureEditing] = useState(false);
  const [signatureSaving, setSignatureSaving] = useState(false);

  const [templateForm, setTemplateForm] = useState<SmsTemplateForm>(EMPTY_TEMPLATE_FORM);
  const [templateEditing, setTemplateEditing] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);

  const providerNameMap = useMemo(() => {
    const map = new Map<string, string>();
    providers.forEach((item) => map.set(item.id, item.name));
    return map;
  }, [providers]);

  const filteredSignatures = useMemo(() => {
    if (!selectedProviderId) {
      return signatures;
    }
    return signatures.filter((item) => item.provider_id === selectedProviderId);
  }, [selectedProviderId, signatures]);

  const filteredTemplates = useMemo(() => {
    if (!selectedProviderId) {
      return templates;
    }
    return templates.filter((item) => item.provider_id === selectedProviderId);
  }, [selectedProviderId, templates]);

  const smsTabs = useMemo(
    () => [
      { key: 'providers' as const, label: '短信服务', count: providers.length, active: providers.filter((item) => item.is_active).length },
      { key: 'signatures' as const, label: '签名', count: signatures.length, active: signatures.filter((item) => item.is_active).length },
      { key: 'templates' as const, label: '模板', count: templates.length, active: templates.filter((item) => item.is_active).length },
    ],
    [providers, signatures, templates],
  );

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [providersResp, signaturesResp, templatesResp] = await Promise.all([
        platformApi.listGlobalSmsProviders(),
        platformApi.listGlobalSmsSignatures(),
        platformApi.listGlobalSmsTemplates(),
      ]);
      const providersPayload = pickApiData<{ items: PlatformSmsProviderItem[] }>(providersResp);
      const signaturesPayload = pickApiData<{ items: PlatformSmsSignatureItem[] }>(signaturesResp);
      const templatesPayload = pickApiData<{ items: PlatformSmsTemplateItem[] }>(templatesResp);
      const providerItems = providersPayload?.items || [];
      const signatureItems = signaturesPayload?.items || [];
      const templateItems = templatesPayload?.items || [];

      setProviders(providerItems);
      setSignatures(signatureItems);
      setTemplates(templateItems);
      setSelectedProviderId((current) => {
        if (current && providerItems.some((item) => item.id === current)) {
          return current;
        }
        return providerItems[0]?.id || '';
      });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载短信配置失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!signatureEditing && selectedProviderId) {
      setSignatureForm((prev) => ({ ...prev, provider_id: selectedProviderId }));
    }
    if (!templateEditing && selectedProviderId) {
      setTemplateForm((prev) => ({ ...prev, provider_id: selectedProviderId }));
    }
  }, [selectedProviderId, signatureEditing, templateEditing]);

  const resetProviderForm = () => {
    setProviderEditing(false);
    setProviderForm(EMPTY_PROVIDER_FORM);
    setEditorOpen('');
  };

  const resetSignatureForm = () => {
    setSignatureEditing(false);
    setSignatureForm((prev) => ({ ...EMPTY_SIGNATURE_FORM, provider_id: prev.provider_id || selectedProviderId }));
    setEditorOpen('');
  };

  const resetTemplateForm = () => {
    setTemplateEditing(false);
    setTemplateForm((prev) => ({ ...EMPTY_TEMPLATE_FORM, provider_id: prev.provider_id || selectedProviderId }));
    setEditorOpen('');
  };

  const openCreateProvider = () => {
    setProviderEditing(false);
    setProviderForm(EMPTY_PROVIDER_FORM);
    setEditorOpen('providers');
  };

  const openCreateSignature = () => {
    setSignatureEditing(false);
    setSignatureForm({ ...EMPTY_SIGNATURE_FORM, provider_id: selectedProviderId });
    setEditorOpen('signatures');
  };

  const openCreateTemplate = () => {
    setTemplateEditing(false);
    setTemplateForm({ ...EMPTY_TEMPLATE_FORM, provider_id: selectedProviderId });
    setEditorOpen('templates');
  };

  const onProviderTypeChange = (providerType: PlatformSmsProviderType) => {
    setProviderForm((prev) => ({
      ...prev,
      provider_type: providerType,
      config: {
        ...createProviderConfigByType(providerType),
      },
    }));
  };

  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setProviderSaving(true);
    setMessage(null);
    try {
      const payload = {
        provider_type: providerForm.provider_type,
        name: providerForm.name.trim(),
        is_active: providerForm.is_active,
        is_default: providerForm.is_default,
        notes: providerForm.notes.trim() || undefined,
        config: {
          ...providerForm.config,
        },
      };

      if (!payload.name) {
        throw new Error('请输入短信服务名称');
      }

      if (providerForm.id) {
        if (providerForm.provider_type === 'GENERIC_API') {
          if (!String(payload.config.auth_token || '').trim()) {
            delete payload.config.auth_token;
          }
          if (!String(payload.config.api_key || '').trim()) {
            delete payload.config.api_key;
          }
        }
        if (providerForm.provider_type === 'ALIYUN_SMS') {
          if (!String(payload.config.access_key_secret || '').trim()) {
            delete payload.config.access_key_secret;
          }
        }
      }

      if (providerForm.id) {
        await platformApi.updateGlobalSmsProvider(providerForm.id, payload);
        setMessage({ type: 'success', text: '短信服务已更新' });
      } else {
        await platformApi.createGlobalSmsProvider(payload);
        setMessage({ type: 'success', text: '短信服务已创建' });
      }

      resetProviderForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存短信服务失败') });
    } finally {
      setProviderSaving(false);
    }
  };

  const editProvider = (item: PlatformSmsProviderItem) => {
    setProviderEditing(true);
    setProviderForm(toProviderForm(item));
    setSelectedProviderId(item.id);
    setEditorOpen('providers');
  };

  const deleteProvider = async (item: PlatformSmsProviderItem) => {
    if (!window.confirm(`确认删除短信服务「${item.name}」吗？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalSmsProvider(item.id);
      setMessage({ type: 'success', text: '短信服务已删除' });
      if (providerForm.id === item.id) {
        resetProviderForm();
      }
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除短信服务失败') });
    }
  };

  const testProvider = async (item: PlatformSmsProviderItem) => {
    setTestingProviderId(item.id);
    setMessage(null);
    try {
      const result = await platformApi.testGlobalSmsProvider({ provider_id: item.id });
      setProviderTestResult(JSON.stringify(result, null, 2));
      setMessage({ type: 'success', text: `短信服务「${item.name}」连通性测试完成` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '短信服务连通性测试失败') });
    } finally {
      setTestingProviderId('');
    }
  };

  const saveSignature = async (event: React.FormEvent) => {
    event.preventDefault();
    setSignatureSaving(true);
    setMessage(null);
    try {
      const providerId = signatureForm.provider_id || selectedProviderId;
      if (!providerId) {
        throw new Error('请先选择短信服务');
      }

      const payload = {
        provider_id: providerId,
        sign_name: signatureForm.sign_name.trim(),
        is_active: signatureForm.is_active,
        is_default: signatureForm.is_default,
        notes: signatureForm.notes.trim() || undefined,
        meta: {},
      };

      if (!payload.sign_name) {
        throw new Error('请输入签名名称');
      }

      if (signatureForm.id) {
        await platformApi.updateGlobalSmsSignature(signatureForm.id, payload);
        setMessage({ type: 'success', text: '短信签名已更新' });
      } else {
        await platformApi.createGlobalSmsSignature(payload);
        setMessage({ type: 'success', text: '短信签名已创建' });
      }

      resetSignatureForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存短信签名失败') });
    } finally {
      setSignatureSaving(false);
    }
  };

  const editSignature = (item: PlatformSmsSignatureItem) => {
    setSignatureEditing(true);
    setSignatureForm(toSignatureForm(item));
    setSelectedProviderId(item.provider_id);
    setEditorOpen('signatures');
  };

  const deleteSignature = async (item: PlatformSmsSignatureItem) => {
    if (!window.confirm(`确认删除短信签名「${item.sign_name}」吗？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalSmsSignature(item.id);
      setMessage({ type: 'success', text: '短信签名已删除' });
      if (signatureForm.id === item.id) {
        resetSignatureForm();
      }
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除短信签名失败') });
    }
  };

  const saveTemplate = async (event: React.FormEvent) => {
    event.preventDefault();
    setTemplateSaving(true);
    setMessage(null);
    try {
      const providerId = templateForm.provider_id || selectedProviderId;
      if (!providerId) {
        throw new Error('请先选择短信服务');
      }
      const payload = {
        provider_id: providerId,
        template_code: templateForm.template_code.trim(),
        template_name: templateForm.template_name.trim() || undefined,
        is_active: templateForm.is_active,
        is_default: templateForm.is_default,
        notes: templateForm.notes.trim() || undefined,
        meta: {
          variables_example: parseTemplateVariablesExample(templateForm.variables_example_json),
        },
      };

      if (!payload.template_code) {
        throw new Error('请输入模板编码');
      }

      if (templateForm.id) {
        await platformApi.updateGlobalSmsTemplate(templateForm.id, payload);
        setMessage({ type: 'success', text: '短信模板已更新' });
      } else {
        await platformApi.createGlobalSmsTemplate(payload);
        setMessage({ type: 'success', text: '短信模板已创建' });
      }

      resetTemplateForm();
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存短信模板失败') });
    } finally {
      setTemplateSaving(false);
    }
  };

  const editTemplate = (item: PlatformSmsTemplateItem) => {
    setTemplateEditing(true);
    setTemplateForm(toTemplateForm(item));
    setSelectedProviderId(item.provider_id);
    setEditorOpen('templates');
  };

  const deleteTemplate = async (item: PlatformSmsTemplateItem) => {
    if (!window.confirm(`确认删除短信模板「${item.template_code}」吗？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteGlobalSmsTemplate(item.id);
      setMessage({ type: 'success', text: '短信模板已删除' });
      if (templateForm.id === item.id) {
        resetTemplateForm();
      }
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除短信模板失败') });
    }
  };

  return (
    <div className="platform-page sms-services-page">
      <div className="platform-page-head">
        <div>
          <h1>短信服务</h1>
          <p>配置短信通道、签名和验证码模板。</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="sms-workspace-tabs">
        {smsTabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`sms-workspace-tab ${activeTab === item.key ? 'active' : ''}`}
            onClick={() => setActiveTab(item.key)}
          >
            <span>{item.label}</span>
            <strong>{item.active}/{item.count}</strong>
          </button>
        ))}
      </section>

      {activeTab === 'providers' && (
      <div className="platform-grid-two tenants-layout sms-workbench">
        <section className="card sms-list-card">
          <div className="platform-section-head">
            <h3>短信服务列表</h3>
            <button className="btn btn-sm" type="button" onClick={openCreateProvider}>
              新建
            </button>
          </div>

          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>默认</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((item) => (
                  <tr key={item.id} className={selectedProviderId === item.id ? 'table-row-selected' : ''}>
                    <td>{item.name}</td>
                    <td>{item.provider_type === 'ALIYUN_SMS' ? '阿里云短信' : '通用 API'}</td>
                    <td>
                      <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                        {item.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td>{item.is_default ? '是' : '否'}</td>
                    <td>{item.updated_at ? new Date(item.updated_at).toLocaleString() : '-'}</td>
                    <td>
                      <div className="btn-group">
                        <button className="btn btn-secondary btn-sm" onClick={() => setSelectedProviderId(item.id)}>
                          选中
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => editProvider(item)}>
                          编辑
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => void testProvider(item)}
                          disabled={testingProviderId === item.id}
                        >
                          {testingProviderId === item.id ? '测试中...' : '连通性测试'}
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => void deleteProvider(item)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!providers.length && (
                  <tr>
                    <td colSpan={6}>暂无短信服务配置</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {providerTestResult && (
            <div className="sms-test-result">
              <h4>连通性测试结果</h4>
              <pre>{providerTestResult}</pre>
            </div>
          )}
        </section>

        {editorOpen === 'providers' && (
        <div className="modal-overlay" onClick={providerSaving ? undefined : resetProviderForm}>
        <section className="modal modal-lg sms-editor-modal" onClick={(event) => event.stopPropagation()}>
          <div className="platform-section-head">
            <h3>{providerEditing ? '编辑短信服务' : '创建短信服务'}</h3>
            <button className="btn btn-secondary btn-sm" type="button" onClick={resetProviderForm} disabled={providerSaving}>
              关闭
            </button>
          </div>

          <form onSubmit={saveProvider} className="platform-form-grid">
            <div className="form-group">
              <label>类型</label>
              <select value={providerForm.provider_type} onChange={(e) => onProviderTypeChange(e.target.value as PlatformSmsProviderType)}>
                <option value="GENERIC_API">通用 API</option>
                <option value="ALIYUN_SMS">阿里云短信</option>
              </select>
            </div>

            <div className="form-group">
              <label>名称</label>
              <input
                value={providerForm.name}
                onChange={(e) => setProviderForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="例如：阿里云主通道"
                required
              />
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={providerForm.is_active}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                />
                启用服务
              </label>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={providerForm.is_default}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, is_default: e.target.checked }))}
                />
                设为默认
              </label>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!providerForm.config.enabled}
                  onChange={(e) =>
                    setProviderForm((prev) => ({ ...prev, config: { ...prev.config, enabled: e.target.checked } }))
                  }
                />
                启用配置
              </label>
            </div>

            <div className="form-group">
              <label>超时(ms)</label>
              <input
                type="number"
                min={1000}
                max={60000}
                value={Number(providerForm.config.timeout_ms || 10000)}
                onChange={(e) =>
                  setProviderForm((prev) => ({
                    ...prev,
                    config: { ...prev.config, timeout_ms: Number(e.target.value) || 10000 },
                  }))
                }
              />
            </div>

            <div className="form-group">
              <label>发送模式</label>
              <select
                value={String(providerForm.config.dispatch_mode || (providerForm.provider_type === 'ALIYUN_SMS' ? 'ASYNC' : 'SYNC'))}
                onChange={(e) =>
                  setProviderForm((prev) => ({
                    ...prev,
                    config: { ...prev.config, dispatch_mode: e.target.value },
                  }))
                }
              >
                <option value="SYNC">同步（等待短信网关响应）</option>
                <option value="ASYNC">异步（立即返回，后台派发）</option>
              </select>
            </div>

            <div className="form-group platform-form-span-2">
              <label>备注</label>
              <input
                value={providerForm.notes}
                onChange={(e) => setProviderForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="可选"
              />
            </div>

            {providerForm.provider_type === 'GENERIC_API' ? (
              <>
                <div className="form-group platform-form-span-2">
                  <label>接口地址</label>
                  <input
                    value={providerForm.config.endpoint_url || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, endpoint_url: e.target.value } }))
                    }
                    placeholder="https://example.com/sms/send"
                  />
                </div>

                <div className="form-group">
                  <label>HTTP 方法</label>
                  <select
                    value={String(providerForm.config.http_method || 'POST')}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, http_method: e.target.value } }))
                    }
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>认证方式</label>
                  <select
                    value={String(providerForm.config.auth_type || 'NONE')}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, auth_type: e.target.value } }))
                    }
                  >
                    <option value="NONE">NONE</option>
                    <option value="BEARER">BEARER</option>
                    <option value="API_KEY">API_KEY</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>认证 Header 名</label>
                  <input
                    value={providerForm.config.auth_header_name || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, auth_header_name: e.target.value } }))
                    }
                    placeholder="Authorization"
                  />
                </div>

                <div className="form-group">
                  <label>Bearer Token（更新可留空）</label>
                  <input
                    value={providerForm.config.auth_token || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, auth_token: e.target.value } }))
                    }
                  />
                </div>

                <div className="form-group">
                  <label>API Key（更新可留空）</label>
                  <input
                    value={providerForm.config.api_key || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, api_key: e.target.value } }))
                    }
                  />
                </div>

                <div className="form-group">
                  <label>内容类型</label>
                  <select
                    value={String(providerForm.config.content_type || 'JSON')}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, content_type: e.target.value } }))
                    }
                  >
                    <option value="JSON">JSON</option>
                    <option value="FORM">FORM</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>手机号字段</label>
                  <input
                    value={providerForm.config.phone_field || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, phone_field: e.target.value } }))
                    }
                    placeholder="phone"
                  />
                </div>

                <div className="form-group">
                  <label>验证码字段</label>
                  <input
                    value={providerForm.config.code_field || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, code_field: e.target.value } }))
                    }
                    placeholder="code"
                  />
                </div>

                <div className="form-group">
                  <label>签名字段</label>
                  <input
                    value={providerForm.config.sign_field || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, sign_field: e.target.value } }))
                    }
                    placeholder="sign_name"
                  />
                </div>

                <div className="form-group">
                  <label>模板字段</label>
                  <input
                    value={providerForm.config.template_field || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, template_field: e.target.value } }))
                    }
                    placeholder="template_code"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="form-group platform-form-span-2">
                  <label>接口地址</label>
                  <input
                    value={providerForm.config.endpoint_url || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, endpoint_url: e.target.value } }))
                    }
                    placeholder="https://dysmsapi.aliyuncs.com/"
                  />
                </div>

                <div className="form-group">
                  <label>Region</label>
                  <input
                    value={providerForm.config.region_id || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, region_id: e.target.value } }))
                    }
                    placeholder="cn-hangzhou"
                  />
                </div>

                <div className="form-group">
                  <label>AccessKey ID</label>
                  <input
                    value={providerForm.config.access_key_id || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, access_key_id: e.target.value } }))
                    }
                  />
                </div>

                <div className="form-group platform-form-span-2">
                  <label>AccessKey Secret（更新可留空）</label>
                  <input
                    value={providerForm.config.access_key_secret || ''}
                    onChange={(e) =>
                      setProviderForm((prev) => ({ ...prev, config: { ...prev.config, access_key_secret: e.target.value } }))
                    }
                  />
                </div>
              </>
            )}

            <div className="platform-form-actions platform-form-span-2">
              <button className="btn" type="submit" disabled={providerSaving}>
                {providerSaving ? '保存中...' : providerEditing ? '保存更新' : '创建短信服务'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={resetProviderForm} disabled={providerSaving}>
                取消
              </button>
            </div>
          </form>
        </section>
        </div>
        )}

      </div>
      )}

      {activeTab === 'signatures' && (
      <div className="platform-grid-two tenants-layout sms-workbench">
        <section className="card sms-list-card">
          <div className="platform-section-head">
            <h3>短信签名列表</h3>
            <div className="btn-group">
              <select value={selectedProviderId} onChange={(e) => setSelectedProviderId(e.target.value)} className="sms-provider-filter">
                <option value="">全部服务</option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm" type="button" onClick={openCreateSignature} disabled={!providers.length}>
                新建
              </button>
            </div>
          </div>

          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>签名</th>
                  <th>所属服务</th>
                  <th>状态</th>
                  <th>默认</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredSignatures.map((item) => (
                  <tr key={item.id}>
                    <td>{item.sign_name}</td>
                    <td>{providerNameMap.get(item.provider_id) || item.provider_id}</td>
                    <td>
                      <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                        {item.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td>{item.is_default ? '是' : '否'}</td>
                    <td>{item.updated_at ? new Date(item.updated_at).toLocaleString() : '-'}</td>
                    <td>
                      <div className="btn-group">
                        <button className="btn btn-secondary btn-sm" onClick={() => editSignature(item)}>
                          编辑
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => void deleteSignature(item)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!filteredSignatures.length && (
                  <tr>
                    <td colSpan={6}>暂无短信签名配置</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {editorOpen === 'signatures' && (
        <div className="modal-overlay" onClick={signatureSaving ? undefined : resetSignatureForm}>
        <section className="modal modal-lg sms-editor-modal" onClick={(event) => event.stopPropagation()}>
          <div className="platform-section-head">
            <h3>{signatureEditing ? '编辑短信签名' : '创建短信签名'}</h3>
            <button className="btn btn-secondary btn-sm" type="button" onClick={resetSignatureForm} disabled={signatureSaving}>
              关闭
            </button>
          </div>

          <form onSubmit={saveSignature} className="platform-form-grid">
            <div className="form-group platform-form-span-2">
              <label>所属短信服务</label>
              <select
                value={signatureForm.provider_id || selectedProviderId}
                onChange={(e) => setSignatureForm((prev) => ({ ...prev, provider_id: e.target.value }))}
                required
              >
                <option value="">请选择</option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.provider_type})
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group platform-form-span-2">
              <label>签名名称</label>
              <input
                value={signatureForm.sign_name}
                onChange={(e) => setSignatureForm((prev) => ({ ...prev, sign_name: e.target.value }))}
                placeholder="例如：Demo App"
                required
              />
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={signatureForm.is_active}
                  onChange={(e) => setSignatureForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                />
                启用签名
              </label>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={signatureForm.is_default}
                  onChange={(e) => setSignatureForm((prev) => ({ ...prev, is_default: e.target.checked }))}
                />
                设为默认
              </label>
            </div>

            <div className="form-group platform-form-span-2">
              <label>备注</label>
              <input
                value={signatureForm.notes}
                onChange={(e) => setSignatureForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="可选"
              />
            </div>

            <div className="platform-form-actions platform-form-span-2">
              <button className="btn" type="submit" disabled={signatureSaving || !providers.length}>
                {signatureSaving ? '保存中...' : signatureEditing ? '保存更新' : '创建短信签名'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={resetSignatureForm} disabled={signatureSaving}>
                取消
              </button>
            </div>
          </form>
        </section>
        </div>
        )}

      </div>
      )}

      {activeTab === 'templates' && (
      <div className="platform-grid-two tenants-layout sms-workbench">
        <section className="card sms-list-card">
          <div className="platform-section-head">
            <h3>短信模板列表</h3>
            <div className="btn-group">
              <select value={selectedProviderId} onChange={(e) => setSelectedProviderId(e.target.value)} className="sms-provider-filter">
                <option value="">全部服务</option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm" type="button" onClick={openCreateTemplate} disabled={!providers.length}>
                新建
              </button>
            </div>
          </div>

          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>模板编码</th>
                  <th>模板名称</th>
                  <th>所属服务</th>
                  <th>变量示例</th>
                  <th>状态</th>
                  <th>默认</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredTemplates.map((item) => (
                  <tr key={item.id}>
                    <td>{item.template_code}</td>
                    <td>{item.template_name || '-'}</td>
                    <td>{providerNameMap.get(item.provider_id) || item.provider_id}</td>
                    <td>
                      <code>{JSON.stringify(pickTemplateVariablesExample(item.meta) || { code: '123456' })}</code>
                    </td>
                    <td>
                      <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                        {item.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td>{item.is_default ? '是' : '否'}</td>
                    <td>
                      <div className="btn-group">
                        <button className="btn btn-secondary btn-sm" onClick={() => editTemplate(item)}>
                          编辑
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => void deleteTemplate(item)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!filteredTemplates.length && (
                  <tr>
                    <td colSpan={7}>暂无短信模板配置</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {editorOpen === 'templates' && (
        <div className="modal-overlay" onClick={templateSaving ? undefined : resetTemplateForm}>
        <section className="modal modal-lg sms-editor-modal" onClick={(event) => event.stopPropagation()}>
          <div className="platform-section-head">
            <h3>{templateEditing ? '编辑短信模板' : '登记短信模板'}</h3>
            <button className="btn btn-secondary btn-sm" type="button" onClick={resetTemplateForm} disabled={templateSaving}>
              关闭
            </button>
          </div>

          <form onSubmit={saveTemplate} className="platform-form-grid">
            <div className="form-group platform-form-span-2">
              <label>所属短信服务</label>
              <select
                value={templateForm.provider_id || selectedProviderId}
                onChange={(e) => setTemplateForm((prev) => ({ ...prev, provider_id: e.target.value }))}
                required
              >
                <option value="">请选择</option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.provider_type})
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>模板编码</label>
              <input
                value={templateForm.template_code}
                onChange={(e) => setTemplateForm((prev) => ({ ...prev, template_code: e.target.value }))}
                placeholder="例如：SMS_123456789"
                required
              />
            </div>

            <div className="form-group">
              <label>模板名称（可选）</label>
              <input
                value={templateForm.template_name}
                onChange={(e) => setTemplateForm((prev) => ({ ...prev, template_name: e.target.value }))}
                placeholder="例如：登录验证码"
              />
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={templateForm.is_active}
                  onChange={(e) => setTemplateForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                />
                启用模板
              </label>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={templateForm.is_default}
                  onChange={(e) => setTemplateForm((prev) => ({ ...prev, is_default: e.target.checked }))}
                />
                设为默认
              </label>
            </div>

            <div className="form-group platform-form-span-2">
              <label>备注</label>
              <input
                value={templateForm.notes}
                onChange={(e) => setTemplateForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="可选"
              />
            </div>

            <div className="form-group platform-form-span-2">
              <label>模板变量示例（JSON）</label>
              <textarea
                rows={6}
                value={templateForm.variables_example_json}
                onChange={(e) => setTemplateForm((prev) => ({ ...prev, variables_example_json: e.target.value }))}
                placeholder='{\n  "code": "123456"\n}'
              />
            </div>

            <div className="platform-form-actions platform-form-span-2">
              <button className="btn" type="submit" disabled={templateSaving || !providers.length}>
                {templateSaving ? '保存中...' : templateEditing ? '保存更新' : '创建短信模板'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={resetTemplateForm} disabled={templateSaving}>
                取消
              </button>
            </div>
          </form>
        </section>
        </div>
        )}

      </div>
      )}
    </div>
  );
}
