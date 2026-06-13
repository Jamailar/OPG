import { useMemo, useState } from 'react';
import { GENERATED_API_DOC_MODULES } from '@/config/generated-api-docs';

type SharedApiItem = {
  id: string;
  module: string;
  moduleLabel: string;
  method: string;
  endpoint: string;
  description: string;
};

type MethodFilter = 'ALL' | SharedApiItem['method'];

export default function SharedApiCatalog() {
  const [query, setQuery] = useState('');
  const [moduleFilter, setModuleFilter] = useState('ALL');
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('ALL');
  const [copiedId, setCopiedId] = useState('');

  const apiList = useMemo<SharedApiItem[]>(() => {
    return GENERATED_API_DOC_MODULES.flatMap((module) =>
      module.routes.map((route) => ({
        id: route.id,
        module: module.module_name,
        moduleLabel: module.module_label,
        method: route.method,
        endpoint: route.path_templates[0] || route.route_path,
        description: route.summary || `${route.controller_name}.${route.handler}()`,
      })),
    );
  }, []);

  const modules = useMemo(() => {
    return Array.from(new Set(apiList.map((item) => item.moduleLabel))).sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN'),
    );
  }, [apiList]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return apiList.filter((item) => {
      if (moduleFilter !== 'ALL' && item.moduleLabel !== moduleFilter) return false;
      if (methodFilter !== 'ALL' && item.method !== methodFilter) return false;
      if (!normalized) return true;
      return (
        item.endpoint.toLowerCase().includes(normalized) ||
        item.description.toLowerCase().includes(normalized) ||
        item.moduleLabel.toLowerCase().includes(normalized)
      );
    });
  }, [apiList, moduleFilter, methodFilter, query]);

  const copyEndpoint = async (item: SharedApiItem) => {
    try {
      await navigator.clipboard.writeText(item.endpoint);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId(''), 1200);
    } catch {
      setCopiedId('');
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-head">
        <div>
          <h1>共享 API 列表</h1>
          <p>收录所有共享网关端点，支持按模块、方法和关键词检索。</p>
        </div>
      </div>

      <section className="card">
        <div className="platform-filter-row">
          <input
            className="platform-filter-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索端点 / 描述 / 模块"
          />
          <select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}>
            <option value="ALL">全部模块</option>
            {modules.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
          <select value={methodFilter} onChange={(event) => setMethodFilter(event.target.value as MethodFilter)}>
            <option value="ALL">全部方法</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
          <div className="platform-filter-hint">共 {filtered.length} 个端点</div>
        </div>
      </section>

      <section className="card">
        <div className="platform-api-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>方法</th>
                <th>端点</th>
                <th>模块</th>
                <th>中文说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className={`platform-method-badge method-${item.method.toLowerCase()}`}>
                      {item.method}
                    </span>
                  </td>
                  <td>
                    <code>{item.endpoint}</code>
                  </td>
                  <td>{item.moduleLabel}</td>
                  <td>{item.description}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => copyEndpoint(item)}>
                      {copiedId === item.id ? '已复制' : '复制端点'}
                    </button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={5}>没有匹配结果</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
