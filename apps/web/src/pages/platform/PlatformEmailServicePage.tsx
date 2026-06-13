import { useEffect, useMemo, useState } from 'react';
import {
  PlatformAppItem,
  PlatformEmailCfAccountItem,
  PlatformEmailCloudflareSendingDomain,
  PlatformEmailCloudflareTokenAccount,
  PlatformEmailSenderItem,
  platformApi,
} from '@/lib/api';
import { pickApiErrorMessage } from '@/lib/api-response';

type ModalMode = 'account' | 'sender' | 'sender-test' | '';

const EMPTY_ACCOUNT_FORM = {
  id: '',
  name: '',
  account_id: '',
  api_token: '',
  status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE',
  notes: '',
};

const EMPTY_SENDER_FORM = {
  id: '',
  cf_account_id: '',
  app_id: '',
  email: '',
  display_name: '',
  purpose: 'both' as 'marketing' | 'notification' | 'both',
  status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE',
  is_default: false,
};

export default function PlatformEmailServicePage() {
  const [accounts, setAccounts] = useState<PlatformEmailCfAccountItem[]>([]);
  const [senders, setSenders] = useState<PlatformEmailSenderItem[]>([]);
  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('');
  const [accountForm, setAccountForm] = useState(EMPTY_ACCOUNT_FORM);
  const [senderForm, setSenderForm] = useState(EMPTY_SENDER_FORM);
  const [testForm, setTestForm] = useState({ id: '', from: '', to: '' });
  const [verifyingToken, setVerifyingToken] = useState(false);
  const [tokenAccounts, setTokenAccounts] = useState<PlatformEmailCloudflareTokenAccount[]>([]);
  const [tokenChecked, setTokenChecked] = useState(false);
  const [senderDomains, setSenderDomains] = useState<PlatformEmailCloudflareSendingDomain[]>([]);
  const [loadingSenderDomains, setLoadingSenderDomains] = useState(false);
  const [accountTestResults, setAccountTestResults] = useState<Record<string, { type: 'success' | 'error'; text: string }>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const activeAccounts = useMemo(() => accounts.filter((item) => item.status === 'ACTIVE'), [accounts]);
  const sendersByAccountId = useMemo(() => {
    const grouped = new Map<string, PlatformEmailSenderItem[]>();
    accounts.forEach((account) => grouped.set(account.id, []));
    senders.forEach((sender) => {
      const accountSenders = grouped.get(sender.cf_account_id);
      if (accountSenders) {
        accountSenders.push(sender);
      }
    });
    return grouped;
  }, [accounts, senders]);
  const unmatchedSenders = useMemo(() => {
    const accountIds = new Set(accounts.map((account) => account.id));
    return senders.filter((sender) => !accountIds.has(sender.cf_account_id));
  }, [accounts, senders]);
  const availableSenderDomains = useMemo(() => {
    const currentDomain = emailDomain(senderForm.email);
    if (!currentDomain || senderDomains.some((item) => item.name === currentDomain)) return senderDomains;
    return [
      {
        id: currentDomain,
        name: currentDomain,
        enabled: true,
        zone_id: '',
        zone_name: currentDomain,
      },
      ...senderDomains,
    ];
  }, [senderForm.email, senderDomains]);

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [accountResp, senderResp, appResp] = await Promise.all([
        platformApi.listEmailCloudflareAccounts(),
        platformApi.listEmailSenders(),
        platformApi.listApps(true),
      ]);
      setAccounts(accountResp.items || []);
      setSenders(senderResp.items || []);
      setApps(appResp.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载邮件服务失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const openCreateAccount = () => {
    setAccountForm(EMPTY_ACCOUNT_FORM);
    setTokenAccounts([]);
    setTokenChecked(false);
    setModalMode('account');
  };

  const openEditAccount = (item: PlatformEmailCfAccountItem) => {
    setAccountForm({
      id: item.id,
      name: item.name,
      account_id: item.account_id,
      api_token: '',
      status: item.status,
      notes: item.notes || '',
    });
    setTokenAccounts([{ id: item.account_id, name: item.name, type: null }]);
    setTokenChecked(true);
    setModalMode('account');
  };

  const openCreateSender = (accountId?: string) => {
    setSenderForm({
      ...EMPTY_SENDER_FORM,
      cf_account_id: accountId || activeAccounts[0]?.id || accounts[0]?.id || '',
    });
    setSenderDomains([]);
    setModalMode('sender');
  };

  const openEditSender = (item: PlatformEmailSenderItem) => {
    setSenderForm({
      id: item.id,
      cf_account_id: item.cf_account_id,
      app_id: item.app_id || '',
      email: item.email,
      display_name: item.display_name || '',
      purpose: item.purpose,
      status: item.status,
      is_default: item.is_default,
    });
    setSenderDomains([]);
    setModalMode('sender');
  };

  useEffect(() => {
    if (modalMode !== 'sender' || !senderForm.cf_account_id) return;
    let cancelled = false;
    setLoadingSenderDomains(true);
    platformApi.listEmailCloudflareSendingDomains(senderForm.cf_account_id)
      .then((response) => {
        if (!cancelled) setSenderDomains(response.items || []);
      })
      .catch((error: any) => {
        if (!cancelled) {
          setSenderDomains([]);
          setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 Cloudflare 发件域名失败') });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSenderDomains(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modalMode, senderForm.cf_account_id]);

  const verifyAccountToken = async () => {
    if (!accountForm.api_token) {
      setMessage({ type: 'error', text: '请先填写 API Token' });
      return null;
    }
    setVerifyingToken(true);
    setMessage(null);
    try {
      const response = await platformApi.verifyEmailCloudflareToken({ api_token: accountForm.api_token });
      setTokenAccounts(response.accounts || []);
      setTokenChecked(true);
      if (response.accounts?.length === 1) {
        const account = response.accounts[0];
        setAccountForm((current) => ({
          ...current,
          account_id: account.id,
          name: current.name || account.name,
        }));
      }
      setMessage({ type: 'success', text: response.accounts?.length ? 'Cloudflare 令牌可用' : 'Cloudflare 令牌可用' });
      return response.accounts || [];
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '验证 Cloudflare 令牌失败') });
      return null;
    } finally {
      setVerifyingToken(false);
    }
  };

  const saveAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      if (accountForm.api_token && !accountForm.account_id) {
        const verifiedAccounts = await verifyAccountToken();
        if (!verifiedAccounts) return;
        if (verifiedAccounts.length > 1) {
          setMessage({ type: 'error', text: '请选择 Cloudflare 账号' });
          return;
        }
      }
      if (accountForm.id) {
        await platformApi.updateEmailCloudflareAccount(accountForm.id, {
          name: accountForm.name || undefined,
          account_id: accountForm.account_id || undefined,
          api_token: accountForm.api_token || undefined,
          status: accountForm.status,
          notes: accountForm.notes,
        });
      } else {
        await platformApi.createEmailCloudflareAccount({
          ...accountForm,
          name: accountForm.name || undefined,
          account_id: accountForm.account_id || undefined,
        });
      }
      setModalMode('');
      setMessage({ type: 'success', text: 'Cloudflare 账号已保存' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存 Cloudflare 账号失败') });
    } finally {
      setSaving(false);
    }
  };

  const saveSender = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        cf_account_id: senderForm.cf_account_id,
        app_id: senderForm.app_id || null,
        email: senderForm.email,
        display_name: senderForm.display_name,
        purpose: senderForm.purpose,
        status: senderForm.status,
        is_default: senderForm.is_default,
      };
      if (senderForm.id) {
        await platformApi.updateEmailSender(senderForm.id, payload);
      } else {
        await platformApi.createEmailSender(payload);
      }
      setModalMode('');
      setMessage({ type: 'success', text: '发件邮箱已保存' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存发件邮箱失败') });
    } finally {
      setSaving(false);
    }
  };

  const testAccount = async (item: PlatformEmailCfAccountItem) => {
    setMessage(null);
    setAccountTestResults((current) => ({ ...current, [item.id]: { type: 'success', text: '正在测试...' } }));
    setSaving(true);
    try {
      await platformApi.testEmailCloudflareAccount(item.id);
      setAccountTestResults((current) => ({ ...current, [item.id]: { type: 'success', text: `令牌可用，${new Date().toLocaleString()}` } }));
      await loadData();
    } catch (error: any) {
      setAccountTestResults((current) => ({
        ...current,
        [item.id]: { type: 'error', text: pickApiErrorMessage(error, '测试 Cloudflare 令牌失败') },
      }));
    } finally {
      setSaving(false);
    }
  };

  const openSenderTest = (item: PlatformEmailSenderItem) => {
    setTestForm({ id: item.id, from: item.email, to: '' });
    setModalMode('sender-test');
  };

  const testSender = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      await platformApi.testEmailSender(testForm.id, { to: testForm.to });
      setModalMode('');
      setMessage({ type: 'success', text: '测试邮件已发送' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '测试发送失败') });
    } finally {
      setSaving(false);
    }
  };

  const deleteAccount = async (item: PlatformEmailCfAccountItem) => {
    if (!window.confirm(`删除 Cloudflare 账号 ${item.name}？`)) return;
    setMessage(null);
    try {
      await platformApi.deleteEmailCloudflareAccount(item.id);
      setMessage({ type: 'success', text: 'Cloudflare 账号已删除' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除 Cloudflare 账号失败') });
    }
  };

  const deleteSender = async (item: PlatformEmailSenderItem) => {
    if (!window.confirm(`删除发件邮箱 ${item.email}？`)) return;
    setMessage(null);
    try {
      await platformApi.deleteEmailSender(item.id);
      setMessage({ type: 'success', text: '发件邮箱已删除' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除发件邮箱失败') });
    }
  };

  return (
    <div className="platform-page email-service-page">
      <div className="platform-page-head">
        <div>
          <h1>邮件服务</h1>
          <p>配置 Cloudflare 账号、发件邮箱和租户邮件发送能力。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadData()} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={openCreateAccount}>
            新建账号
          </button>
          <button className="btn btn-sm" type="button" onClick={() => openCreateSender()}>
            新建发件邮箱
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="email-service-summary">
        <div><span>Cloudflare 账号</span><strong>{accounts.length}</strong></div>
        <div><span>可用账号</span><strong>{activeAccounts.length}</strong></div>
        <div><span>发件邮箱</span><strong>{senders.length}</strong></div>
        <div><span>租户绑定</span><strong>{senders.filter((item) => item.app_id).length}</strong></div>
      </section>

      <section className="email-account-groups">
        {accounts.map((account) => {
          const accountSenders = sendersByAccountId.get(account.id) || [];
          return (
            <article className="card email-account-group" key={account.id}>
              <div className="email-account-head">
                <div className="email-account-main">
                  <div>
                    <h3>{account.name}</h3>
                    <code>{account.account_id}</code>
                  </div>
                  <span className={`status-tag ${account.status === 'ACTIVE' ? 'success' : 'muted'}`}>{account.status}</span>
                  <span className="muted-text">
                    最近测试：{account.last_verified_at ? new Date(account.last_verified_at).toLocaleString() : '-'}
                  </span>
                </div>
                <div className="btn-group email-account-actions">
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => openEditAccount(account)}>编辑账号</button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => void testAccount(account)} disabled={saving}>测试令牌</button>
                  <button className="btn btn-sm" type="button" onClick={() => openCreateSender(account.id)}>新建邮箱</button>
                  <button className="btn btn-danger btn-sm" type="button" onClick={() => void deleteAccount(account)}>删除</button>
                </div>
              </div>
              {accountTestResults[account.id] && (
                <div className={`email-inline-result ${accountTestResults[account.id].type}`}>
                  {accountTestResults[account.id].text}
                </div>
              )}

              <div className="email-sender-list">
                {accountSenders.map((sender) => (
                  <div className="email-sender-row" key={sender.id}>
                    <div className="email-sender-main">
                      <strong>{sender.display_name || sender.email}</strong>
                      <span>{sender.email}</span>
                    </div>
                    <span>{sender.app_slug || '全局'}</span>
                    <span>{purposeLabel(sender.purpose)}</span>
                    <span className={`status-tag ${sender.status === 'ACTIVE' ? 'success' : 'muted'}`}>{sender.status}</span>
                    <div className="btn-group">
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => openEditSender(sender)}>编辑</button>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => openSenderTest(sender)}>测试</button>
                      <button className="btn btn-danger btn-sm" type="button" onClick={() => void deleteSender(sender)}>删除</button>
                    </div>
                  </div>
                ))}
                {!accountSenders.length && <div className="email-empty-row">暂无发件邮箱</div>}
              </div>
            </article>
          );
        })}

        {!accounts.length && (
          <section className="card email-empty-card">
            <h3>暂无 Cloudflare 账号</h3>
            <button className="btn btn-sm" type="button" onClick={openCreateAccount}>新建账号</button>
          </section>
        )}

        {!!unmatchedSenders.length && (
          <article className="card email-account-group">
            <div className="email-account-head">
              <div className="email-account-main">
                <h3>未归属发件邮箱</h3>
                <span className="muted-text">{unmatchedSenders.length} 个邮箱需要重新选择账号</span>
              </div>
            </div>
            <div className="email-sender-list">
              {unmatchedSenders.map((sender) => (
                <div className="email-sender-row" key={sender.id}>
                  <div className="email-sender-main">
                    <strong>{sender.display_name || sender.email}</strong>
                    <span>{sender.email}</span>
                  </div>
                  <span>{sender.app_slug || '全局'}</span>
                  <span>{purposeLabel(sender.purpose)}</span>
                  <span className={`status-tag ${sender.status === 'ACTIVE' ? 'success' : 'muted'}`}>{sender.status}</span>
                  <div className="btn-group">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => openEditSender(sender)}>编辑</button>
                    <button className="btn btn-danger btn-sm" type="button" onClick={() => void deleteSender(sender)}>删除</button>
                  </div>
                </div>
              ))}
            </div>
          </article>
        )}
      </section>

      {modalMode === 'account' && (
        <div className="modal-overlay" onMouseDown={() => setModalMode('')}>
          <form className="modal modal-lg email-service-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={saveAccount}>
            <div className="platform-section-head">
              <h3>{accountForm.id ? '编辑 Cloudflare 账号' : '新建 Cloudflare 账号'}</h3>
            </div>
            <div className="email-service-link-row">
              <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">打开 Cloudflare 控制台</a>
              <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">创建 API Token</a>
            </div>
            <label>API Token<input type="password" autoComplete="current-password" value={accountForm.api_token} onChange={(event) => {
              setAccountForm({ ...accountForm, api_token: event.target.value, account_id: accountForm.id ? accountForm.account_id : '' });
              setTokenAccounts(accountForm.id ? tokenAccounts : []);
              setTokenChecked(Boolean(accountForm.id));
            }} required={!accountForm.id} placeholder={accountForm.id ? '留空则不修改' : ''} /></label>
            <button className="btn btn-secondary btn-sm email-token-test-button" type="button" onClick={() => void verifyAccountToken()} disabled={verifyingToken || !accountForm.api_token}>
              {verifyingToken ? '验证中...' : '验证令牌'}
            </button>
            {!!tokenAccounts.length && (
              <label>Cloudflare 账号<select value={accountForm.account_id} onChange={(event) => {
                const selected = tokenAccounts.find((item) => item.id === event.target.value);
                setAccountForm({ ...accountForm, account_id: event.target.value, name: accountForm.name || selected?.name || '' });
              }} required>
                <option value="">请选择</option>
                {tokenAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
            )}
            {tokenChecked && !tokenAccounts.length && (
              <details className="email-account-id-fallback">
                <summary>手动填写 Account ID</summary>
                <label>Account ID<input value={accountForm.account_id} onChange={(event) => setAccountForm({ ...accountForm, account_id: event.target.value.trim() })} placeholder="例如 0998d32bbb869d9bb21c5d9788fb04e4" pattern="[0-9a-fA-F]{32}" /></label>
              </details>
            )}
            <label>名称<input value={accountForm.name} onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })} placeholder="默认使用 Cloudflare 账号名称" /></label>
            <label>状态<select value={accountForm.status} onChange={(event) => setAccountForm({ ...accountForm, status: event.target.value as 'ACTIVE' | 'INACTIVE' })}><option value="ACTIVE">ACTIVE</option><option value="INACTIVE">INACTIVE</option></select></label>
            <label>备注<textarea rows={3} value={accountForm.notes} onChange={(event) => setAccountForm({ ...accountForm, notes: event.target.value })} /></label>
            <div className="modal-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setModalMode('')}>取消</button>
              <button className="btn btn-sm" type="submit" disabled={saving}>{saving ? '保存中...' : '保存'}</button>
            </div>
          </form>
        </div>
      )}

      {modalMode === 'sender' && (
        <div className="modal-overlay" onMouseDown={() => setModalMode('')}>
          <form className="modal modal-lg email-service-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={saveSender}>
            <div className="platform-section-head">
              <h3>{senderForm.id ? '编辑发件邮箱' : '新建发件邮箱'}</h3>
            </div>
            <label>Cloudflare 账号<select value={senderForm.cf_account_id} onChange={(event) => setSenderForm({ ...senderForm, cf_account_id: event.target.value })} required>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>租户<select value={senderForm.app_id} onChange={(event) => setSenderForm({ ...senderForm, app_id: event.target.value })}><option value="">全局</option>{apps.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.slug})</option>)}</select></label>
            <label>邮箱
              {availableSenderDomains.length ? (
                <div className="email-address-builder">
                  <input value={emailLocalPart(senderForm.email)} onChange={(event) => setSenderForm({ ...senderForm, email: buildEmail(event.target.value, emailDomain(senderForm.email) || availableSenderDomains[0]?.name || '') })} required />
                  <span>@</span>
                  <select value={emailDomain(senderForm.email) || availableSenderDomains[0]?.name || ''} onChange={(event) => setSenderForm({ ...senderForm, email: buildEmail(emailLocalPart(senderForm.email), event.target.value) })} required>
                    {availableSenderDomains.map((item) => <option key={item.id} value={item.name}>{item.name}{item.enabled ? '' : ' (未启用)'}</option>)}
                  </select>
                </div>
              ) : (
                <input type="email" value={senderForm.email} onChange={(event) => setSenderForm({ ...senderForm, email: event.target.value })} required placeholder={loadingSenderDomains ? '正在加载 Cloudflare 域名...' : ''} />
              )}
            </label>
            <label>显示名<input value={senderForm.display_name} onChange={(event) => setSenderForm({ ...senderForm, display_name: event.target.value })} /></label>
            <label>用途<select value={senderForm.purpose} onChange={(event) => setSenderForm({ ...senderForm, purpose: event.target.value as any })}><option value="both">通用</option><option value="marketing">营销</option><option value="notification">通知</option></select></label>
            <label>状态<select value={senderForm.status} onChange={(event) => setSenderForm({ ...senderForm, status: event.target.value as 'ACTIVE' | 'INACTIVE' })}><option value="ACTIVE">ACTIVE</option><option value="INACTIVE">INACTIVE</option></select></label>
            <label className="inline-check"><input type="checkbox" checked={senderForm.is_default} onChange={(event) => setSenderForm({ ...senderForm, is_default: event.target.checked })} />默认发件邮箱</label>
            <div className="modal-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setModalMode('')}>取消</button>
              <button className="btn btn-sm" type="submit" disabled={saving}>{saving ? '保存中...' : '保存'}</button>
            </div>
          </form>
        </div>
      )}

      {modalMode === 'sender-test' && (
        <div className="modal-overlay" onMouseDown={() => setModalMode('')}>
          <form className="modal email-service-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={testSender}>
            <div className="platform-section-head"><h3>测试发件邮箱</h3></div>
            <label>发件邮箱<input value={testForm.from} disabled /></label>
            <label>收件邮箱<input type="email" value={testForm.to} onChange={(event) => setTestForm({ ...testForm, to: event.target.value })} required /></label>
            <div className="modal-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setModalMode('')}>取消</button>
              <button className="btn btn-sm" type="submit" disabled={saving}>{saving ? '发送中...' : '发送测试'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function purposeLabel(value: PlatformEmailSenderItem['purpose']) {
  if (value === 'marketing') return '营销';
  if (value === 'notification') return '通知';
  return '通用';
}

function emailLocalPart(value: string) {
  return value.includes('@') ? value.split('@')[0] : value;
}

function emailDomain(value: string) {
  return value.includes('@') ? value.split('@').slice(1).join('@') : '';
}

function buildEmail(localPart: string, domain: string) {
  const normalizedLocal = localPart.trim().replace(/@.*/, '');
  return normalizedLocal && domain ? `${normalizedLocal}@${domain}` : normalizedLocal;
}
