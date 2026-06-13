import { useMemo, useState } from 'react';
import { PlatformAppItem } from '@/lib/api';
import {
  GENERATED_API_DOC_MODULES,
  GeneratedApiDocModule,
  GeneratedApiDocRoute,
  GeneratedApiRouteAuth,
  GeneratedApiRouteScope,
} from '@/config/generated-api-docs';

type Props = {
  app: PlatformAppItem | null;
};

type AudienceGroupKey = 'tenant-user' | 'tenant-admin' | 'public' | 'compat';
type ApiDocsTab = 'all' | 'ai';

type AudienceGroup = {
  key: AudienceGroupKey;
  label: string;
  description: string;
};

type VisibleModuleGroup = {
  group: AudienceGroup;
  modules: Array<{
    module_name: string;
    module_label: string;
    module_summary: string;
    module_doc_path: string;
    routes: GeneratedApiDocRoute[];
  }>;
  routeCount: number;
};

const AUTH_LABELS: Record<GeneratedApiRouteAuth, string> = {
  public: '公开',
  user: '用户鉴权',
  admin: '管理员鉴权',
  api_key: '兼容鉴权',
  unknown: '未识别',
};

const SCOPE_LABELS: Record<GeneratedApiRouteScope, string> = {
  tenant: '租户主路径',
  'tenant-legacy': '旧式租户路径',
  'platform-app': '平台 app 管理',
  'platform-global': '平台全局',
  public: '公开接口',
  compat: '协议兼容',
};

const SCOPE_FILTER_OPTIONS: Array<{ value: 'ALL' | GeneratedApiRouteScope; label: string }> = [
  { value: 'ALL', label: '全部范围' },
  { value: 'tenant', label: '租户主路径' },
  { value: 'tenant-legacy', label: '旧式租户路径' },
  { value: 'public', label: '公开接口' },
  { value: 'compat', label: '协议兼容' },
];

const AUDIENCE_GROUPS: AudienceGroup[] = [
  {
    key: 'tenant-user',
    label: '租户用户 API',
    description: '给当前 app 的普通用户端调用，通常需要用户 Bearer Token。',
  },
  {
    key: 'tenant-admin',
    label: '租户管理员 API',
    description: '给当前 app 的业务管理员调用，不属于平台级管理后台接口。',
  },
  {
    key: 'public',
    label: '公开 API',
    description: '无需登录即可调用，通常用于公开资源、公开商品、公开 agent 等能力。',
  },
  {
    key: 'compat',
    label: '兼容 API',
    description: '兼容 OpenAI / Gemini 等协议或 SDK 的接口。',
  },
];

const AI_MODULE_NAMES = new Set(['ai-chat', 'ai-agents']);

const VIDEO_TRANSLATION_ROUTES: GeneratedApiDocRoute[] = [
  {
    id: 'ai-chat:AiChatController:POST:video-translation/jobs:submitVideoTranslationJob',
    controller_name: 'AiChatController',
    controller_tag: 'AIChat',
    method: 'POST',
    handler: 'submitVideoTranslationJob',
    summary: '提交视频翻译任务',
    route_path: 'video-translation/jobs',
    path_templates: [
      '/{app}/v1/ai/video-translation/jobs',
      '/api/v1/ai/video-translation/jobs',
      '/ai/video-translation/jobs',
      '/{app}/v1/ai-chat/video-translation/jobs',
      '/api/v1/ai-chat/video-translation/jobs',
      '/ai-chat/video-translation/jobs',
    ],
    auth: 'user',
    scope: 'tenant',
    supports_app_query: false,
    consumes: 'application/json',
    has_body: true,
    source_file: 'services/gateway/src/modules/ai-chat/ai-chat.controller.ts',
  },
  {
    id: 'ai-chat:AiChatController:POST:video-translation/jobs/query:queryVideoTranslationJob',
    controller_name: 'AiChatController',
    controller_tag: 'AIChat',
    method: 'POST',
    handler: 'queryVideoTranslationJob',
    summary: '查询视频翻译任务',
    route_path: 'video-translation/jobs/query',
    path_templates: [
      '/{app}/v1/ai/video-translation/jobs/query',
      '/api/v1/ai/video-translation/jobs/query',
      '/ai/video-translation/jobs/query',
      '/{app}/v1/ai-chat/video-translation/jobs/query',
      '/api/v1/ai-chat/video-translation/jobs/query',
      '/ai-chat/video-translation/jobs/query',
    ],
    auth: 'user',
    scope: 'tenant',
    supports_app_query: false,
    consumes: 'application/json',
    has_body: true,
    source_file: 'services/gateway/src/modules/ai-chat/ai-chat.controller.ts',
  },
  {
    id: 'ai-chat:AiChatController:GET:video-translation/jobs/:task_id:getVideoTranslationJob',
    controller_name: 'AiChatController',
    controller_tag: 'AIChat',
    method: 'GET',
    handler: 'getVideoTranslationJob',
    summary: '查询视频翻译任务',
    route_path: 'video-translation/jobs/{task_id}',
    path_templates: [
      '/{app}/v1/ai/video-translation/jobs/{task_id}',
      '/api/v1/ai/video-translation/jobs/{task_id}',
      '/ai/video-translation/jobs/{task_id}',
      '/{app}/v1/ai-chat/video-translation/jobs/{task_id}',
      '/api/v1/ai-chat/video-translation/jobs/{task_id}',
      '/ai-chat/video-translation/jobs/{task_id}',
    ],
    auth: 'user',
    scope: 'tenant',
    supports_app_query: false,
    consumes: null,
    has_body: false,
    source_file: 'services/gateway/src/modules/ai-chat/ai-chat.controller.ts',
  },
];

const VIDEO_RETALK_ROUTES: GeneratedApiDocRoute[] = [
  {
    id: 'ai-chat:AiChatController:POST:video-retalk/jobs:submitVideoRetalkJob',
    controller_name: 'AiChatController',
    controller_tag: 'AIChat',
    method: 'POST',
    handler: 'submitVideoRetalkJob',
    summary: '提交 VideoRetalk 任务',
    route_path: 'video-retalk/jobs',
    path_templates: [
      '/{app}/v1/ai/video-retalk/jobs',
      '/api/v1/ai/video-retalk/jobs',
      '/ai/video-retalk/jobs',
      '/{app}/v1/ai-chat/video-retalk/jobs',
      '/api/v1/ai-chat/video-retalk/jobs',
      '/ai-chat/video-retalk/jobs',
    ],
    auth: 'user',
    scope: 'tenant',
    supports_app_query: false,
    consumes: 'application/json',
    has_body: true,
    source_file: 'services/gateway/src/modules/ai-chat/ai-chat.controller.ts',
  },
  {
    id: 'ai-chat:AiChatController:POST:video-retalk/jobs/query:queryVideoRetalkJob',
    controller_name: 'AiChatController',
    controller_tag: 'AIChat',
    method: 'POST',
    handler: 'queryVideoRetalkJob',
    summary: '查询 VideoRetalk 任务',
    route_path: 'video-retalk/jobs/query',
    path_templates: [
      '/{app}/v1/ai/video-retalk/jobs/query',
      '/api/v1/ai/video-retalk/jobs/query',
      '/ai/video-retalk/jobs/query',
      '/{app}/v1/ai-chat/video-retalk/jobs/query',
      '/api/v1/ai-chat/video-retalk/jobs/query',
      '/ai-chat/video-retalk/jobs/query',
    ],
    auth: 'user',
    scope: 'tenant',
    supports_app_query: false,
    consumes: 'application/json',
    has_body: true,
    source_file: 'services/gateway/src/modules/ai-chat/ai-chat.controller.ts',
  },
  {
    id: 'ai-chat:AiChatController:GET:video-retalk/jobs/:task_id:getVideoRetalkJob',
    controller_name: 'AiChatController',
    controller_tag: 'AIChat',
    method: 'GET',
    handler: 'getVideoRetalkJob',
    summary: '查询 VideoRetalk 任务',
    route_path: 'video-retalk/jobs/{task_id}',
    path_templates: [
      '/{app}/v1/ai/video-retalk/jobs/{task_id}',
      '/api/v1/ai/video-retalk/jobs/{task_id}',
      '/ai/video-retalk/jobs/{task_id}',
      '/{app}/v1/ai-chat/video-retalk/jobs/{task_id}',
      '/api/v1/ai-chat/video-retalk/jobs/{task_id}',
      '/ai-chat/video-retalk/jobs/{task_id}',
    ],
    auth: 'user',
    scope: 'tenant',
    supports_app_query: false,
    consumes: null,
    has_body: false,
    source_file: 'services/gateway/src/modules/ai-chat/ai-chat.controller.ts',
  },
];

function buildApiDocModules(): GeneratedApiDocModule[] {
  const hasVideoTranslation = GENERATED_API_DOC_MODULES.some((module) =>
    module.routes.some((route) => route.route_path.includes('video-translation/jobs')),
  );
  const hasVideoRetalk = GENERATED_API_DOC_MODULES.some((module) =>
    module.routes.some((route) => route.route_path.includes('video-retalk/jobs')),
  );
  if (hasVideoTranslation && hasVideoRetalk) {
    return GENERATED_API_DOC_MODULES;
  }
  return GENERATED_API_DOC_MODULES.map((module) => {
    if (module.module_name !== 'ai-chat') {
      return module;
    }
    const appendedRoutes = [
      ...(!hasVideoTranslation ? VIDEO_TRANSLATION_ROUTES : []),
      ...(!hasVideoRetalk ? VIDEO_RETALK_ROUTES : []),
    ];
    return {
      ...module,
      route_count: module.route_count + appendedRoutes.length,
      routes: [...module.routes, ...appendedRoutes],
    };
  });
}

function isAiModule(moduleName: string) {
  return AI_MODULE_NAMES.has(moduleName);
}

function shouldIncludeInAppWorkspace(route: GeneratedApiDocRoute) {
  const allowedScopes = new Set<GeneratedApiRouteScope>(['tenant', 'tenant-legacy', 'public', 'compat']);
  if (!allowedScopes.has(route.scope)) {
    return false;
  }
  return !route.path_templates.some((template) => template.includes('/platform-admin/'));
}

function resolveAudienceGroup(route: GeneratedApiDocRoute): AudienceGroupKey | null {
  if (!shouldIncludeInAppWorkspace(route)) {
    return null;
  }
  if (route.scope === 'public') {
    return 'public';
  }
  if (route.scope === 'compat' || route.auth === 'api_key') {
    return 'compat';
  }
  if (route.auth === 'admin') {
    return 'tenant-admin';
  }
  return 'tenant-user';
}

function replaceKnownPlaceholders(template: string, app: PlatformAppItem | null) {
  return String(template || '')
    .replace(/\{app\}/g, app?.slug || '<app-slug>')
    .replace(/\{app_id\}/g, app?.id || '<app-id>')
    .replace(/\{([A-Za-z0-9_]+)\}/g, (_all: string, name: string) => `<${name}>`);
}

function appendAppQuery(pathname: string, app: PlatformAppItem | null, route: GeneratedApiDocRoute) {
  if (!route.supports_app_query || !app?.slug) {
    return pathname;
  }
  if (pathname.includes('app=')) {
    return pathname;
  }
  const separator = pathname.includes('?') ? '&' : '?';
  return `${pathname}${separator}app=${encodeURIComponent(app.slug)}`;
}

function resolveExamplePath(route: GeneratedApiDocRoute, app: PlatformAppItem | null, template?: string) {
  const rawTemplate = String(template || route.path_templates[0] || '').trim();
  if (!rawTemplate) {
    return '';
  }
  const replaced = replaceKnownPlaceholders(rawTemplate, app);
  return appendAppQuery(replaced, app, route);
}

function buildUsageHint(route: GeneratedApiDocRoute) {
  if (route.scope === 'platform-app') {
    return '平台租户管理接口，使用平台管理后台的 SUPER_ADMIN Bearer Token 调用。';
  }
  if (route.scope === 'tenant-legacy') {
    return '旧式租户接口，通常通过 query 参数 app 指定当前 app slug。';
  }
  if (route.scope === 'public') {
    return '公开接口，可直接按当前 app slug 调用。';
  }
  if (route.scope === 'compat') {
    return '协议兼容接口，通常用于 OpenAI/Gemini 兼容客户端或 SDK。';
  }
  if (route.auth === 'admin') {
    return '租户管理员接口，需要管理员 Bearer Token。';
  }
  if (route.auth === 'api_key') {
    return '兼容鉴权接口，通常使用 Bearer API Key 或兼容 token。';
  }
  if (route.auth === 'user') {
    return '租户用户接口，需要当前 app 的用户 Bearer Token。';
  }
  return '按模块能力调用，建议结合 Swagger 与 DTO 约束确认参数。';
}

function buildCurlExample(route: GeneratedApiDocRoute, app: PlatformAppItem | null) {
  const examplePath = resolveExamplePath(route, app);
  const lines = [`curl -X ${route.method} "$BASE_URL${examplePath}" \\`];
  if (route.auth === 'admin') {
    lines.push(`  -H "Authorization: Bearer <super-admin-token>" \\`);
  } else if (route.auth === 'user') {
    lines.push(`  -H "Authorization: Bearer <user-token>" \\`);
  } else if (route.auth === 'api_key') {
    lines.push(`  -H "Authorization: Bearer <api-key-or-token>" \\`);
  }

  if (route.consumes === 'multipart/form-data') {
    lines.push(`  -F "file=@/path/to/file"`);
    return lines.join('\n');
  }

  if (route.has_body) {
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{`);
    lines.push(`    "TODO": "按 DTO/Swagger 填写请求体"`);
    lines.push(`  }'`);
    return lines.join('\n');
  }

  if (lines[lines.length - 1].endsWith(' \\')) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, -2);
  }
  return lines.join('\n');
}

export default function TenantApiDocsPanel({ app }: Props) {
  const [activeTab, setActiveTab] = useState<ApiDocsTab>('all');
  const [query, setQuery] = useState('');
  const [moduleFilter, setModuleFilter] = useState('ALL');
  const [authFilter, setAuthFilter] = useState<'ALL' | GeneratedApiRouteAuth>('ALL');
  const [scopeFilter, setScopeFilter] = useState<'ALL' | GeneratedApiRouteScope>('ALL');

  const docModules = useMemo(() => buildApiDocModules(), []);

  const visibleGroups = useMemo<VisibleModuleGroup[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const grouped = new Map<AudienceGroupKey, VisibleModuleGroup>();

    for (const group of AUDIENCE_GROUPS) {
      grouped.set(group.key, {
        group,
        modules: [],
        routeCount: 0,
      });
    }

    docModules
      .filter((module) => activeTab !== 'ai' || isAiModule(module.module_name))
      .map((module) => {
        const routes = module.routes.filter((route) => {
          const audienceGroup = resolveAudienceGroup(route);
          if (!audienceGroup) {
            return false;
          }
          if (moduleFilter !== 'ALL' && module.module_name !== moduleFilter) {
            return false;
          }
          if (authFilter !== 'ALL' && route.auth !== authFilter) {
            return false;
          }
          if (scopeFilter !== 'ALL' && route.scope !== scopeFilter) {
            return false;
          }
          if (!normalizedQuery) {
            return true;
          }
          const haystack = [
            module.module_name,
            module.module_label,
            module.module_summary,
            route.summary,
            route.handler,
            route.method,
            route.route_path,
            ...route.path_templates,
          ]
            .join('\n')
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        });

        return { ...module, routes };
      })
      .filter((module) => module.routes.length > 0)
      .forEach((module) => {
        const perGroup = new Map<AudienceGroupKey, GeneratedApiDocRoute[]>();
        module.routes.forEach((route) => {
          const groupKey = resolveAudienceGroup(route);
          if (!groupKey) {
            return;
          }
          const current = perGroup.get(groupKey) || [];
          current.push(route);
          perGroup.set(groupKey, current);
        });

        for (const [groupKey, routes] of perGroup.entries()) {
          const target = grouped.get(groupKey);
          if (!target || !routes.length) {
            continue;
          }
          target.modules.push({
            module_name: module.module_name,
            module_label: module.module_label,
            module_summary: module.module_summary,
            module_doc_path: module.module_doc_path,
            routes,
          });
          target.routeCount += routes.length;
        }
      });

    return AUDIENCE_GROUPS
      .map((group) => grouped.get(group.key) as VisibleModuleGroup)
      .filter((group) => group.routeCount > 0);
  }, [activeTab, authFilter, docModules, moduleFilter, query, scopeFilter]);

  const moduleOptions = useMemo(
    () =>
      docModules
        .filter((module) => activeTab !== 'ai' || isAiModule(module.module_name))
        .filter((module) => module.routes.some((route) => shouldIncludeInAppWorkspace(route)))
        .map((module) => ({ value: module.module_name, label: module.module_label }))
        .sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN')),
    [activeTab, docModules],
  );

  const totalRouteCount = useMemo(
    () => visibleGroups.reduce((sum, group) => sum + group.routeCount, 0),
    [visibleGroups],
  );

  const totalModuleCount = useMemo(
    () => visibleGroups.reduce((sum, group) => sum + group.modules.length, 0),
    [visibleGroups],
  );

  const tenantBasePath = app?.slug ? `/${app.slug}/v1` : '/<app-slug>/v1';
  const aiChatPath = `${tenantBasePath}/ai/chat/completions`;
  const aiImagePath = `${tenantBasePath}/ai/images/generations`;
  const aiTtsPath = `${tenantBasePath}/ai/audio/speech`;
  const aiGoogleTtsPath = `${tenantBasePath}/ai/google/tts/speech`;
  const googleTtsPath = `${tenantBasePath}/google/tts/speech`;
  const vertexTtsPath = `${tenantBasePath}/vertex/tts/speech`;
  const aiVideoAsyncPath = `${tenantBasePath}/ai/videos/generations/async`;
  const aiVideoTaskPath = `${tenantBasePath}/ai/videos/generations/tasks/query`;
  const videoTranslationSubmitPath = `${tenantBasePath}/ai/video-translation/jobs`;
  const videoTranslationQueryPath = `${tenantBasePath}/ai/video-translation/jobs/query`;
  const videoRetalkSubmitPath = `${tenantBasePath}/ai/video-retalk/jobs`;
  const videoRetalkQueryPath = `${tenantBasePath}/ai/video-retalk/jobs/query`;
  const feedbackIssueAppSlug = app?.slug || '<app-slug>';
  const feedbackIssueAppSlugQuery = app?.slug ? encodeURIComponent(app.slug) : '<app-slug>';
  const feedbackIssueListPath = `/api/v1/platform-admin/feedback-issues?app_slug=${feedbackIssueAppSlugQuery}&status=pending&page=1&page_size=20`;
  const feedbackIssueDetailPath = '/api/v1/platform-admin/feedback-issues/<feedback_id>';

  return (
    <div className="platform-page api-docs-page">
      <div className="platform-page-head">
        <div>
          <h1>应用 API 文档</h1>
          <p>查看当前 app 可接入的业务 API、公开 API、兼容 API 和 AI API。</p>
        </div>
      </div>

      <section className="api-docs-tabs" role="tablist" aria-label="API 文档分组">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'all'}
          className={`api-docs-tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('all');
            setModuleFilter('ALL');
          }}
        >
          <span>全部 API</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'ai'}
          className={`api-docs-tab ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('ai');
            setModuleFilter('ALL');
          }}
        >
          <span>AI API</span>
        </button>
      </section>

      <section className="card">
        <div className="platform-section-head">
          <h3>当前 app 接入基线</h3>
        </div>
        <div className="api-docs-top-grid">
          <div className="api-docs-top-item">
            <span>应用名称</span>
            <strong>{app?.name || '-'}</strong>
          </div>
          <div className="api-docs-top-item">
            <span>应用 slug</span>
            <code>{app?.slug || '<app-slug>'}</code>
          </div>
          <div className="api-docs-top-item">
            <span>应用 ID</span>
            <code>{app?.id || '<app-id>'}</code>
          </div>
          <div className="api-docs-top-item">
            <span>租户主路径</span>
            <code>{tenantBasePath}</code>
          </div>
          <div className="api-docs-top-item">
            <span>Swagger UI</span>
            <code>/api/docs</code>
          </div>
        </div>
        <div className="api-docs-note">
          <strong>调用约定：</strong>
          <span>
            <code>$BASE_URL</code> 请替换成网关域名；页面中已自动把 <code>{'{app}'}</code> / <code>{'{app_id}'}</code>{' '}
            替换成当前 app。
          </span>
        </div>
        <div className="api-docs-note">
          <strong>排除范围：</strong>
          <span>平台租户管理类接口仅供平台管理后台使用，不再出现在租户 app 文档页中。</span>
        </div>
      </section>

      {activeTab === 'ai' && (
        <section className="card api-docs-ai-card">
          <div className="platform-section-head api-docs-module-head">
            <div>
              <h3>AI API</h3>
              <p>使用当前 app 的用户 Token 调用已启用的 AI 能力。</p>
            </div>
            <div className="api-docs-module-meta">
              <span>鉴权</span>
              <code>Authorization: Bearer &lt;user-token&gt;</code>
            </div>
          </div>

          <div className="api-docs-route-meta">
            <div className="api-docs-meta-item">
              <span>对话</span>
              <code>{aiChatPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>图片</span>
              <code>{aiImagePath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>语音</span>
              <code>{aiTtsPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>视频</span>
              <code>{aiVideoAsyncPath}</code>
            </div>
          </div>

          <div className="api-docs-issue-grid">
            <div className="api-docs-curl">
              <span>对话</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiChatPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [
      { "role": "user", "content": "写一段产品介绍" }
    ]
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>图片生成</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiImagePath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "A clean product screenshot style image",
    "size": "1024x1024"
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>MiniMax 语音</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiTtsPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "speech-2.8-hd",
    "input": "这里是开场白<#0.6#>接下来进入重点。",
    "voice_id": "male-qn-qingse",
    "emotion": "happy",
    "response_format": "mp3",
    "return_audio_binary": true
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>CosyVoice 语音</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiTtsPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "cosyvoice-v3.5-plus",
    "input": "这里是开场白，接下来进入重点。",
    "voice_id": "voice_xxx",
    "prompt": "请用温柔、平稳的语气朗读。",
    "response_format": "mp3",
    "return_audio_binary": true
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>SSML 语音</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiTtsPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "cosyvoice-v3.5-plus",
    "input": "<speak>第一句<break time=\\"500ms\\"/>第二句</speak>",
    "voice_id": "voice_xxx",
    "prompt": "请用自然、清晰的语气朗读。",
    "response_format": "mp3",
    "return_audio_binary": true
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>视频生成</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiVideoAsyncPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "A short product demo video",
    "duration_seconds": 5,
    "resolution": "720p"
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>视频任务查询</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiVideoTaskPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "task_id": "<task_id>"
  }'`}</code>
              </pre>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'ai' && (
        <section className="card api-docs-ai-card">
          <div className="platform-section-head api-docs-module-head">
            <div>
              <h3>Gemini TTS</h3>
              <p>生成单人或双人语音，返回音频 URL、base64 或二进制音频。</p>
            </div>
            <div className="api-docs-module-meta">
              <span>API Key</span>
              <code>Authorization: Bearer &lt;api-key&gt;</code>
            </div>
          </div>

          <div className="api-docs-route-meta">
            <div className="api-docs-meta-item">
              <span>用户 Token</span>
              <code>{aiGoogleTtsPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>API Key</span>
              <code>{googleTtsPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>Vertex</span>
              <code>{vertexTtsPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>模型</span>
              <code>gemini-3.1-flash-tts-preview</code>
            </div>
            <div className="api-docs-meta-item">
              <span>输出</span>
              <strong>url / b64_json / binary</strong>
            </div>
          </div>

          <div className="api-docs-issue-grid">
            <div className="api-docs-curl">
              <span>单人语音</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${googleTtsPath}" \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3.1-flash-tts-preview",
    "text": "OK, so... tell me about this AI thing.",
    "prompt": "Say the following in a curious way.",
    "voice": "Kore",
    "language_code": "en-US",
    "output_format": "wav"
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>双人语音</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${googleTtsPath}" \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3.1-flash-tts-preview",
    "text": "Joe: What is your favorite time of day?\\nJane: Morning, when the light is soft.",
    "language_code": "en-US",
    "speakers": [
      { "speaker": "Joe", "voice": "Kore" },
      { "speaker": "Jane", "voice": "Puck" }
    ]
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>用户 Token 调用</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${aiGoogleTtsPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "This audio is returned as base64 JSON.",
    "voice": "Kore",
    "response_format": "b64_json",
    "output_format": "wav"
  }'`}</code>
              </pre>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'ai' && (
        <section className="card api-docs-ai-card">
          <div className="platform-section-head api-docs-module-head">
            <div>
              <h3>VideoRetalk</h3>
              <p>提交口型替换任务后，用返回的 task_id 查询生成视频。</p>
            </div>
            <div className="api-docs-module-meta">
              <span>模型</span>
              <code>videoretalk</code>
            </div>
          </div>

          <div className="api-docs-route-meta">
            <div className="api-docs-meta-item">
              <span>提交任务</span>
              <code>{videoRetalkSubmitPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>查询任务</span>
              <code>{videoRetalkQueryPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>计费字段</span>
              <strong>duration_seconds / resolution</strong>
            </div>
            <div className="api-docs-meta-item">
              <span>视频尺寸</span>
              <strong>宽高 640-2048</strong>
            </div>
          </div>

          <div className="api-docs-issue-grid">
            <div className="api-docs-curl">
              <span>提交任务</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${videoRetalkSubmitPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": {
      "video_url": "https://example.com/input.mp4",
      "audio_url": "https://example.com/audio.wav",
      "video_width": 720,
      "video_height": 1280
    },
    "parameters": {
      "video_extension": false
    },
    "duration_seconds": 8,
    "resolution": "720p"
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>查询任务</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${videoRetalkQueryPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "task_id": "<task_id>"
  }'`}</code>
              </pre>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'ai' && (
        <section className="card api-docs-ai-card">
          <div className="platform-section-head api-docs-module-head">
            <div>
              <h3>视频翻译</h3>
              <p>提交视频翻译任务后，用返回的 task_id 查询结果。</p>
            </div>
            <div className="api-docs-module-meta">
              <span>模型</span>
              <code>aliyun-video-translation</code>
            </div>
          </div>

          <div className="api-docs-route-meta">
            <div className="api-docs-meta-item">
              <span>提交任务</span>
              <code>{videoTranslationSubmitPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>查询任务</span>
              <code>{videoTranslationQueryPath}</code>
            </div>
            <div className="api-docs-meta-item">
              <span>计费字段</span>
              <strong>duration_seconds / resolution</strong>
            </div>
          </div>

          <div className="api-docs-issue-grid">
            <div className="api-docs-curl">
              <span>提交任务</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${videoTranslationSubmitPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": {
      "url": "https://example.com/input.mp4",
      "type": "Video"
    },
    "output": {
      "media_url": "oss://bucket/path/output.mp4"
    },
    "source_language": "zh",
    "target_language": "en",
    "mode": "speech",
    "duration_seconds": 120,
    "resolution": "1080p"
  }'`}</code>
              </pre>
            </div>

            <div className="api-docs-curl">
              <span>查询任务</span>
              <pre>
                <code>{`curl -X POST "$BASE_URL${videoTranslationQueryPath}" \\
  -H "Authorization: Bearer <user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "task_id": "<task_id>"
  }'`}</code>
              </pre>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'all' && (
        <section className="card">
        <div className="platform-section-head api-docs-module-head">
          <div>
            <h3>Bug issue API</h3>
            <p>使用平台设置生成的集成密钥读取、更新、评论和评审当前 app 的反馈 issue。</p>
          </div>
          <div className="api-docs-module-meta">
            <span>Scope</span>
            <code>feedback:admin</code>
          </div>
        </div>

        <div className="api-docs-route-meta">
          <div className="api-docs-meta-item">
            <span>请求头</span>
            <code>Authorization: Bearer &lt;key&gt;</code>
          </div>
          <div className="api-docs-meta-item">
            <span>应用参数</span>
            <code>app_slug={feedbackIssueAppSlug}</code>
          </div>
          <div className="api-docs-meta-item">
            <span>奖励规则</span>
            <strong>感谢 20 积分，有用 100 积分，无效 0 积分</strong>
          </div>
        </div>

        <div className="api-docs-issue-grid">
          <div className="api-docs-curl">
            <span>读取列表</span>
            <pre>
              <code>{`curl "$BASE_URL${feedbackIssueListPath}" \\
  -H "Authorization: Bearer <integration-api-key>"`}</code>
            </pre>
          </div>

          <div className="api-docs-curl">
            <span>更新状态</span>
            <pre>
              <code>{`curl -X PATCH "$BASE_URL${feedbackIssueDetailPath}?app_slug=${feedbackIssueAppSlugQuery}" \\
  -H "Authorization: Bearer <integration-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "status": "in_progress",
    "priority": "high",
    "note": "已复现，等待修复"
  }'`}</code>
            </pre>
          </div>

          <div className="api-docs-curl">
            <span>新增评论</span>
            <pre>
              <code>{`curl -X POST "$BASE_URL${feedbackIssueDetailPath}/comments?app_slug=${feedbackIssueAppSlugQuery}" \\
  -H "Authorization: Bearer <integration-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "body": "需要补充桌面端日志",
    "is_internal": true
  }'`}</code>
            </pre>
          </div>

          <div className="api-docs-curl">
            <span>评审奖励</span>
            <pre>
              <code>{`curl -X POST "$BASE_URL${feedbackIssueDetailPath}/review?app_slug=${feedbackIssueAppSlugQuery}" \\
  -H "Authorization: Bearer <integration-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "review_status": "useful",
    "admin_note": "日志完整，可定位问题"
  }'`}</code>
            </pre>
          </div>
        </div>
      </section>
      )}

      <section className="card">
        <div className="platform-filter-row">
          <input
            className="platform-filter-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模块、接口摘要、路径、处理函数"
          />
          <select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}>
            <option value="ALL">全部模块</option>
            {moduleOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select value={authFilter} onChange={(event) => setAuthFilter(event.target.value as 'ALL' | GeneratedApiRouteAuth)}>
            <option value="ALL">全部鉴权</option>
            <option value="public">公开</option>
            <option value="user">用户鉴权</option>
            <option value="admin">管理员鉴权</option>
            <option value="api_key">兼容鉴权</option>
          </select>
          <select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as 'ALL' | GeneratedApiRouteScope)}>
            {SCOPE_FILTER_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="platform-filter-hint">
            {totalModuleCount} 个模块 / {totalRouteCount} 个接口
          </div>
        </div>
      </section>

      {visibleGroups.map((group) => (
        <section className="card api-docs-group-card" key={group.group.key}>
          <div className="platform-section-head api-docs-group-head">
            <div>
              <h3>{group.group.label}</h3>
              <p>{group.group.description}</p>
            </div>
            <div className="api-docs-module-meta">
              <span>{group.modules.length} 个模块</span>
              <span>{group.routeCount} 个接口</span>
            </div>
          </div>

          <div className="api-docs-group-modules">
            {group.modules.map((module) => (
              <section className="api-docs-module-card" key={`${group.group.key}:${module.module_name}`}>
                <div className="platform-section-head api-docs-module-head">
                  <div>
                    <h3>{module.module_label}</h3>
                    <p>{module.module_summary}</p>
                  </div>
                  <div className="api-docs-module-meta">
                    <span>{module.routes.length} 个接口</span>
                    <code>{module.module_doc_path}</code>
                  </div>
                </div>

                <div className="api-docs-route-list">
                  {module.routes.map((route) => {
                    const primaryPath = resolveExamplePath(route, app);
                    const compatPaths = route.path_templates
                      .slice(1)
                      .map((template) => resolveExamplePath(route, app, template));
                    return (
                      <article className="api-docs-route-card" key={route.id}>
                        <div className="api-docs-route-head">
                          <div className="api-docs-route-head-main">
                            <span className={`platform-method-badge method-${route.method.toLowerCase()}`}>
                              {route.method}
                            </span>
                            <strong>{route.summary || route.handler}</strong>
                          </div>
                          <div className="api-docs-route-badges">
                            <span className="status-tag">{AUTH_LABELS[route.auth]}</span>
                            <span className="status-tag">{SCOPE_LABELS[route.scope]}</span>
                          </div>
                        </div>

                        <div className="api-docs-path-block">
                          <span>主路径</span>
                          <code>{primaryPath}</code>
                        </div>

                        {compatPaths.length > 0 && (
                          <div className="api-docs-compat-block">
                            <span>兼容路径</span>
                            <div className="api-docs-compat-list">
                              {compatPaths.map((item) => (
                                <code key={`${route.id}:${item}`}>{item}</code>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="api-docs-route-meta">
                          <div className="api-docs-meta-item">
                            <span>调用说明</span>
                            <strong>{buildUsageHint(route)}</strong>
                          </div>
                          <div className="api-docs-meta-item">
                            <span>处理函数</span>
                            <code>{route.controller_name}.{route.handler}()</code>
                          </div>
                          <div className="api-docs-meta-item">
                            <span>源码位置</span>
                            <code>{route.source_file}</code>
                          </div>
                        </div>

                        <div className="api-docs-curl">
                          <span>cURL 示例</span>
                          <pre>
                            <code>{buildCurlExample(route, app)}</code>
                          </pre>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </section>
      ))}

      {!visibleGroups.length && (
        <section className="card">
          <div className="loading">没有匹配的 API 文档结果。</div>
        </section>
      )}
    </div>
  );
}
