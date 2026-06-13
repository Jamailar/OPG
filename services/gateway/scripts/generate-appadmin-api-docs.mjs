import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gatewayRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gatewayRoot, '../..');
const modulesRoot = path.join(gatewayRoot, 'src', 'modules');
const outputFile = path.join(repoRoot, 'apps/web/src/config/generated-api-docs.ts');
const gatewayPathPrefix = 'services/gateway';

const MODULE_LABEL_OVERRIDES = {
  acquisition: '用户来源',
  'ai-agents': 'AI 智能体',
  'ai-chat': 'AI 能力',
  'api-keys': 'API Keys',
  auth: '认证与登录',
  'behavior-analytics': '行为分析',
  discovery: '发现页',
  feedback: '反馈中心',
  payments: '支付与订单',
  'platform-admin': '平台租户管理',
  'public-resources': '公开资源',
  redeem: '兑换与权益',
  upload: '上传',
  users: '用户',
};

function toTitle(moduleName) {
  return moduleName
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir) {
  const files = [];
  if (!(await exists(dir))) {
    return files;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function extractQuotedLiterals(raw) {
  const values = [];
  const regex = /['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = regex.exec(String(raw || ''))) !== null) {
    if (match[1]) {
      values.push(match[1]);
    }
  }
  return values;
}

function extractDecoratorArgs(source, decoratorName) {
  const marker = `@${decoratorName}(`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return null;
  }

  let cursor = start + marker.length;
  let depth = 1;
  let buffer = '';

  while (cursor < source.length && depth > 0) {
    const ch = source[cursor];
    if (ch === '(') {
      depth += 1;
      buffer += ch;
      cursor += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth > 0) {
        buffer += ch;
      }
      cursor += 1;
      continue;
    }
    buffer += ch;
    cursor += 1;
  }

  return buffer.trim();
}

function collectDecoratorBlock(lines, startIndex) {
  let text = '';
  let seenParen = false;
  let depth = 0;
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    text += `${line}\n`;
    for (const ch of line) {
      if (ch === '(') {
        seenParen = true;
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      }
    }
    if (!seenParen || depth <= 0) {
      break;
    }
  }

  return { text: text.trim(), nextIndex: index + 1 };
}

function collectSignatureBlock(lines, startIndex) {
  let text = '';
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    text += ` ${lines[index].trim()}`;
    if (lines[index].includes('{')) {
      break;
    }
  }
  return { text: text.trim(), nextIndex: index + 1 };
}

function parseClassName(content) {
  const match = content.match(/export\s+class\s+(\w+)/);
  return match ? match[1] : 'UnknownClass';
}

function parseControllerBase(content) {
  const args = extractDecoratorArgs(content, 'Controller');
  if (!args) {
    return '(unknown)';
  }
  return args.replace(/\s+/g, ' ').trim();
}

function ensureLeadingSlash(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function normalizeCurlyParams(value) {
  return String(value || '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function joinPath(basePath, relativePath) {
  const base = String(basePath || '').trim();
  const relative = String(relativePath || '').trim();
  if (!base && !relative) {
    return '/';
  }
  if (!relative) {
    return normalizeCurlyParams(base || '/');
  }
  const cleanBase = base.replace(/\/+$/, '');
  const cleanRelative = relative.replace(/^\/+/, '');
  if (!cleanBase) {
    return normalizeCurlyParams(`/${cleanRelative}`);
  }
  return normalizeCurlyParams(`${cleanBase}/${cleanRelative}`);
}

function dedupeStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function buildTenantTemplates(basePath, version = 'v1', includeBarePath = false) {
  const normalizedBase = String(basePath || '').replace(/^\/+|\/+$/g, '');
  if (!normalizedBase) {
    return [];
  }

  if (normalizedBase === 'platform-admin') {
    return dedupeStrings([
      `/api/${version}/${normalizedBase}`,
      `/{app}/${version}/${normalizedBase}`,
      includeBarePath ? `/${normalizedBase}` : '',
    ]);
  }

  return dedupeStrings([
    `/{app}/${version}/${normalizedBase}`,
    `/api/${version}/${normalizedBase}`,
    includeBarePath ? `/${normalizedBase}` : '',
  ]);
}

function buildTenantRootTemplates(version = 'v1', includeBarePath = false) {
  const normalizedVersion = String(version || 'v1').replace(/^\/+|\/+$/g, '');
  return dedupeStrings([
    `/{app}/${normalizedVersion}`,
    `/api/${normalizedVersion}`,
    includeBarePath ? `/${normalizedVersion}` : '',
  ]);
}

function parseControllerTemplates(baseRaw) {
  const templates = [];
  const normalizedRaw = String(baseRaw || '').trim();

  const tenantMatches = normalizedRaw.matchAll(
    /tenantControllerPaths\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*(true|false))?\s*\)/g,
  );
  for (const match of tenantMatches) {
    templates.push(...buildTenantTemplates(match[1], 'v1', match[2] === 'true'));
  }

  const versionedMatches = normalizedRaw.matchAll(
    /tenantVersionedControllerPaths\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*(?:,\s*(true|false))?\s*\)/g,
  );
  for (const match of versionedMatches) {
    templates.push(...buildTenantTemplates(match[1], match[2], match[3] === 'true'));
  }

  const rootMatches = normalizedRaw.matchAll(
    /tenantRootControllerPaths\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*(true|false))?\s*\)/g,
  );
  for (const match of rootMatches) {
    templates.push(...buildTenantRootTemplates(match[1], match[2] === 'true'));
  }

  if (templates.length) {
    return dedupeStrings(templates);
  }

  const literals = extractQuotedLiterals(normalizedRaw).map((item) => normalizeCurlyParams(ensureLeadingSlash(item)));
  if (literals.length) {
    return dedupeStrings(literals);
  }

  return dedupeStrings([normalizeCurlyParams(ensureLeadingSlash(normalizedRaw))]);
}

function parseControllerClassMeta(content, moduleName) {
  const classIndex = content.indexOf('export class');
  const classHeader = classIndex >= 0 ? content.slice(0, classIndex) : content;
  const controllerTagArgs = extractDecoratorArgs(classHeader, 'ApiTags');
  const tag = extractQuotedLiterals(controllerTagArgs || '')[0] || toTitle(moduleName);

  return {
    className: parseClassName(content),
    controllerTag: tag,
    baseRaw: parseControllerBase(content),
    baseTemplates: parseControllerTemplates(parseControllerBase(content)),
    hasJwtGuard: classHeader.includes('JwtAuthGuard') || classHeader.includes('AiDebugJwtAuthGuard'),
    hasAdminGuard: classHeader.includes('AdminRoleGuard'),
    hasOpenAiCompatGuard: classHeader.includes('OpenAiCompatAuthGuard'),
    hasFeedbackAdminApiKeyGuard: classHeader.includes('FeedbackAdminApiKeyGuard'),
    hasBearerAuth: classHeader.includes('@ApiBearerAuth'),
    isPublic: classHeader.includes('@Public()'),
  };
}

function extractSummaryFromDecorators(decorators) {
  for (const decorator of decorators) {
    if (!decorator.startsWith('@ApiOperation')) {
      continue;
    }
    const args = extractDecoratorArgs(decorator, 'ApiOperation') || '';
    const match = args.match(/summary\s*:\s*['"`]([^'"`]+)['"`]/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return '';
}

function normalizeRouteArg(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return '';
  }
  const literalMatch = trimmed.match(/["'`]([^"'`]*)["'`]/);
  if (literalMatch) {
    return literalMatch[1] || '';
  }
  return trimmed.replace(/\s+/g, ' ');
}

function parseControllerRoutes(content, classMeta) {
  const lines = content.split(/\r?\n/);
  const routes = [];
  const methodDecorator = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const methodMatch = line.match(methodDecorator);
    if (!methodMatch) {
      continue;
    }

    const httpMethod = methodMatch[1].toUpperCase();
    const routeDecoratorBlock = collectDecoratorBlock(lines, i);
    const decorators = [routeDecoratorBlock.text];
    let cursor = routeDecoratorBlock.nextIndex;

    while (cursor < lines.length) {
      const trimmed = lines[cursor].trim();
      if (!trimmed) {
        cursor += 1;
        continue;
      }
      if (!trimmed.startsWith('@')) {
        break;
      }
      const decoratorBlock = collectDecoratorBlock(lines, cursor);
      decorators.push(decoratorBlock.text);
      cursor = decoratorBlock.nextIndex;
    }

    const signatureBlock = collectSignatureBlock(lines, cursor);
    const signature = signatureBlock.text;
    const handlerMatch = signature.match(/(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    const handler = handlerMatch?.[1] || 'unknownHandler';
    const routeArgs = extractDecoratorArgs(routeDecoratorBlock.text, methodMatch[1]) || '';
    const routePath = normalizeRouteArg(routeArgs);
    const hasBody = signature.includes('@Body(');
    const consumesMultipart = decorators.some((item) => item.includes('multipart/form-data'));
    const requiresAdmin = decorators.some((item) => item.includes('AdminRoleGuard'));
    const isPublic = decorators.some((item) => item.includes('@Public()'));
    const hasOpenAiCompatGuard = decorators.some((item) => item.includes('OpenAiCompatAuthGuard'));
    const hasFeedbackAdminApiKeyGuard = decorators.some((item) => item.includes('FeedbackAdminApiKeyGuard'));
    const hasJwtGuard = decorators.some((item) => item.includes('JwtAuthGuard') || item.includes('AiDebugJwtAuthGuard'));
    const hasBearerAuth = decorators.some((item) => item.includes('@ApiBearerAuth'));
    const supportsAppQuery = signature.includes("@Query('app'") || signature.includes('@Query("app"');

    let auth = 'unknown';
    if (isPublic || classMeta.isPublic) {
      auth = 'public';
    } else if (requiresAdmin || classMeta.hasAdminGuard) {
      auth = 'admin';
    } else if (hasOpenAiCompatGuard || classMeta.hasOpenAiCompatGuard || hasFeedbackAdminApiKeyGuard || classMeta.hasFeedbackAdminApiKeyGuard) {
      auth = 'api_key';
    } else if (hasJwtGuard || classMeta.hasJwtGuard || hasBearerAuth || classMeta.hasBearerAuth) {
      auth = 'user';
    }

    const fullPathTemplates = dedupeStrings(classMeta.baseTemplates.map((basePath) => joinPath(basePath, routePath)));
    const templateBlob = fullPathTemplates.join('\n');

    let scope = 'tenant';
    if (templateBlob.includes('/platform-admin/')) {
      scope =
        templateBlob.includes('/apps/{app_id}/') || templateBlob.includes('/payments/apps/{app_id}/')
          ? 'platform-app'
          : 'platform-global';
    } else if (auth === 'public') {
      scope = 'public';
    } else if (templateBlob.includes('/v1beta/') || classMeta.controllerTag.includes('Compat')) {
      scope = 'compat';
    } else if (supportsAppQuery) {
      scope = 'tenant-legacy';
    }

    routes.push({
      id: `${classMeta.className}:${httpMethod}:${routePath || '(root)'}:${handler}`,
      controller_name: classMeta.className,
      controller_tag: classMeta.controllerTag,
      method: httpMethod,
      handler,
      summary: extractSummaryFromDecorators(decorators),
      route_path: normalizeCurlyParams(routePath || '/'),
      path_templates: fullPathTemplates,
      auth,
      scope,
      supports_app_query: supportsAppQuery,
      consumes: consumesMultipart ? 'multipart/form-data' : hasBody ? 'application/json' : null,
      has_body: hasBody,
    });

    i = signatureBlock.nextIndex - 1;
  }

  return routes;
}

function buildModuleSummary(moduleName) {
  const label = MODULE_LABEL_OVERRIDES[moduleName] || toTitle(moduleName);
  return `覆盖 ${label} 相关的接口能力，可用于按模块检索当前 app 可接入的 API。`;
}

async function main() {
  const moduleDirs = (await fs.readdir(modulesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const modules = [];

  for (const moduleName of moduleDirs) {
    const moduleDir = path.join(modulesRoot, moduleName);
    const controllerFiles = await walkFiles(moduleDir);
    if (!controllerFiles.length) {
      continue;
    }

    const routes = [];
    for (const file of controllerFiles) {
      const content = await fs.readFile(file, 'utf8');
      const classMeta = parseControllerClassMeta(content, moduleName);
      const controllerRoutes = parseControllerRoutes(content, classMeta).map((route) => ({
        ...route,
        id: `${moduleName}:${route.id}`,
        source_file: path.relative(repoRoot, file),
      }));
      routes.push(...controllerRoutes);
    }

    if (!routes.length) {
      continue;
    }

    routes.sort((left, right) => {
      const pathCompare = left.path_templates[0].localeCompare(right.path_templates[0], 'en');
      if (pathCompare !== 0) return pathCompare;
      return left.method.localeCompare(right.method, 'en');
    });

    modules.push({
      module_name: moduleName,
      module_label: MODULE_LABEL_OVERRIDES[moduleName] || toTitle(moduleName),
      module_summary: buildModuleSummary(moduleName),
      module_doc_path: `${gatewayPathPrefix}/docs/modules/${moduleName}/README.md`,
      route_count: routes.length,
      routes,
    });
  }

  const fileContent = `// Auto-generated by services/gateway/scripts/generate-appadmin-api-docs.mjs
// Do not edit manually.

export type GeneratedApiRouteAuth = 'public' | 'user' | 'admin' | 'api_key' | 'unknown';
export type GeneratedApiRouteScope = 'tenant' | 'tenant-legacy' | 'platform-app' | 'platform-global' | 'public' | 'compat';

export interface GeneratedApiDocRoute {
  id: string;
  controller_name: string;
  controller_tag: string;
  method: string;
  handler: string;
  summary: string;
  route_path: string;
  path_templates: string[];
  auth: GeneratedApiRouteAuth;
  scope: GeneratedApiRouteScope;
  supports_app_query: boolean;
  consumes: string | null;
  has_body: boolean;
  source_file: string;
}

export interface GeneratedApiDocModule {
  module_name: string;
  module_label: string;
  module_summary: string;
  module_doc_path: string;
  route_count: number;
  routes: GeneratedApiDocRoute[];
}

export const GENERATED_API_DOC_MODULES: GeneratedApiDocModule[] = ${JSON.stringify(modules, null, 2)};\n`;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, fileContent, 'utf8');
  console.log(`Generated platform API docs catalog at ${path.relative(repoRoot, outputFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
