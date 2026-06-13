import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PlatformAppItem,
  PlatformPaymentMethodConfig,
  PlatformPaymentMethodItem,
  PlatformPaymentProviderType,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type ProviderFilter = PlatformPaymentProviderType | 'ALL';

type PaymentProductItem = {
  id: string;
  code: string;
  name: string;
  type: 'ONE_TIME' | 'RECURRING' | string;
  status: 'ACTIVE' | 'INACTIVE' | string;
  amount: string;
};

type MethodForm = {
  id?: string;
  provider_type: PlatformPaymentProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  notes: string;
  config: PlatformPaymentMethodConfig;
};

const PROVIDERS: Array<{ key: PlatformPaymentProviderType; label: string; category: '国内支付' | 'SaaS 支付' | '应用商店' }> = [
  { key: 'ALIPAY', label: '支付宝', category: '国内支付' },
  { key: 'WECHAT', label: '微信支付', category: '国内支付' },
  { key: 'STRIPE', label: 'Stripe', category: 'SaaS 支付' },
  { key: 'PADDLE', label: 'Paddle', category: 'SaaS 支付' },
  { key: 'LEMONSQUEEZY', label: 'LemonSqueezy', category: 'SaaS 支付' },
  { key: 'APPLE_IAP', label: 'Apple IAP', category: '应用商店' },
];

const PROVIDER_LABELS = Object.fromEntries(PROVIDERS.map((item) => [item.key, item.label])) as Record<
  PlatformPaymentProviderType,
  string
>;

const EMPTY_CONFIG: PlatformPaymentMethodConfig = {
  enabled: true,
  sandbox_debug: false,
  gateway_url: '',
  app_id: '',
  sign_type: 'RSA2',
  notify_url: '',
  return_url: '',
  agreement_notify_url: '',
  agreement_return_url: '',
  private_key: '',
  alipay_public_key: '',
  mch_id: '',
  api_key: '',
  mode: 'test',
  api_base_url: '',
  publishable_key: '',
  secret_key: '',
  webhook_secret: '',
  client_token: '',
  default_price_id: '',
  store_id: '',
  default_variant_id: '',
  signing_secret: '',
  success_url: '',
  cancel_url: '',
  environment: 'PRODUCTION',
  bundle_id: '',
  app_apple_id: '',
  issuer_id: '',
  key_id: '',
  root_certificates_pem: '',
};

const EMPTY_FORM: MethodForm = {
  provider_type: 'ALIPAY',
  name: '',
  is_active: true,
  is_default: false,
  notes: '',
  config: { ...EMPTY_CONFIG },
};

function toMethodForm(item: PlatformPaymentMethodItem): MethodForm {
  return {
    id: item.id,
    provider_type: item.provider_type,
    name: item.name,
    is_active: item.is_active,
    is_default: item.is_default,
    notes: item.notes || '',
    config: {
      ...EMPTY_CONFIG,
      ...item.config,
      private_key: '',
      alipay_public_key: '',
      api_key: '',
      secret_key: '',
      webhook_secret: '',
    signing_secret: '',
    root_certificates_pem: '',
  },
  };
}

function resetSecretsOnUpdate(providerType: PlatformPaymentProviderType, config: PlatformPaymentMethodConfig) {
  const next = { ...config };
  if (providerType === 'ALIPAY') {
    if (!String(next.private_key || '').trim()) delete next.private_key;
    if (!String(next.alipay_public_key || '').trim()) delete next.alipay_public_key;
  }
  if (providerType === 'WECHAT' && !String(next.api_key || '').trim()) delete next.api_key;
  if (providerType === 'STRIPE') {
    if (!String(next.secret_key || '').trim()) delete next.secret_key;
    if (!String(next.webhook_secret || '').trim()) delete next.webhook_secret;
  }
  if (providerType === 'PADDLE') {
    if (!String(next.api_key || '').trim()) delete next.api_key;
    if (!String(next.webhook_secret || '').trim()) delete next.webhook_secret;
  }
  if (providerType === 'LEMONSQUEEZY') {
    if (!String(next.api_key || '').trim()) delete next.api_key;
    if (!String(next.signing_secret || '').trim()) delete next.signing_secret;
  }
  if (providerType === 'APPLE_IAP') {
    if (!String(next.private_key || '').trim()) delete next.private_key;
    if (!String(next.root_certificates_pem || '').trim()) delete next.root_certificates_pem;
  }
  return next;
}

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString() : '-';
}

function ConfigInput({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div className={`form-group ${multiline ? 'platform-form-span-2' : ''}`}>
      <label>{label}</label>
      {multiline ? (
        <textarea value={value || ''} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={4} />
      ) : (
        <input value={value || ''} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      )}
    </div>
  );
}

export default function PlatformPaymentMethodsPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [methods, setMethods] = useState<PlatformPaymentMethodItem[]>([]);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('ALL');
  const [form, setForm] = useState<MethodForm>(EMPTY_FORM);
  const [editorOpen, setEditorOpen] = useState(false);
  const [testingMethodId, setTestingMethodId] = useState('');
  const [testResult, setTestResult] = useState('');

  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [products, setProducts] = useState<PaymentProductItem[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [flowResult, setFlowResult] = useState('');
  const [flowUserId, setFlowUserId] = useState('');
  const [flowExecuteTime, setFlowExecuteTime] = useState('');
  const [oneTimeProductId, setOneTimeProductId] = useState('');
  const [recurringProductId, setRecurringProductId] = useState('');
  const [runningFlow, setRunningFlow] = useState('');

  const filteredMethods = useMemo(
    () => (providerFilter === 'ALL' ? methods : methods.filter((item) => item.provider_type === providerFilter)),
    [methods, providerFilter],
  );

  const providerStats = useMemo(
    () =>
      PROVIDERS.map((provider) => {
        const providerMethods = methods.filter((item) => item.provider_type === provider.key);
        return {
          ...provider,
          total: providerMethods.length,
          active: providerMethods.filter((item) => item.is_active).length,
        };
      }),
    [methods],
  );

  const oneTimeProducts = useMemo(
    () => products.filter((item) => String(item.type || '').toUpperCase() === 'ONE_TIME' && String(item.status || '').toUpperCase() === 'ACTIVE'),
    [products],
  );
  const recurringProducts = useMemo(
    () => products.filter((item) => String(item.type || '').toUpperCase() === 'RECURRING' && String(item.status || '').toUpperCase() === 'ACTIVE'),
    [products],
  );

  const updateConfig = (patch: Partial<PlatformPaymentMethodConfig>) => {
    setForm((prev) => ({ ...prev, config: { ...prev.config, ...patch } }));
  };

  const startCreate = (providerType: PlatformPaymentProviderType = form.provider_type) => {
    setProviderFilter(providerType);
    setForm({ ...EMPTY_FORM, provider_type: providerType, config: { ...EMPTY_CONFIG } });
    setEditorOpen(true);
    setTestResult('');
  };

  const editMethod = (item: PlatformPaymentMethodItem) => {
    setProviderFilter(item.provider_type);
    setForm(toMethodForm(item));
    setEditorOpen(true);
    setTestResult('');
  };

  const closeEditor = () => {
    setForm({ ...EMPTY_FORM, provider_type: providerFilter === 'ALL' ? 'ALIPAY' : providerFilter, config: { ...EMPTY_CONFIG } });
    setEditorOpen(false);
  };

  const loadBaseData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [methodsResp, appsResp] = await Promise.all([
        platformApi.listGlobalPaymentMethods(),
        platformApi.listApps(true),
      ]);
      const methodsPayload = pickApiData<{ items: PlatformPaymentMethodItem[] }>(methodsResp);
      const appsPayload = pickApiData<{ items: PlatformAppItem[] }>(appsResp);
      const appItems = appsPayload?.items || [];
      setMethods(methodsPayload?.items || []);
      setApps(appItems);
      setSelectedAppId((prev) => prev || appItems[0]?.id || '');
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载支付配置失败') });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProducts = useCallback(async (appId: string) => {
    if (!appId) {
      setProducts([]);
      return;
    }
    setProductsLoading(true);
    try {
      const response = await platformApi.listAppPaymentProductsForTest(appId);
      const payload = pickApiData<{ items: PaymentProductItem[] }>(response);
      const list = payload?.items || [];
      setProducts(list);
      setOneTimeProductId(list.find((item) => String(item.type || '').toUpperCase() === 'ONE_TIME' && String(item.status || '').toUpperCase() === 'ACTIVE')?.id || '');
      setRecurringProductId(list.find((item) => String(item.type || '').toUpperCase() === 'RECURRING' && String(item.status || '').toUpperCase() === 'ACTIVE')?.id || '');
    } catch (error: unknown) {
      setProducts([]);
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载支付商品失败') });
    } finally {
      setProductsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBaseData();
  }, [loadBaseData]);

  useEffect(() => {
    if (selectedAppId) void loadProducts(selectedAppId);
  }, [loadProducts, selectedAppId]);

  const saveMethod = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setMessage({ type: 'error', text: '请输入支付方式名称' });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        provider_type: form.provider_type,
        name,
        is_active: form.is_active,
        is_default: form.is_default,
        notes: form.notes.trim() || undefined,
        config: form.id ? resetSecretsOnUpdate(form.provider_type, form.config) : { ...form.config },
      };
      if (form.id) {
        await platformApi.updateGlobalPaymentMethod(form.id, payload);
        setMessage({ type: 'success', text: '支付方式已更新' });
      } else {
        await platformApi.createGlobalPaymentMethod(payload);
        setMessage({ type: 'success', text: '支付方式已创建' });
      }
      await loadBaseData();
      closeEditor();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存支付方式失败') });
    } finally {
      setSaving(false);
    }
  };

  const deleteMethod = async (item: PlatformPaymentMethodItem) => {
    if (!window.confirm(`确认删除支付方式「${item.name}」吗？`)) return;
    setMessage(null);
    try {
      await platformApi.deleteGlobalPaymentMethod(item.id);
      setMessage({ type: 'success', text: '支付方式已删除' });
      if (form.id === item.id) closeEditor();
      await loadBaseData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除支付方式失败') });
    }
  };

  const testMethod = async (item: PlatformPaymentMethodItem) => {
    setTestingMethodId(item.id);
    setMessage(null);
    try {
      const response = await platformApi.testGlobalPaymentMethod({ method_id: item.id });
      setTestResult(JSON.stringify(response, null, 2));
      setMessage({ type: 'success', text: `支付方式「${item.name}」测试完成` });
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '支付方式测试失败') });
    } finally {
      setTestingMethodId('');
    }
  };

  const requireAppAndProduct = (needRecurring = false) => {
    if (!selectedAppId) throw new Error('请选择测试租户应用');
    if (!oneTimeProductId) throw new Error('请选择单次支付商品');
    if (needRecurring && !recurringProductId) throw new Error('请选择周期签约商品');
  };

  const runFlow = async (mode: 'alipay_one_time' | 'wechat_one_time' | 'alipay_recurring' | 'alipay_full_flow') => {
    setRunningFlow(mode);
    setMessage(null);
    try {
      if (mode === 'alipay_one_time') {
        requireAppAndProduct(false);
        const response = await platformApi.runPlatformPaymentOneTimeTest({
          app_id: selectedAppId,
          one_time_product_id: oneTimeProductId,
          user_id: flowUserId.trim() || undefined,
        });
        setFlowResult(JSON.stringify(response, null, 2));
        setMessage({ type: 'success', text: '支付宝单次测试已发起' });
        return;
      }
      if (mode === 'wechat_one_time') {
        requireAppAndProduct(false);
        const response = await platformApi.runPlatformPaymentWechatOneTimeTest({
          app_id: selectedAppId,
          one_time_product_id: oneTimeProductId,
          user_id: flowUserId.trim() || undefined,
        });
        setFlowResult(JSON.stringify(response, null, 2));
        setMessage({ type: 'success', text: '微信单次测试已发起' });
        return;
      }
      if (mode === 'alipay_recurring') {
        requireAppAndProduct(true);
        const response = await platformApi.runPlatformPaymentRecurringTest({
          app_id: selectedAppId,
          recurring_product_id: recurringProductId,
          user_id: flowUserId.trim() || undefined,
          execute_time: flowExecuteTime.trim() || undefined,
        });
        setFlowResult(JSON.stringify(response, null, 2));
        setMessage({ type: 'success', text: '支付宝签约测试已发起' });
        return;
      }
      requireAppAndProduct(true);
      const response = await platformApi.runPlatformPaymentFullFlowTest({
        app_id: selectedAppId,
        one_time_product_id: oneTimeProductId,
        recurring_product_id: recurringProductId,
        user_id: flowUserId.trim() || undefined,
      });
      setFlowResult(JSON.stringify(response, null, 2));
      setMessage({ type: 'success', text: '支付宝全链路测试已发起' });
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '支付链路测试失败') });
    } finally {
      setRunningFlow('');
    }
  };

  const renderProviderFields = () => {
    if (form.provider_type === 'ALIPAY') {
      return (
        <>
          <ConfigInput label="网关地址" value={form.config.gateway_url} onChange={(value) => updateConfig({ gateway_url: value })} placeholder="https://openapi.alipay.com/gateway.do" />
          <ConfigInput label="AppID" value={form.config.app_id} onChange={(value) => updateConfig({ app_id: value })} />
          <div className="form-group">
            <label>签名算法</label>
            <select value={form.config.sign_type || 'RSA2'} onChange={(event) => updateConfig({ sign_type: event.target.value })}>
              <option value="RSA2">RSA2</option>
              <option value="RSA">RSA</option>
            </select>
          </div>
          <ConfigInput label="应用私钥（更新时可留空）" value={form.config.private_key} onChange={(value) => updateConfig({ private_key: value })} multiline />
          <ConfigInput label="支付宝公钥（更新时可留空）" value={form.config.alipay_public_key} onChange={(value) => updateConfig({ alipay_public_key: value })} multiline />
          <ConfigInput label="支付回调地址" value={form.config.notify_url} onChange={(value) => updateConfig({ notify_url: value })} />
          <ConfigInput label="支付返回地址" value={form.config.return_url} onChange={(value) => updateConfig({ return_url: value })} />
          <ConfigInput label="签约回调地址" value={form.config.agreement_notify_url} onChange={(value) => updateConfig({ agreement_notify_url: value })} />
          <ConfigInput label="签约返回地址" value={form.config.agreement_return_url} onChange={(value) => updateConfig({ agreement_return_url: value })} />
        </>
      );
    }

    if (form.provider_type === 'WECHAT') {
      return (
        <>
          <ConfigInput label="网关地址" value={form.config.gateway_url} onChange={(value) => updateConfig({ gateway_url: value })} placeholder="https://api.mch.weixin.qq.com" />
          <ConfigInput label="AppID" value={form.config.app_id} onChange={(value) => updateConfig({ app_id: value })} />
          <ConfigInput label="商户号" value={form.config.mch_id} onChange={(value) => updateConfig({ mch_id: value })} />
          <ConfigInput label="API Key（更新时可留空）" value={form.config.api_key} onChange={(value) => updateConfig({ api_key: value })} />
          <ConfigInput label="回调地址" value={form.config.notify_url} onChange={(value) => updateConfig({ notify_url: value })} />
        </>
      );
    }

    if (form.provider_type === 'APPLE_IAP') {
      return (
        <>
          <div className="form-group">
            <label>环境</label>
            <select value={form.config.environment || 'PRODUCTION'} onChange={(event) => updateConfig({ environment: event.target.value })}>
              <option value="PRODUCTION">PRODUCTION</option>
              <option value="SANDBOX">SANDBOX</option>
            </select>
          </div>
          <ConfigInput label="Bundle ID" value={form.config.bundle_id} onChange={(value) => updateConfig({ bundle_id: value })} />
          <ConfigInput label="App Apple ID" value={form.config.app_apple_id} onChange={(value) => updateConfig({ app_apple_id: value })} />
          <ConfigInput label="Issuer ID" value={form.config.issuer_id} onChange={(value) => updateConfig({ issuer_id: value })} />
          <ConfigInput label="Key ID" value={form.config.key_id} onChange={(value) => updateConfig({ key_id: value })} />
          <ConfigInput label="Private Key（更新时可留空）" value={form.config.private_key} onChange={(value) => updateConfig({ private_key: value })} multiline />
          <ConfigInput label="Root Certificates PEM（更新时可留空）" value={form.config.root_certificates_pem} onChange={(value) => updateConfig({ root_certificates_pem: value })} multiline />
        </>
      );
    }

    return (
      <>
        <div className="form-group">
          <label>模式</label>
          <select
            value={form.config.mode || (form.provider_type === 'PADDLE' ? 'sandbox' : 'test')}
            onChange={(event) => updateConfig({ mode: event.target.value })}
          >
            {form.provider_type === 'PADDLE' ? <option value="sandbox">sandbox</option> : <option value="test">test</option>}
            <option value="live">live</option>
          </select>
        </div>
        <ConfigInput label="API Base URL" value={form.config.api_base_url} onChange={(value) => updateConfig({ api_base_url: value })} />
        {form.provider_type === 'STRIPE' && (
          <>
            <ConfigInput label="Publishable Key" value={form.config.publishable_key} onChange={(value) => updateConfig({ publishable_key: value })} />
            <ConfigInput label="Secret Key（更新时可留空）" value={form.config.secret_key} onChange={(value) => updateConfig({ secret_key: value })} />
            <ConfigInput label="Webhook Secret（更新时可留空）" value={form.config.webhook_secret} onChange={(value) => updateConfig({ webhook_secret: value })} />
          </>
        )}
        {form.provider_type === 'PADDLE' && (
          <>
            <ConfigInput label="Client Token" value={form.config.client_token} onChange={(value) => updateConfig({ client_token: value })} />
            <ConfigInput label="API Key（更新时可留空）" value={form.config.api_key} onChange={(value) => updateConfig({ api_key: value })} />
            <ConfigInput label="Webhook Secret（更新时可留空）" value={form.config.webhook_secret} onChange={(value) => updateConfig({ webhook_secret: value })} />
            <ConfigInput label="默认 Price ID" value={form.config.default_price_id} onChange={(value) => updateConfig({ default_price_id: value })} />
          </>
        )}
        {form.provider_type === 'LEMONSQUEEZY' && (
          <>
            <ConfigInput label="Store ID" value={form.config.store_id} onChange={(value) => updateConfig({ store_id: value })} />
            <ConfigInput label="API Key（更新时可留空）" value={form.config.api_key} onChange={(value) => updateConfig({ api_key: value })} />
            <ConfigInput label="Signing Secret（更新时可留空）" value={form.config.signing_secret} onChange={(value) => updateConfig({ signing_secret: value })} />
            <ConfigInput label="默认 Variant ID" value={form.config.default_variant_id} onChange={(value) => updateConfig({ default_variant_id: value })} />
          </>
        )}
        <ConfigInput label="成功返回地址" value={form.config.success_url} onChange={(value) => updateConfig({ success_url: value })} />
        <ConfigInput label="取消返回地址" value={form.config.cancel_url} onChange={(value) => updateConfig({ cancel_url: value })} />
      </>
    );
  };

  return (
    <div className="platform-page payment-methods-page">
      <div className="platform-page-head">
        <div>
          <h1>支付方式</h1>
          <p>维护租户可选择的支付凭证和回调配置。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" onClick={loadBaseData} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </button>
          <button className="btn btn-sm" onClick={() => startCreate(providerFilter === 'ALL' ? 'ALIPAY' : providerFilter)}>
            新建支付方式
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="payment-provider-strip">
        <button
          className={`payment-provider-card ${providerFilter === 'ALL' ? 'active' : ''}`}
          type="button"
          onClick={() => setProviderFilter('ALL')}
        >
          <span>全部</span>
          <strong>{methods.filter((item) => item.is_active).length}/{methods.length}</strong>
        </button>
        {providerStats.map((provider) => (
          <button
            key={provider.key}
            className={`payment-provider-card ${providerFilter === provider.key ? 'active' : ''}`}
            type="button"
            onClick={() => setProviderFilter(provider.key)}
          >
            <span>{provider.label}</span>
            <strong>{provider.active}/{provider.total}</strong>
          </button>
        ))}
      </section>

      <div className="payment-method-workbench">
        <section className="card payment-method-list-panel">
          <div className="platform-section-head">
            <h3>支付凭证</h3>
          </div>
          <div className="payment-method-list">
          {filteredMethods.map((item) => (
            <article key={item.id} className={`payment-method-card ${form.id === item.id ? 'active' : ''}`}>
              <button className="payment-method-card-main" type="button" onClick={() => editMethod(item)}>
                <span className="payment-provider-pill">{PROVIDER_LABELS[item.provider_type]}</span>
                <strong>{item.name}</strong>
                <small>{item.notes || PROVIDERS.find((provider) => provider.key === item.provider_type)?.category}</small>
              </button>
              <div className="payment-method-card-meta">
                <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>{item.is_active ? 'ACTIVE' : 'INACTIVE'}</span>
                {item.is_default && <span className="status-tag info">DEFAULT</span>}
                <span>{formatTime(item.updated_at)}</span>
              </div>
              <div className="payment-method-card-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => void testMethod(item)} disabled={testingMethodId === item.id}>
                  {testingMethodId === item.id ? '测试中...' : '测试'}
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => void deleteMethod(item)}>
                  删除
                </button>
              </div>
            </article>
          ))}
          {!filteredMethods.length && (
            <section className="payment-empty-card">
              <div className="loading">暂无支付方式</div>
              <button
                className="btn btn-sm"
                onClick={() => startCreate(providerFilter === 'ALL' ? 'ALIPAY' : providerFilter)}
              >
                新建支付方式
              </button>
            </section>
          )}
          </div>
        </section>
      </div>

      {editorOpen && (
        <div className="modal-overlay" onClick={saving ? undefined : closeEditor}>
          <section className="modal modal-lg payment-edit-modal" onClick={(event) => event.stopPropagation()}>
          <div className="platform-section-head">
            <h3>{form.id ? '编辑支付方式' : '新建支付方式'}</h3>
            <div className="btn-group">
              {form.id && (
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => startCreate(form.provider_type)} disabled={saving}>
                  新建
                </button>
              )}
              <button className="btn btn-secondary btn-sm" type="button" onClick={closeEditor} disabled={saving}>
                关闭
              </button>
            </div>
          </div>

          <form onSubmit={saveMethod} className="platform-form-grid">
            <div className="payment-form-section platform-form-span-2">
              <span>基础信息</span>
            </div>
            <div className="form-group">
              <label>类型</label>
              <select
                value={form.provider_type}
                onChange={(event) => startCreate(event.target.value as PlatformPaymentProviderType)}
                disabled={!!form.id}
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.key} value={provider.key}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>名称</label>
              <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
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
            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={(event) => setForm((prev) => ({ ...prev, is_default: event.target.checked }))}
                />
                默认
              </label>
            </div>
            <ConfigInput label="备注" value={form.notes} onChange={(value) => setForm((prev) => ({ ...prev, notes: value }))} />
            <div className="payment-form-section platform-form-span-2">
              <span>{PROVIDER_LABELS[form.provider_type]}配置</span>
            </div>
            {renderProviderFields()}
            <div className="platform-form-actions platform-form-span-2">
              <button className="btn" type="submit" disabled={saving}>
                {saving ? '保存中...' : form.id ? '保存更新' : '创建支付方式'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={closeEditor} disabled={saving}>
                取消
              </button>
            </div>
          </form>
          </section>
        </div>
      )}

      {(testResult || flowResult) && (
        <section className="payment-result-grid">
          {testResult && (
            <div className="card">
              <div className="platform-section-head">
                <h3>连通性测试结果</h3>
              </div>
              <pre className="payment-result-pre">{testResult}</pre>
            </div>
          )}
          {flowResult && (
            <div className="card">
              <div className="platform-section-head">
                <h3>链路测试结果</h3>
              </div>
              <pre className="payment-result-pre">{flowResult}</pre>
            </div>
          )}
        </section>
      )}

      <section className="card payment-flow-card">
        <div className="platform-section-head">
          <h3>支付链路测试</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => selectedAppId && loadProducts(selectedAppId)} disabled={productsLoading}>
            {productsLoading ? '加载中...' : '刷新商品'}
          </button>
        </div>
        <div className="platform-form-grid">
          <div className="form-group">
            <label>测试租户应用</label>
            <select value={selectedAppId} onChange={(event) => setSelectedAppId(event.target.value)}>
              <option value="">请选择</option>
              {apps.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.slug})
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>测试用户 ID</label>
            <input value={flowUserId} onChange={(event) => setFlowUserId(event.target.value)} placeholder="可选" />
          </div>
          <div className="form-group">
            <label>单次支付商品</label>
            <select value={oneTimeProductId} onChange={(event) => setOneTimeProductId(event.target.value)}>
              <option value="">请选择</option>
              {oneTimeProducts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} / {item.name} / {item.amount}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>周期签约商品</label>
            <select value={recurringProductId} onChange={(event) => setRecurringProductId(event.target.value)}>
              <option value="">请选择</option>
              {recurringProducts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} / {item.name} / {item.amount}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group platform-form-span-2">
            <label>签约 execute_time</label>
            <input value={flowExecuteTime} onChange={(event) => setFlowExecuteTime(event.target.value)} placeholder="可选，例如 2026-03-31 12:00:00" />
          </div>
          <div className="platform-form-actions platform-form-span-2 payment-flow-actions">
            <button className="btn" type="button" disabled={!!runningFlow} onClick={() => void runFlow('alipay_one_time')}>
              {runningFlow === 'alipay_one_time' ? '执行中...' : '支付宝单次'}
            </button>
            <button className="btn" type="button" disabled={!!runningFlow} onClick={() => void runFlow('wechat_one_time')}>
              {runningFlow === 'wechat_one_time' ? '执行中...' : '微信单次'}
            </button>
            <button className="btn" type="button" disabled={!!runningFlow} onClick={() => void runFlow('alipay_recurring')}>
              {runningFlow === 'alipay_recurring' ? '执行中...' : '支付宝签约'}
            </button>
            <button className="btn" type="button" disabled={!!runningFlow} onClick={() => void runFlow('alipay_full_flow')}>
              {runningFlow === 'alipay_full_flow' ? '执行中...' : '支付宝全链路'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
