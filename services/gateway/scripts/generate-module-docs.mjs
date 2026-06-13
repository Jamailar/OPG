import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const modulesRoot = path.join(projectRoot, 'src', 'modules');
const docsRoot = path.join(projectRoot, 'docs');
const moduleDocsRoot = path.join(docsRoot, 'modules');

function formatDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toTitle(moduleName) {
  return moduleName
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir) {
  const results = [];
  if (!(await exists(dir))) {
    return results;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

function normalizeRouteArg(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return '(root)';
  }
  const literalMatch = trimmed.match(/["'`]([^"'`]+)["'`]/);
  if (literalMatch && literalMatch[1]) {
    return literalMatch[1];
  }
  return trimmed.replace(/\s+/g, ' ');
}

function extractDecoratorArgs(content, decoratorName) {
  const marker = `@${decoratorName}(`;
  const start = content.indexOf(marker);
  if (start < 0) {
    return null;
  }

  let cursor = start + marker.length;
  let depth = 1;
  let buffer = '';

  while (cursor < content.length && depth > 0) {
    const ch = content[cursor];
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

function parseControllerBase(content) {
  const args = extractDecoratorArgs(content, 'Controller');
  if (!args) {
    return '(未声明)';
  }
  return args.replace(/\s+/g, ' ').trim();
}

function parseClassName(content) {
  const match = content.match(/export\s+class\s+(\w+)/);
  return match ? match[1] : 'UnknownClass';
}

function parseControllerRoutes(content) {
  const lines = content.split(/\r?\n/);
  const routes = [];
  const methodDecorator = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(/;
  const methodNameRegex = /^\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const decoratorMatch = line.match(methodDecorator);
    if (!decoratorMatch) {
      continue;
    }

    const httpMethod = decoratorMatch[1].toUpperCase();
    let decoratorBody = line.slice(line.indexOf('(') + 1);
    let j = i;
    while (!decoratorBody.includes(')') && j + 1 < lines.length) {
      j += 1;
      decoratorBody += ` ${lines[j].trim()}`;
    }
    const endIndex = decoratorBody.indexOf(')');
    const routeArg = endIndex >= 0 ? decoratorBody.slice(0, endIndex) : decoratorBody;

    let handler = '(unknownHandler)';
    let k = j + 1;
    while (k < lines.length) {
      const candidate = lines[k].trim();
      if (!candidate) {
        k += 1;
        continue;
      }
      if (candidate.startsWith('@')) {
        k += 1;
        continue;
      }
      const methodMatch = lines[k].match(methodNameRegex);
      if (methodMatch) {
        handler = methodMatch[1];
      }
      break;
    }

    routes.push({
      method: httpMethod,
      path: normalizeRouteArg(routeArg),
      handler,
    });

    i = j;
  }

  return routes;
}

function parseServiceMethods(content) {
  const lines = content.split(/\r?\n/);
  const methods = [];
  const methodRegex =
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::\s*[^({]+)?\s*\{/;
  const reserved = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'try',
    'return',
    'throw',
    'constructor',
  ]);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }
    const match = line.match(methodRegex);
    if (!match) {
      continue;
    }

    const methodName = match[1];
    if (reserved.has(methodName)) {
      continue;
    }

    methods.push(methodName);
  }

  return [...new Set(methods)];
}

function parseModuleDependencies(content) {
  const deps = new Set();
  const regex = /from\s+['"]\.\.\/([^/'"]+)\/[^'"]+['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      deps.add(match[1]);
    }
  }
  return [...deps].sort();
}

function collectSqlTables(content) {
  const tables = new Set();
  const sqlBlocks = [];
  const templateRegex = /`([\s\S]*?)`/g;
  let templateMatch;
  while ((templateMatch = templateRegex.exec(content)) !== null) {
    const block = templateMatch[1];
    if (/\b(select|insert|update|delete|create\s+table|from|join|into)\b/i.test(block)) {
      sqlBlocks.push(block);
    }
  }

  const patterns = [
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi,
    /\bDELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi,
    /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
  ];
  const blacklist = new Set([
    'select',
    'from',
    'join',
    'into',
    'update',
    'delete',
    'create',
    'table',
    'where',
    'group',
    'order',
    'limit',
    'offset',
    'returning',
    'values',
    'set',
    'true',
    'false',
    'null',
    'and',
    'or',
    'on',
    'as',
    'case',
    'when',
    'then',
    'else',
    'end',
  ]);

  for (const block of sqlBlocks) {
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(block)) !== null) {
        if (match[1]) {
          const normalized = match[1].toLowerCase();
          if (!blacklist.has(normalized)) {
            tables.add(normalized);
          }
        }
      }
    }
  }

  return tables;
}

function summarizeModuleDoc({
  moduleName,
  files,
  controllerInfos,
  serviceInfos,
  moduleDependencies,
  tables,
  updatedAt,
}) {
  const fileList = files
    .map((f) => `- \`${path.relative(projectRoot, f)}\``)
    .join('\n') || '- （暂无 TypeScript 文件）';

  const controllerSection = controllerInfos.length
    ? controllerInfos
        .map((controller) => {
          const routes = controller.routes.length
            ? controller.routes
                .map((route) => `| ${route.method} | \`${route.path}\` | \`${route.handler}()\` |`)
                .join('\n')
            : '| - | - | - |';

          return [
            `### ${controller.className}`,
            `- 控制器文件：\`${controller.file}\``,
            `- 基础路由：\`${controller.basePath}\``,
            '',
            '| HTTP 方法 | 路径 | 处理函数 |',
            '| --- | --- | --- |',
            routes,
          ].join('\n');
        })
        .join('\n\n')
    : '当前模块没有 Controller 文件。';

  const serviceSection = serviceInfos.length
    ? serviceInfos
        .map((service) => {
          const methods = service.methods.length
            ? service.methods.map((method) => `- \`${method}()\``).join('\n')
            : '- （未识别到公开方法）';

          return [
            `### ${service.className}`,
            `- 服务文件：\`${service.file}\``,
            '- 核心方法：',
            methods,
          ].join('\n');
        })
        .join('\n\n')
    : '当前模块没有 Service 文件。';

  const depsSection = moduleDependencies.length
    ? moduleDependencies.map((dep) => `- \`${dep}\``).join('\n')
    : '- （未检测到模块级依赖导入）';

  const tableSection = tables.length
    ? tables.map((table) => `- \`${table}\``).join('\n')
    : '- （未检测到显式 SQL 表名，可能使用 Prisma ORM 查询）';

  return `# ${toTitle(moduleName)} 模块文档\n\n> 模块名称：\`${moduleName}\`  \n> 最后更新：${updatedAt}\n\n## 1. 模块定位\n- 负责 \`${moduleName}\` 业务域的路由、服务与数据处理。\n- 本文档用于模块级维护、交接与变更审查。\n\n## 2. 源码目录\n${fileList}\n\n## 3. Controller 与路由\n${controllerSection}\n\n## 4. Service 能力\n${serviceSection}\n\n## 5. 数据库/存储依赖（自动扫描）\n${tableSection}\n\n## 6. 模块依赖（自动扫描）\n${depsSection}\n\n## 7. 维护清单\n- [ ] 路由变更后已同步更新本文档（含请求/响应变化）\n- [ ] Service 新增公开方法已补充用途说明\n- [ ] 数据表变更已补充影响说明与迁移步骤\n- [ ] 已确认与上游模块依赖关系未破坏\n- [ ] 已补充联调示例（如涉及外部调用）\n\n## 8. 变更记录\n- ${updatedAt}：自动生成/刷新模块文档结构与清单。\n`;
}

async function main() {
  const updatedAt = formatDate();
  const moduleDirs = (await fs.readdir(modulesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  await fs.mkdir(moduleDocsRoot, { recursive: true });

  const summaryRows = [];

  for (const moduleName of moduleDirs) {
    const moduleDir = path.join(modulesRoot, moduleName);
    const files = await walkFiles(moduleDir);
    const controllerFiles = files.filter((file) => file.endsWith('.controller.ts'));
    const serviceFiles = files.filter((file) => file.endsWith('.service.ts'));
    const moduleFiles = files.filter((file) => file.endsWith('.module.ts'));

    const controllerInfos = [];
    const serviceInfos = [];
    const tableSet = new Set();
    const depSet = new Set();

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      for (const table of collectSqlTables(content)) {
        tableSet.add(table);
      }
    }

    for (const controllerFile of controllerFiles) {
      const content = await fs.readFile(controllerFile, 'utf8');
      controllerInfos.push({
        className: parseClassName(content),
        file: path.relative(projectRoot, controllerFile),
        basePath: parseControllerBase(content),
        routes: parseControllerRoutes(content),
      });
    }

    for (const serviceFile of serviceFiles) {
      const content = await fs.readFile(serviceFile, 'utf8');
      serviceInfos.push({
        className: parseClassName(content),
        file: path.relative(projectRoot, serviceFile),
        methods: parseServiceMethods(content),
      });
    }

    for (const moduleFile of moduleFiles) {
      const content = await fs.readFile(moduleFile, 'utf8');
      for (const dep of parseModuleDependencies(content)) {
        depSet.add(dep);
      }
    }

    const moduleDocDir = path.join(moduleDocsRoot, moduleName);
    await fs.mkdir(moduleDocDir, { recursive: true });

    const docContent = summarizeModuleDoc({
      moduleName,
      files,
      controllerInfos,
      serviceInfos,
      moduleDependencies: [...depSet].sort(),
      tables: [...tableSet].sort(),
      updatedAt,
    });

    await fs.writeFile(path.join(moduleDocDir, 'README.md'), docContent, 'utf8');

    const routeCount = controllerInfos.reduce((acc, item) => acc + item.routes.length, 0);
    summaryRows.push({
      moduleName,
      controllers: controllerInfos.length,
      services: serviceInfos.length,
      routes: routeCount,
    });
  }

  const modulesIndexTable = summaryRows
    .map(
      (row) =>
        `| [\`${row.moduleName}\`](./${row.moduleName}/README.md) | ${row.controllers} | ${row.services} | ${row.routes} |`,
    )
    .join('\n');

  const modulesIndex = `# 模块文档目录\n\n最后更新：${updatedAt}\n\n## 模块索引\n| 模块 | Controller 数 | Service 数 | 路由数（自动扫描） |\n| --- | ---: | ---: | ---: |\n${modulesIndexTable}\n\n## 维护约定\n- 每次模块新增/删除路由后，执行：\`npm run docs:modules\`\n- 每次模块新增公开 Service 方法后，执行：\`npm run docs:modules\`\n- 如自动扫描结果不足，请在对应模块文档手工补充“联调示例”和“业务约束”\n`;

  const docsReadme = `# OPG Gateway 文档中心\n\n最后更新：${updatedAt}\n\n## 快速导航\n- [专题文档总览](./domains/README.md)\n- [账号管理专题](./domains/account-management.md)\n- [积分充值专题](./domains/points-recharge.md)\n- [用户 AI 能力专题](./domains/user-ai-capabilities.md)\n- [模块文档总览](./modules/README.md)\n- [文档维护手册](./DOCS_MAINTENANCE.md)\n\n## 文档维护目标\n- 覆盖 \`src/modules\` 下每一个模块\n- 提供可检索的路由、服务方法、依赖与数据表清单\n- 支持自动刷新，减少手工维护成本\n\n## 如何刷新模块文档\n在 \`services/gateway\` 目录执行：\n\n\`\`\`bash\nnpm run docs:modules\n\`\`\`\n\n## 文档分层\n- **模块级**：\`docs/modules/<module>/README.md\`\n- **全局索引**：\`docs/modules/README.md\`\n- **项目级入口**：\`docs/README.md\`（本文件）\n- **维护规范**：\`docs/DOCS_MAINTENANCE.md\`\n`;

  const activeModuleNames = new Set(moduleDirs);
  if (await exists(moduleDocsRoot)) {
    const staleDocDirs = await fs.readdir(moduleDocsRoot, { withFileTypes: true });
    for (const entry of staleDocDirs) {
      if (!entry.isDirectory() || activeModuleNames.has(entry.name)) {
        continue;
      }
      await fs.rm(path.join(moduleDocsRoot, entry.name), { recursive: true, force: true });
    }
  }

  await fs.mkdir(path.join(docsRoot, 'modules'), { recursive: true });
  await fs.writeFile(path.join(docsRoot, 'modules', 'README.md'), modulesIndex, 'utf8');
  await fs.writeFile(path.join(docsRoot, 'README.md'), docsReadme, 'utf8');

  console.log(`Generated docs for ${summaryRows.length} modules at ${path.relative(projectRoot, docsRoot)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
