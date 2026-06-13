import { useEffect, useState } from 'react';
import {
  platformApi,
  PlatformAgentBindingItem,
  PlatformAgentItem,
  PlatformAgentRunItem,
  PlatformAgentTestResult,
  PlatformAiModelItem,
  PlatformAgentToolCatalogItem,
  PlatformAgentToolPackItem,
  PlatformAppItem,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

type ToolFormRow = {
  tool_key: string;
  is_enabled: boolean;
  config_text: string;
  tool_pack?: string;
};

type AgentFormState = {
  slug: string;
  name: string;
  description: string;
  scope: 'global' | 'app';
  owner_app_id: string;
  visibility: 'private' | 'internal' | 'public';
  system_prompt_template: string;
  developer_prompt_template: string;
  default_model: string;
  max_steps: string;
  max_tool_calls: string;
  timeout_ms: string;
  output_mode: 'text' | 'json';
  input_schema_text: string;
  output_schema_text: string;
  tool_policy_text: string;
  enabled_tool_packs: string[];
};

type BindingFormState = {
  app_id: string;
  route_slug: string;
  is_enabled: boolean;
  auth_policy: 'public' | 'user' | 'admin';
  points_cost: string;
  model_override: string;
  system_prompt_override: string;
  tool_override_text: string;
  enabled_tool_packs: string[];
};

type DebugFormState = {
  app_id: string;
  user_id: string;
  input: string;
  variables_text: string;
  debug: boolean;
};

const EMPTY_AGENT_FORM: AgentFormState = {
  slug: '',
  name: '',
  description: '',
  scope: 'global',
  owner_app_id: '',
  visibility: 'private',
  system_prompt_template: 'You are a reusable AI agent. Think carefully and use tools only when necessary.',
  developer_prompt_template: '',
  default_model: '',
  max_steps: '6',
  max_tool_calls: '8',
  timeout_ms: '60000',
  output_mode: 'text',
  input_schema_text: '{}',
  output_schema_text: '{}',
  tool_policy_text: '{}',
  enabled_tool_packs: [],
};

const EMPTY_BINDING_FORM: BindingFormState = {
  app_id: '',
  route_slug: '',
  is_enabled: true,
  auth_policy: 'user',
  points_cost: '0',
  model_override: '',
  system_prompt_override: '',
  tool_override_text: '{}',
  enabled_tool_packs: [],
};

const EMPTY_DEBUG_FORM: DebugFormState = {
  app_id: '',
  user_id: '',
  input: '',
  variables_text: '{}',
  debug: true,
};

function parseJsonObject(input: string, fieldName: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldName} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function buildToolRows(
  toolCatalog: PlatformAgentToolCatalogItem[],
  detail?: PlatformAgentItem | null,
): ToolFormRow[] {
  const map = new Map(
    (detail?.latest_version_detail?.tool_bindings || []).map((item) => [
      item.tool_key,
      { is_enabled: item.is_enabled, config_text: JSON.stringify(item.config_json || {}, null, 2) },
    ]),
  );
  return toolCatalog.map((tool) => ({
    tool_key: tool.key,
    is_enabled: map.get(tool.key)?.is_enabled || false,
    config_text: map.get(tool.key)?.config_text || '{}',
    tool_pack: tool.tool_pack,
  }));
}

function syncFormFromDetail(detail?: PlatformAgentItem | null): AgentFormState {
  if (!detail?.latest_version_detail) {
    return EMPTY_AGENT_FORM;
  }
  const version = detail.latest_version_detail;
  return {
    slug: detail.slug,
    name: detail.name,
    description: detail.description || '',
    scope: detail.scope || 'global',
    owner_app_id: detail.owner_app_id || '',
    visibility: detail.visibility,
    system_prompt_template: version.system_prompt_template || '',
    developer_prompt_template: version.developer_prompt_template || '',
    default_model: version.default_model || '',
    max_steps: String(version.max_steps || 6),
    max_tool_calls: String(version.max_tool_calls || 8),
    timeout_ms: String(version.timeout_ms || 60000),
    output_mode: version.output_mode || 'text',
    input_schema_text: JSON.stringify(version.input_schema_json || {}, null, 2),
    output_schema_text: JSON.stringify(version.output_schema_json || {}, null, 2),
    tool_policy_text: JSON.stringify(version.tool_policy_json || {}, null, 2),
    enabled_tool_packs: Array.isArray((version.tool_policy_json as any)?.enabled_tool_packs)
      ? ((version.tool_policy_json as any).enabled_tool_packs as unknown[]).map((item) => String(item))
      : [],
  };
}

export default function PlatformAgentsPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [agents, setAgents] = useState<PlatformAgentItem[]>([]);
  const [agentDetail, setAgentDetail] = useState<PlatformAgentItem | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [apps, setApps] = useState<PlatformAppItem[]>([]);
  const [chatModels, setChatModels] = useState<PlatformAiModelItem[]>([]);
  const [toolPacks, setToolPacks] = useState<PlatformAgentToolPackItem[]>([]);
  const [toolCatalog, setToolCatalog] = useState<PlatformAgentToolCatalogItem[]>([]);
  const [toolRows, setToolRows] = useState<ToolFormRow[]>([]);
  const [runs, setRuns] = useState<PlatformAgentRunItem[]>([]);
  const [form, setForm] = useState<AgentFormState>(EMPTY_AGENT_FORM);
  const [bindingForm, setBindingForm] = useState<BindingFormState>(EMPTY_BINDING_FORM);
  const [debugForm, setDebugForm] = useState<DebugFormState>(EMPTY_DEBUG_FORM);
  const [debugResult, setDebugResult] = useState<PlatformAgentTestResult | null>(null);

  const loadBase = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [agentsPayload, toolsPayload, appsPayload, modelsPayload] = await Promise.all([
        platformApi.listPlatformAgents(),
        platformApi.listPlatformAgentTools(),
        platformApi.listApps(true),
        platformApi.listGlobalAiModels(),
      ]);
      const nextAgents = pickApiData<{ items: PlatformAgentItem[] }>(agentsPayload).items || [];
      const toolPayload = pickApiData<{ packs: PlatformAgentToolPackItem[]; items: PlatformAgentToolCatalogItem[] }>(toolsPayload);
      const nextTools = toolPayload.items || [];
      const nextApps = pickApiData<{ items: PlatformAppItem[] }>(appsPayload).items || [];
      const nextModels = (pickApiData<{ items: PlatformAiModelItem[] }>(modelsPayload).items || [])
        .filter((item) => item.capability === 'chat');
      setAgents(nextAgents);
      setToolPacks(toolPayload.packs || []);
      setToolCatalog(nextTools);
      setApps(nextApps);
      setChatModels(nextModels);
      if (!selectedAgentId && nextAgents[0]?.id) {
        setSelectedAgentId(nextAgents[0].id);
      }
      if (!nextAgents.length) {
        setAgentDetail(null);
        setForm(EMPTY_AGENT_FORM);
        setBindingForm(EMPTY_BINDING_FORM);
        setToolRows(buildToolRows(nextTools, null));
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 Agent 中心失败') });
    } finally {
      setLoading(false);
    }
  };

  const loadAgentDetail = async (agentId: string) => {
    if (!agentId) {
      setAgentDetail(null);
      setRuns([]);
      setForm(EMPTY_AGENT_FORM);
      setBindingForm(EMPTY_BINDING_FORM);
      setToolRows(buildToolRows(toolCatalog, null));
      return;
    }
    setLoading(true);
    try {
      const [detailPayload, runsPayload] = await Promise.all([
        platformApi.getPlatformAgent(agentId),
        platformApi.listPlatformAgentRuns({ agent_id: agentId, page: 1, page_size: 10 }),
      ]);
      const detail = pickApiData<PlatformAgentItem>(detailPayload);
      const runItems = pickApiData<{ items: PlatformAgentRunItem[] }>(runsPayload).items || [];
      setAgentDetail(detail);
      setRuns(runItems);
      setForm(syncFormFromDetail(detail));
      setToolRows(buildToolRows(toolCatalog, detail));
      const firstBinding = detail.bindings?.[0];
      setBindingForm({
        app_id: firstBinding?.app_id || '',
        route_slug: firstBinding?.route_slug || detail.slug,
        is_enabled: firstBinding?.is_enabled ?? true,
        auth_policy: firstBinding?.auth_policy || 'user',
        points_cost: String(firstBinding?.points_cost ?? 0),
        model_override: firstBinding?.model_override || '',
        system_prompt_override: firstBinding?.system_prompt_override || '',
        tool_override_text: JSON.stringify(firstBinding?.tool_override_json || {}, null, 2),
        enabled_tool_packs: Array.isArray((firstBinding?.tool_override_json as any)?.enabled_tool_packs)
          ? ((firstBinding?.tool_override_json as any).enabled_tool_packs as unknown[]).map((item) => String(item))
          : [],
      });
      setDebugForm((prev) => ({
        ...prev,
        app_id: firstBinding?.app_id || '',
      }));
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 Agent 详情失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBase();
  }, []);

  useEffect(() => {
    if (!toolCatalog.length) {
      return;
    }
    void loadAgentDetail(selectedAgentId);
  }, [selectedAgentId, toolCatalog.length]);

  const handleNewAgent = () => {
    setSelectedAgentId('');
    setAgentDetail(null);
    setForm(EMPTY_AGENT_FORM);
    setBindingForm(EMPTY_BINDING_FORM);
    setToolRows(buildToolRows(toolCatalog, null));
    setRuns([]);
    setDebugForm(EMPTY_DEBUG_FORM);
    setDebugResult(null);
  };

  const toggleTemplatePack = (packKey: string, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      enabled_tool_packs: checked
        ? Array.from(new Set([...prev.enabled_tool_packs, packKey]))
        : prev.enabled_tool_packs.filter((item) => item !== packKey),
    }));
  };

  const toggleBindingPack = (packKey: string, checked: boolean) => {
    setBindingForm((prev) => ({
      ...prev,
      enabled_tool_packs: checked
        ? Array.from(new Set([...prev.enabled_tool_packs, packKey]))
        : prev.enabled_tool_packs.filter((item) => item !== packKey),
    }));
  };

  const handleSaveAgent = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const toolPolicyJson = parseJsonObject(form.tool_policy_text, '工具策略');
      toolPolicyJson.enabled_tool_packs = form.enabled_tool_packs;
      const payload = {
        slug: form.slug,
        name: form.name,
        description: form.description || undefined,
        scope: form.scope,
        owner_app_id: form.scope === 'app' ? form.owner_app_id || undefined : undefined,
        visibility: form.visibility,
        system_prompt_template: form.system_prompt_template,
        developer_prompt_template: form.developer_prompt_template || undefined,
        default_model: form.default_model || undefined,
        max_steps: Number(form.max_steps || 6),
        max_tool_calls: Number(form.max_tool_calls || 8),
        timeout_ms: Number(form.timeout_ms || 60000),
        output_mode: form.output_mode,
        input_schema_json: parseJsonObject(form.input_schema_text, '输入 schema'),
        output_schema_json: parseJsonObject(form.output_schema_text, '输出 schema'),
        tool_policy_json: toolPolicyJson,
        tools: toolRows.map((row) => ({
          tool_key: row.tool_key,
          is_enabled: row.is_enabled,
          config_json: parseJsonObject(row.config_text, `工具 ${row.tool_key} 配置`),
        })),
      };
      const saved = selectedAgentId
        ? await platformApi.updatePlatformAgent(selectedAgentId, payload)
        : await platformApi.createPlatformAgent(payload);
      const detail = pickApiData<PlatformAgentItem>(saved);
      setSelectedAgentId(detail.id);
      setMessage({ type: 'success', text: selectedAgentId ? 'Agent 已生成新版本' : 'Agent 创建成功' });
      await loadBase();
      await loadAgentDetail(detail.id);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存 Agent 失败') });
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    setMessage(null);
    try {
      await platformApi.publishPlatformAgent(selectedAgentId);
      setMessage({ type: 'success', text: 'Agent 已发布' });
      await loadBase();
      await loadAgentDetail(selectedAgentId);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '发布 Agent 失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    setMessage(null);
    try {
      await platformApi.archivePlatformAgent(selectedAgentId);
      setMessage({ type: 'success', text: 'Agent 已归档' });
      await loadBase();
      await loadAgentDetail(selectedAgentId);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '归档 Agent 失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedAgentId) return;
    if (!window.confirm('确认删除这个 Agent 吗？此操作不可撤销。')) {
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await platformApi.deletePlatformAgent(selectedAgentId);
      setMessage({ type: 'success', text: 'Agent 已删除' });
      setSelectedAgentId('');
      await loadBase();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除 Agent 失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBinding = async () => {
    if (!agentDetail || !bindingForm.app_id) {
      setMessage({ type: 'error', text: '请先选择要发布到的租户' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const toolOverrideJson = parseJsonObject(bindingForm.tool_override_text, '绑定工具覆盖');
      toolOverrideJson.enabled_tool_packs = bindingForm.enabled_tool_packs;
      await platformApi.upsertAppAgentBinding(bindingForm.app_id, agentDetail.id, {
        route_slug: bindingForm.route_slug || agentDetail.slug,
        is_enabled: bindingForm.is_enabled,
        auth_policy: bindingForm.auth_policy,
        points_cost: Number(bindingForm.points_cost || 0),
        model_override: bindingForm.model_override || undefined,
        system_prompt_override: bindingForm.system_prompt_override || undefined,
        tool_override_json: toolOverrideJson,
      });
      setMessage({ type: 'success', text: '租户绑定已保存' });
      await loadAgentDetail(agentDetail.id);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存租户绑定失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteBinding = async (binding: PlatformAgentBindingItem) => {
    if (!agentDetail) return;
    if (!window.confirm(`确认移除 ${binding.app_name || binding.app_id} 的 Agent 绑定吗？`)) {
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await platformApi.deleteAppAgentBinding(binding.app_id, agentDetail.id);
      setMessage({ type: 'success', text: '租户绑定已删除' });
      await loadAgentDetail(agentDetail.id);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除租户绑定失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleDebugRun = async () => {
    if (!agentDetail) {
      setMessage({ type: 'error', text: '请先选择 Agent' });
      return;
    }
    if (!debugForm.app_id) {
      setMessage({ type: 'error', text: '请先选择调试租户' });
      return;
    }
    if (!debugForm.input.trim()) {
      setMessage({ type: 'error', text: '请输入调试输入' });
      return;
    }
    setSaving(true);
    setMessage(null);
    setDebugResult(null);
    try {
      const result = await platformApi.testPlatformAgent(agentDetail.id, {
        app_id: debugForm.app_id,
        user_id: debugForm.user_id.trim() || undefined,
        input: debugForm.input,
        variables: parseJsonObject(debugForm.variables_text, '调试变量'),
        debug: debugForm.debug,
      });
      setDebugResult(result);
      setMessage({ type: 'success', text: 'Agent 调试执行完成' });
      await loadAgentDetail(agentDetail.id);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, 'Agent 调试执行失败') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Agent 中心</h1>
        <p>统一管理平台 Agent、版本配置、租户发布绑定与运行日志。</p>
      </div>

      {message ? <div className={`alert alert-${message.type}`}>{message.text}</div> : null}

      <div className="agent-hub">
        <section className="card agent-hub__sidebar">
          <div className="platform-section-head">
            <h3>Agent 列表</h3>
            <button className="btn" type="button" onClick={handleNewAgent}>新建 Agent</button>
          </div>
          <div className="agent-hub__list">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`agent-hub__list-item ${selectedAgentId === agent.id ? 'active' : ''}`}
                onClick={() => setSelectedAgentId(agent.id)}
              >
                <strong>{agent.name}</strong>
                <span>{agent.slug}</span>
                <span>{agent.scope === 'app' ? 'app 专属' : '全局通用'} · {agent.status} · {agent.binding_count || 0} 个绑定</span>
              </button>
            ))}
            {!agents.length && !loading ? <div className="loading">暂无 Agent</div> : null}
          </div>
        </section>

        <section className="agent-hub__main">
          <section className="card">
            <div className="platform-section-head">
              <h3>{selectedAgentId ? '编辑 Agent' : '创建 Agent'}</h3>
              <div className="btn-group">
                {selectedAgentId ? <button className="btn btn-secondary btn-sm" type="button" onClick={handlePublish}>发布</button> : null}
                {selectedAgentId ? <button className="btn btn-secondary btn-sm" type="button" onClick={handleArchive}>归档</button> : null}
                {selectedAgentId ? <button className="btn btn-secondary btn-sm" type="button" onClick={handleDelete}>删除</button> : null}
                <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveAgent} disabled={saving}>
                  {saving ? '保存中...' : '保存 Agent'}
                </button>
              </div>
            </div>

            <div className="agent-hub__form-grid">
              <div className="form-group">
                <label>Slug</label>
                <input value={form.slug} onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>名称</label>
                <input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Agent 类型</label>
                <select value={form.scope} onChange={(e) => setForm((prev) => ({ ...prev, scope: e.target.value as AgentFormState['scope'] }))}>
                  <option value="global">全局通用</option>
                  <option value="app">App 专属</option>
                </select>
              </div>
              <div className="form-group">
                <label>所属 App</label>
                <select
                  value={form.owner_app_id}
                  onChange={(e) => setForm((prev) => ({ ...prev, owner_app_id: e.target.value }))}
                  disabled={form.scope !== 'app'}
                >
                  <option value="">{form.scope === 'app' ? '请选择所属 App' : '仅 app 专属 Agent 需要'}</option>
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>{app.name} ({app.slug})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>可见性</label>
                <select value={form.visibility} onChange={(e) => setForm((prev) => ({ ...prev, visibility: e.target.value as AgentFormState['visibility'] }))}>
                  <option value="private">private</option>
                  <option value="internal">internal</option>
                  <option value="public">public</option>
                </select>
              </div>
              <div className="form-group">
                <label>默认模型键</label>
                <select value={form.default_model} onChange={(e) => setForm((prev) => ({ ...prev, default_model: e.target.value }))}>
                  <option value="">留空，走 app 默认 chat 模型</option>
                  {chatModels.map((model) => (
                    <option key={model.id} value={model.model_key}>
                      {model.display_name} ({model.model_key}){model.is_visible ? '' : ' · 已隐藏'}{model.is_active ? '' : ' · 已停用'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group form-group--full">
                <label>描述</label>
                <textarea value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} rows={2} />
              </div>
              <div className="form-group form-group--full">
                <label>System Prompt</label>
                <textarea value={form.system_prompt_template} onChange={(e) => setForm((prev) => ({ ...prev, system_prompt_template: e.target.value }))} rows={6} />
              </div>
              <div className="form-group form-group--full">
                <label>Developer Prompt</label>
                <textarea value={form.developer_prompt_template} onChange={(e) => setForm((prev) => ({ ...prev, developer_prompt_template: e.target.value }))} rows={4} />
              </div>
              <div className="form-group">
                <label>Max Steps</label>
                <input value={form.max_steps} onChange={(e) => setForm((prev) => ({ ...prev, max_steps: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Max Tool Calls</label>
                <input value={form.max_tool_calls} onChange={(e) => setForm((prev) => ({ ...prev, max_tool_calls: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Timeout ms</label>
                <input value={form.timeout_ms} onChange={(e) => setForm((prev) => ({ ...prev, timeout_ms: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>输出模式</label>
                <select value={form.output_mode} onChange={(e) => setForm((prev) => ({ ...prev, output_mode: e.target.value as AgentFormState['output_mode'] }))}>
                  <option value="text">text</option>
                  <option value="json">json</option>
                </select>
              </div>
              <div className="form-group">
                <label>Input Schema</label>
                <textarea value={form.input_schema_text} onChange={(e) => setForm((prev) => ({ ...prev, input_schema_text: e.target.value }))} rows={5} />
              </div>
              <div className="form-group">
                <label>Output Schema</label>
                <textarea value={form.output_schema_text} onChange={(e) => setForm((prev) => ({ ...prev, output_schema_text: e.target.value }))} rows={5} />
              </div>
              <div className="form-group">
                <label>Tool Policy JSON</label>
                <textarea value={form.tool_policy_text} onChange={(e) => setForm((prev) => ({ ...prev, tool_policy_text: e.target.value }))} rows={5} />
              </div>
              <div className="form-group form-group--full">
                <label>Template Tool Packs</label>
                <div className="agent-pack-grid">
                  {toolPacks.map((pack) => (
                    <label key={pack.key} className="agent-pack-card">
                      <input
                        type="checkbox"
                        checked={form.enabled_tool_packs.includes(pack.key)}
                        onChange={(e) => toggleTemplatePack(pack.key, e.target.checked)}
                      />
                      <div>
                        <strong>{pack.name}</strong>
                        <span>{pack.key}</span>
                        <p>{pack.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="platform-section-head">
              <h3>工具绑定</h3>
            </div>
            <div className="agent-tool-grid">
              {toolCatalog.map((tool, index) => (
                <div className="agent-tool-card" key={tool.key}>
                  <label className="agent-tool-card__head">
                    <input
                      type="checkbox"
                      checked={toolRows[index]?.is_enabled || false}
                      onChange={(e) => setToolRows((prev) => prev.map((row, rowIndex) => rowIndex === index ? { ...row, is_enabled: e.target.checked } : row))}
                    />
                    <div>
                      <strong>{tool.name}</strong>
                      <span>{tool.key}</span>
                      <span>{tool.tool_pack} · {tool.safety_level}</span>
                    </div>
                  </label>
                  <p>{tool.description}</p>
                  <textarea
                    rows={4}
                    value={toolRows[index]?.config_text || '{}'}
                    onChange={(e) => setToolRows((prev) => prev.map((row, rowIndex) => rowIndex === index ? { ...row, config_text: e.target.value } : row))}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="platform-section-head">
              <h3>租户发布绑定</h3>
              <button className="btn btn-secondary btn-sm" type="button" onClick={handleSaveBinding} disabled={!agentDetail || saving}>
                保存绑定
              </button>
            </div>
            <div className="agent-hub__form-grid">
              <div className="form-group">
                <label>目标租户</label>
                <select value={bindingForm.app_id} onChange={(e) => setBindingForm((prev) => ({ ...prev, app_id: e.target.value }))}>
                  <option value="">请选择租户</option>
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>{app.name} ({app.slug})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>路由 Slug</label>
                <input value={bindingForm.route_slug} onChange={(e) => setBindingForm((prev) => ({ ...prev, route_slug: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>鉴权策略</label>
                <select value={bindingForm.auth_policy} onChange={(e) => setBindingForm((prev) => ({ ...prev, auth_policy: e.target.value as BindingFormState['auth_policy'] }))}>
                  <option value="public">public</option>
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </div>
              <div className="form-group">
                <label>单次积分</label>
                <input value={bindingForm.points_cost} onChange={(e) => setBindingForm((prev) => ({ ...prev, points_cost: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>模型覆盖</label>
                <select value={bindingForm.model_override} onChange={(e) => setBindingForm((prev) => ({ ...prev, model_override: e.target.value }))}>
                  <option value="">留空，沿用 Agent 默认模型</option>
                  {chatModels.map((model) => (
                    <option key={model.id} value={model.model_key}>
                      {model.display_name} ({model.model_key}){model.is_visible ? '' : ' · 已隐藏'}{model.is_active ? '' : ' · 已停用'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>启用状态</label>
                <select value={bindingForm.is_enabled ? 'true' : 'false'} onChange={(e) => setBindingForm((prev) => ({ ...prev, is_enabled: e.target.value === 'true' }))}>
                  <option value="true">enabled</option>
                  <option value="false">disabled</option>
                </select>
              </div>
              <div className="form-group form-group--full">
                <label>System Prompt Override</label>
                <textarea value={bindingForm.system_prompt_override} onChange={(e) => setBindingForm((prev) => ({ ...prev, system_prompt_override: e.target.value }))} rows={3} />
              </div>
              <div className="form-group form-group--full">
                <label>Tool Override JSON</label>
                <textarea value={bindingForm.tool_override_text} onChange={(e) => setBindingForm((prev) => ({ ...prev, tool_override_text: e.target.value }))} rows={4} />
              </div>
              <div className="form-group form-group--full">
                <label>Binding Tool Packs Override</label>
                <div className="agent-pack-grid">
                  {toolPacks.map((pack) => (
                    <label key={pack.key} className="agent-pack-card">
                      <input
                        type="checkbox"
                        checked={bindingForm.enabled_tool_packs.includes(pack.key)}
                        onChange={(e) => toggleBindingPack(pack.key, e.target.checked)}
                      />
                      <div>
                        <strong>{pack.name}</strong>
                        <span>{pack.key}</span>
                        <p>{pack.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="platform-api-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>租户</th>
                    <th>路由</th>
                    <th>鉴权</th>
                    <th>积分</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(agentDetail?.bindings || []).map((binding) => (
                    <tr key={binding.id}>
                      <td>{binding.app_name || binding.app_slug || binding.app_id}</td>
                      <td>{binding.route_slug}</td>
                      <td>{binding.auth_policy}</td>
                      <td>{binding.points_cost}</td>
                      <td>{binding.is_enabled ? 'enabled' : 'disabled'}</td>
                      <td>
                        <div className="btn-group">
                          <button
                            className="btn btn-secondary btn-sm"
                            type="button"
                            onClick={() => setBindingForm({
                              app_id: binding.app_id,
                              route_slug: binding.route_slug,
                              is_enabled: binding.is_enabled,
                              auth_policy: binding.auth_policy,
                              points_cost: String(binding.points_cost),
                              model_override: binding.model_override || '',
                              system_prompt_override: binding.system_prompt_override || '',
                              tool_override_text: JSON.stringify(binding.tool_override_json || {}, null, 2),
                              enabled_tool_packs: Array.isArray((binding.tool_override_json as any)?.enabled_tool_packs)
                                ? ((binding.tool_override_json as any).enabled_tool_packs as unknown[]).map((item) => String(item))
                                : [],
                            })}
                          >
                            载入
                          </button>
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleDeleteBinding(binding)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!agentDetail?.bindings?.length ? (
                    <tr>
                      <td colSpan={6}>暂无绑定</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="platform-section-head">
              <h3>最近运行</h3>
            </div>
            <div className="platform-api-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>租户</th>
                    <th>输入</th>
                    <th>输出</th>
                    <th>工具数</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>{run.status}</td>
                      <td>{run.app_slug}</td>
                      <td>{String(run.input_text || '').slice(0, 80) || '-'}</td>
                      <td>{String(run.output_text || '').slice(0, 80) || '-'}</td>
                      <td>{run.total_tool_calls}</td>
                      <td>{run.created_at ? new Date(run.created_at).toLocaleString() : '-'}</td>
                    </tr>
                  ))}
                  {!runs.length ? (
                    <tr>
                      <td colSpan={6}>暂无运行记录</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="platform-section-head">
              <h3>健康测试</h3>
              <button className="btn btn-secondary btn-sm" type="button" onClick={handleDebugRun} disabled={!agentDetail || saving}>
                执行健康测试
              </button>
            </div>
            <div className="agent-hub__form-grid">
              <div className="form-group">
                <label>调试租户</label>
                <select value={debugForm.app_id} onChange={(e) => setDebugForm((prev) => ({ ...prev, app_id: e.target.value }))}>
                  <option value="">请选择租户</option>
                  {(agentDetail?.bindings || []).map((binding) => (
                    <option key={binding.id} value={binding.app_id}>
                      {binding.app_name || binding.app_slug || binding.app_id} ({binding.route_slug})
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>用户 ID（可选）</label>
                <input value={debugForm.user_id} onChange={(e) => setDebugForm((prev) => ({ ...prev, user_id: e.target.value }))} placeholder="需要调用用户级工具时填写" />
              </div>
              <div className="form-group form-group--full">
                <label>输入</label>
                <textarea value={debugForm.input} onChange={(e) => setDebugForm((prev) => ({ ...prev, input: e.target.value }))} rows={4} />
              </div>
              <div className="form-group form-group--full">
                <label>变量 JSON</label>
                <textarea value={debugForm.variables_text} onChange={(e) => setDebugForm((prev) => ({ ...prev, variables_text: e.target.value }))} rows={4} />
              </div>
            </div>
            {debugResult ? (
              <div className="agent-debug-result">
                <div className="agent-debug-result__meta">
                  <span>run_id: {debugResult.run_id}</span>
                  <span>tool_calls: {debugResult.total_tool_calls}</span>
                  <span>tokens: {debugResult.usage.prompt_tokens + debugResult.usage.completion_tokens}</span>
                </div>
                <div className="form-group">
                  <label>输出文本</label>
                  <textarea value={debugResult.output_text || ''} rows={6} readOnly />
                </div>
                <div className="form-group">
                  <label>输出 JSON</label>
                  <textarea value={JSON.stringify(debugResult.output_json || {}, null, 2)} rows={8} readOnly />
                </div>
                <div className="form-group">
                  <label>步骤日志</label>
                  <textarea value={JSON.stringify(debugResult.steps || [], null, 2)} rows={10} readOnly />
                </div>
              </div>
            ) : null}
          </section>
        </section>
      </div>
    </div>
  );
}
