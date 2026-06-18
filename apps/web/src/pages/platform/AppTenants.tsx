import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  platformApi,
  PlatformAppItem,
  PlatformAppDomainInput,
  PlatformAppSettingsInput,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

interface AppFormState {
  slug: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  brand_name: string;
  app_url: string;
  business_admin_domain: string;
  platform_admin_domain: string;
  api_domain: string;
  user_web_domain: string;
  email_code_label: string;
  email_expire_text: string;
  email_footer_text: string;
}

const EMPTY_FORM: AppFormState = {
  slug: '',
  name: '',
  status: 'ACTIVE',
  brand_name: '',
  app_url: '',
  business_admin_domain: '',
  platform_admin_domain: '',
  api_domain: '',
  user_web_domain: '',
  email_code_label: '',
  email_expire_text: '',
  email_footer_text: '',
};

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function pickDomain(domains: PlatformAppDomainInput[] | undefined, domainType: PlatformAppDomainInput['domain_type']) {
  if (!domains || !domains.length) return '';
  const primary = domains.find((item) => item.domain_type === domainType && item.is_primary);
  if (primary) return primary.domain;
  const first = domains.find((item) => item.domain_type === domainType);
  return first?.domain || '';
}

function openWorkspacePath(appId: string): string {
  return `/platform-admin/apps/${appId}/overview`;
}

function normalizeSlugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function startsWithChineseCharacter(value: string): boolean {
  return /^[\u4e00-\u9fff]/.test(value.trim());
}

async function deriveSlugFromName(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) return '';

  if (startsWithChineseCharacter(trimmed)) {
    const { pinyin } = await import('pinyin-pro');
    const chineseName = (trimmed.match(/[\u4e00-\u9fff]/g) || []).slice(0, 2).join('');
    const syllables = pinyin(chineseName, { toneType: 'none', type: 'array' }) as string[];
    return normalizeSlugValue(syllables.join(''));
  }

  return normalizeSlugValue(trimmed);
}

export default function AppTenants() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [form, setForm] = useState<AppFormState>(EMPTY_FORM);
  const slugManuallyEditedRef = useRef(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  const currentAction = useMemo(() => (editingId ? '更新应用' : '创建应用'), [editingId]);

  const fetchApps = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const payload = pickApiData<{ items: PlatformAppItem[] }>(await platformApi.listApps(true));
      setApps(payload?.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载租户应用失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApps();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    slugManuallyEditedRef.current = false;
    setFormVisible(true);
  };

  const openEdit = (app: PlatformAppItem) => {
    setEditingId(app.id);
    slugManuallyEditedRef.current = true;
    setForm({
      slug: app.slug,
      name: app.name,
      status: app.status,
      brand_name: app.settings?.brand_name || '',
      app_url: app.settings?.app_url || '',
      business_admin_domain: pickDomain(app.domains, 'BUSINESS_ADMIN'),
      platform_admin_domain: pickDomain(app.domains, 'PLATFORM_ADMIN'),
      api_domain: pickDomain(app.domains, 'API'),
      user_web_domain: pickDomain(app.domains, 'USER_WEB'),
      email_code_label: app.settings?.email_code_label || '',
      email_expire_text: app.settings?.email_expire_text || '',
      email_footer_text: app.settings?.email_footer_text || '',
    });
    setFormVisible(true);
  };

  const closeForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    slugManuallyEditedRef.current = false;
    setFormVisible(false);
  };

  const handleNameChange = (name: string) => {
    const shouldAutoSlug = !editingId && !slugManuallyEditedRef.current;
    const canDeriveSync = !startsWithChineseCharacter(name);
    setForm((prev) => ({
      ...prev,
      name,
      slug: shouldAutoSlug && canDeriveSync ? normalizeSlugValue(name) : prev.slug,
    }));
    if (shouldAutoSlug && !canDeriveSync) {
      void deriveSlugFromName(name).then((slug) => {
        if (slugManuallyEditedRef.current) return;
        setForm((prev) => (prev.name === name ? { ...prev, slug } : prev));
      });
    }
  };

  const handleSlugChange = (slug: string) => {
    slugManuallyEditedRef.current = true;
    setForm((prev) => ({ ...prev, slug: normalizeSlugValue(slug) }));
  };

  const buildDomains = (): PlatformAppDomainInput[] => {
    const items: PlatformAppDomainInput[] = [];
    const mappings: Array<[keyof AppFormState, PlatformAppDomainInput['domain_type']]> = [
      ['business_admin_domain', 'BUSINESS_ADMIN'],
      ['platform_admin_domain', 'PLATFORM_ADMIN'],
      ['api_domain', 'API'],
      ['user_web_domain', 'USER_WEB'],
    ];

    mappings.forEach(([field, type]) => {
      const value = normalizeDomain(form[field]);
      if (!value) return;
      items.push({ domain: value, domain_type: type, is_primary: true });
    });

    return items;
  };

  const buildSettings = (): PlatformAppSettingsInput => {
    return {
      brand_name: form.brand_name.trim() || undefined,
      app_url: form.app_url.trim() || undefined,
      email_code_label: form.email_code_label.trim() || undefined,
      email_expire_text: form.email_expire_text.trim() || undefined,
      email_footer_text: form.email_footer_text.trim() || undefined,
    };
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: '请输入应用名称' });
      return;
    }
    if (!editingId && !form.slug.trim()) {
      setMessage({ type: 'error', text: '创建应用时必须填写 slug' });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        name: form.name.trim(),
        status: form.status,
        domains: buildDomains(),
        settings: buildSettings(),
      };

      if (editingId) {
        await platformApi.updateApp(editingId, payload);
        setMessage({ type: 'success', text: '应用更新成功' });
      } else {
        await platformApi.createApp({
          ...payload,
          slug: form.slug.trim().toLowerCase(),
        });
        setMessage({ type: 'success', text: '应用创建成功' });
      }

      closeForm();
      await fetchApps();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存失败') });
    } finally {
      setSaving(false);
    }
  };

  const stats = useMemo(() => {
    const total = apps.length;
    const active = apps.filter((item) => item.status === 'ACTIVE').length;
    const inactive = total - active;
    const domains = apps.reduce((sum, item) => sum + (item.domains?.length || 0), 0);
    return { total, active, inactive, domains };
  }, [apps]);

  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return apps.filter((item) => {
      if (statusFilter !== 'ALL' && item.status !== statusFilter) return false;
      if (!normalized) return true;
      return (
        item.slug.toLowerCase().includes(normalized) ||
        item.name.toLowerCase().includes(normalized) ||
        (item.slug_aliases || []).some((alias) => alias.toLowerCase().includes(normalized))
      );
    });
  }, [apps, query, statusFilter]);

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>租户应用画廊</h1>
          <p>每个应用都作为独立工作区管理，点击卡片进入该应用主页。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" onClick={fetchApps} disabled={loading}>
            {loading ? '刷新中...' : '刷新列表'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={openCreate}>
            新建应用
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <div className="platform-stats-grid compact">
        <div className="platform-stat-card"><span>租户总数</span><strong>{stats.total}</strong></div>
        <div className="platform-stat-card"><span>启用</span><strong>{stats.active}</strong></div>
        <div className="platform-stat-card"><span>停用</span><strong>{stats.inactive}</strong></div>
        <div className="platform-stat-card"><span>域名总数</span><strong>{stats.domains}</strong></div>
      </div>

      <section className="card">
        <div className="platform-filter-row">
          <input
            className="platform-filter-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索应用名称或 slug"
          />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}>
            <option value="ALL">全部状态</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="INACTIVE">INACTIVE</option>
          </select>
          <div className="platform-filter-hint">共 {filteredApps.length} 个应用</div>
        </div>
      </section>

      <section className="tenant-gallery-grid">
        {filteredApps.map((app) => {
          return (
            <article key={app.id} className="tenant-gallery-card">
              <div className="tenant-card-head">
                <div>
                  <h3>{app.name}</h3>
                  <p><code>{app.slug}</code></p>
                  {!!app.slug_aliases?.length && <p>{app.slug_aliases.map((alias) => `/${alias}/v1`).join(' · ')}</p>}
                </div>
                <span className={`status-tag ${app.status === 'ACTIVE' ? 'success' : 'warning'}`}>
                  {app.status}
                </span>
              </div>

              <div className="tenant-card-actions">
                <Link className="btn btn-sm" to={openWorkspacePath(app.id)}>
                  进入工作区
                </Link>
                <button className="btn btn-secondary btn-sm" onClick={() => openEdit(app)}>
                  编辑配置
                </button>
              </div>
            </article>
          );
        })}

        {!filteredApps.length && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="loading">没有匹配的应用</div>
          </div>
        )}
      </section>

      {formVisible && (
        <div className="modal-overlay" onClick={saving ? undefined : closeForm}>
          <section className="modal modal-lg" onClick={(event) => event.stopPropagation()}>
            <div className="platform-section-head">
              <h3>{currentAction}</h3>
            </div>

            <form onSubmit={handleSubmit} className="platform-form-grid">
              <div className="form-group platform-form-span-2">
                <label>应用名称</label>
                <input
                  value={form.name}
                  onChange={(event) => handleNameChange(event.target.value)}
                  placeholder="应用名称"
                />
              </div>
              <div className="form-group platform-form-span-2">
                <label>应用 Slug</label>
                <input
                  value={form.slug}
                  onChange={(event) => handleSlugChange(event.target.value)}
                  disabled={Boolean(editingId)}
                  placeholder="根据应用名称自动生成"
                />
              </div>
              <div className="form-group">
                <label>状态</label>
                <select
                  value={form.status}
                  onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value as 'ACTIVE' | 'INACTIVE' }))}
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
              <div className="form-group">
                <label>品牌名称</label>
                <input
                  value={form.brand_name}
                  onChange={(event) => setForm((prev) => ({ ...prev, brand_name: event.target.value }))}
                  placeholder="例如: Demo App"
                />
              </div>
              <div className="form-group platform-form-span-2">
                <label>应用 URL</label>
                <input
                  value={form.app_url}
                  onChange={(event) => setForm((prev) => ({ ...prev, app_url: event.target.value }))}
                  placeholder="https://app.example.com"
                />
              </div>
              {editingId && (
                <>
                  <div className="form-group platform-form-span-2">
                    <label>邮件验证码说明</label>
                    <input
                      value={form.email_code_label}
                      onChange={(event) => setForm((prev) => ({ ...prev, email_code_label: event.target.value }))}
                      placeholder="例如：您正在使用 {app_name} 邮箱验证码。请使用以下验证码完成操作："
                    />
                  </div>
                  <div className="form-group">
                    <label>验证码失效说明</label>
                    <input
                      value={form.email_expire_text}
                      onChange={(event) => setForm((prev) => ({ ...prev, email_expire_text: event.target.value }))}
                      placeholder="例如：该验证码将在 10 分钟后失效。"
                    />
                  </div>
                  <div className="form-group">
                    <label>邮件页脚</label>
                    <input
                      value={form.email_footer_text}
                      onChange={(event) => setForm((prev) => ({ ...prev, email_footer_text: event.target.value }))}
                      placeholder="例如：© {app_name} · 此邮件由系统自动发送，请勿回复"
                    />
                  </div>
                  <div className="form-group">
                    <label>业务后台域名</label>
                    <input
                      value={form.business_admin_domain}
                      onChange={(event) => setForm((prev) => ({ ...prev, business_admin_domain: event.target.value }))}
                      placeholder="admin.example.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>平台后台域名</label>
                    <input
                      value={form.platform_admin_domain}
                      onChange={(event) => setForm((prev) => ({ ...prev, platform_admin_domain: event.target.value }))}
                      placeholder="platform-admin.example.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>API 域名</label>
                    <input
                      value={form.api_domain}
                      onChange={(event) => setForm((prev) => ({ ...prev, api_domain: event.target.value }))}
                      placeholder="api.example.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>用户端域名</label>
                    <input
                      value={form.user_web_domain}
                      onChange={(event) => setForm((prev) => ({ ...prev, user_web_domain: event.target.value }))}
                      placeholder="www.example.com"
                    />
                  </div>
                </>
              )}

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
        </div>
      )}
    </div>
  );
}
