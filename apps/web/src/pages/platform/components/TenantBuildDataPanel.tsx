import { useEffect, useMemo, useState } from 'react';
import { platformApi } from '@/lib/api';
import type { PlatformAppBuildEventItem, PlatformAppBuildSummary, PlatformAppSchemaManifest, PlatformAppSchemaTable } from '@/lib/api';
import { pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;

interface TenantBuildDataPanelProps {
  appId: string;
  appSlug?: string;
  onMessage?: (message: Message) => void;
}

const DATA_TYPES = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'uuid', 'jsonb', 'timestamptz', 'date'];

function parseColumnSpecs(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, dataType = 'text'] = item.split(':').map((part) => part.trim());
      return { name, data_type: dataType || 'text' };
    });
}

export default function TenantBuildDataPanel({ appId, appSlug, onMessage }: TenantBuildDataPanelProps) {
  const [manifest, setManifest] = useState<PlatformAppSchemaManifest | null>(null);
  const [buildSummary, setBuildSummary] = useState<PlatformAppBuildSummary | null>(null);
  const [buildEvents, setBuildEvents] = useState<PlatformAppBuildEventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingTable, setSavingTable] = useState(false);
  const [savingColumn, setSavingColumn] = useState(false);
  const [selectedTableSlug, setSelectedTableSlug] = useState('');
  const [tableForm, setTableForm] = useState({
    name: '',
    columns: 'email:text,name:text',
    soft_delete: true,
  });
  const [columnForm, setColumnForm] = useState({
    name: '',
    data_type: 'text',
    nullable: true,
    indexed: false,
  });

  const tables = manifest?.schema?.tables || [];
  const selectedTable = useMemo<PlatformAppSchemaTable | null>(
    () => tables.find((table) => table.slug === selectedTableSlug) || tables[0] || null,
    [selectedTableSlug, tables],
  );

  const loadManifest = async () => {
    if (!appId) return;
    setLoading(true);
    try {
      const nextManifest = await platformApi.getAppSchemaManifest(appId);
      setManifest(nextManifest);
      const [summary, events] = await Promise.all([
        platformApi.getAppBuildSummary(appId).catch(() => null),
        platformApi.getAppBuildEvents(appId, 12).catch(() => ({ items: [] })),
      ]);
      setBuildSummary(summary);
      setBuildEvents(events.items || []);
      if (!selectedTableSlug && nextManifest.schema.tables[0]) {
        setSelectedTableSlug(nextManifest.schema.tables[0].slug);
      }
    } catch (error) {
      onMessage?.({ type: 'error', text: pickApiErrorMessage(error, '加载 Data schema 失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadManifest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const createTable = async () => {
    if (!tableForm.name.trim()) {
      onMessage?.({ type: 'error', text: '请填写表名' });
      return;
    }
    setSavingTable(true);
    try {
      await platformApi.createAppDataTable(appId, {
        name: tableForm.name,
        columns: parseColumnSpecs(tableForm.columns),
        soft_delete: tableForm.soft_delete,
        dry_run: false,
      });
      setTableForm({ name: '', columns: 'email:text,name:text', soft_delete: true });
      onMessage?.({ type: 'success', text: '数据表已创建' });
      await loadManifest();
    } catch (error) {
      onMessage?.({ type: 'error', text: pickApiErrorMessage(error, '创建数据表失败') });
    } finally {
      setSavingTable(false);
    }
  };

  const addColumn = async () => {
    if (!selectedTable || !columnForm.name.trim()) {
      onMessage?.({ type: 'error', text: '请选择表并填写字段名' });
      return;
    }
    setSavingColumn(true);
    try {
      await platformApi.addAppDataColumn(appId, selectedTable.slug, {
        name: columnForm.name,
        data_type: columnForm.data_type,
        nullable: columnForm.nullable,
        indexed: columnForm.indexed,
        dry_run: false,
      });
      setColumnForm({ name: '', data_type: 'text', nullable: true, indexed: false });
      onMessage?.({ type: 'success', text: '字段已添加' });
      await loadManifest();
    } catch (error) {
      onMessage?.({ type: 'error', text: pickApiErrorMessage(error, '添加字段失败') });
    } finally {
      setSavingColumn(false);
    }
  };

  return (
    <div className="tenant-section-stack">
      <section className="card">
        <div className="platform-section-head">
          <div>
            <h3>Data</h3>
            <p>{manifest ? `${manifest.namespace} · ${tables.length} tables` : 'Schema registry'}</p>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={loadManifest} disabled={loading}>
            刷新
          </button>
        </div>

        <div className="platform-form-grid compact">
          <label>
            表名
            <input value={tableForm.name} onChange={(event) => setTableForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="customers" />
          </label>
          <label>
            字段
            <input value={tableForm.columns} onChange={(event) => setTableForm((prev) => ({ ...prev, columns: event.target.value }))} placeholder="email:text,name:text" />
          </label>
          <label>
            Soft delete
            <select value={tableForm.soft_delete ? 'true' : 'false'} onChange={(event) => setTableForm((prev) => ({ ...prev, soft_delete: event.target.value === 'true' }))}>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </label>
          <div className="platform-form-actions">
            <button className="btn btn-primary btn-sm" type="button" onClick={createTable} disabled={savingTable}>
              创建表
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="platform-section-head">
          <div>
            <h3>Tables</h3>
            <p>{selectedTable ? selectedTable.physical_table_name : '-'}</p>
          </div>
        </div>

        <div className="platform-grid-two">
          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>表</th>
                  <th>字段</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((table) => (
                  <tr key={table.id} className={selectedTable?.id === table.id ? 'table-row-selected' : ''} onClick={() => setSelectedTableSlug(table.slug)}>
                    <td><strong>{table.slug}</strong></td>
                    <td>{table.columns.length}</td>
                    <td><span className="status-tag success">{table.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!tables.length && <div className="loading">暂无自定义表</div>}
          </div>

          <div className="platform-form-grid compact">
            <label>
              表
              <select value={selectedTable?.slug || ''} onChange={(event) => setSelectedTableSlug(event.target.value)}>
                {tables.map((table) => <option key={table.id} value={table.slug}>{table.slug}</option>)}
              </select>
            </label>
            <label>
              字段名
              <input value={columnForm.name} onChange={(event) => setColumnForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="phone" />
            </label>
            <label>
              类型
              <select value={columnForm.data_type} onChange={(event) => setColumnForm((prev) => ({ ...prev, data_type: event.target.value }))}>
                {DATA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              Nullable
              <select value={columnForm.nullable ? 'true' : 'false'} onChange={(event) => setColumnForm((prev) => ({ ...prev, nullable: event.target.value === 'true' }))}>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
            <label>
              Index
              <select value={columnForm.indexed ? 'true' : 'false'} onChange={(event) => setColumnForm((prev) => ({ ...prev, indexed: event.target.value === 'true' }))}>
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </label>
            <div className="platform-form-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={addColumn} disabled={savingColumn || !selectedTable}>
                添加字段
              </button>
            </div>
          </div>
        </div>
      </section>

      {selectedTable && (
        <section className="card">
          <div className="platform-section-head">
            <div>
              <h3>{selectedTable.slug}</h3>
              <p>{selectedTable.columns.length} columns</p>
            </div>
          </div>
          <div className="platform-api-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>类型</th>
                  <th>Nullable</th>
                  <th>Index</th>
                </tr>
              </thead>
              <tbody>
                {selectedTable.columns.map((column) => (
                  <tr key={column.id}>
                    <td><code>{column.slug}</code></td>
                    <td>{column.data_type}</td>
                    <td>{column.is_nullable ? 'true' : 'false'}</td>
                    <td>{column.is_indexed ? 'true' : 'false'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="code-block">
            <pre>{[
              `GET /${appSlug || manifest?.app.slug || ':app'}/v1/data/${selectedTable.slug}`,
              `POST /${appSlug || manifest?.app.slug || ':app'}/v1/data/${selectedTable.slug}`,
              `opg.data.table('${selectedTable.slug}').list()`,
            ].join('\n')}</pre>
          </div>
        </section>
      )}

      <section className="card">
        <div className="platform-section-head">
          <div>
            <h3>Activity</h3>
            <p>{buildSummary ? `${buildSummary.summary.schema_events || 0} schema · ${buildSummary.summary.function_runs || 0} functions · ${buildSummary.summary.workflow_runs || 0} workflows` : '-'}</p>
          </div>
        </div>
        <div className="platform-api-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Event</th>
                <th>Resource</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {buildEvents.map((event) => (
                <tr key={`${event.source}-${event.resource_id}-${event.created_at}`}>
                  <td>{event.source}</td>
                  <td>{event.event}</td>
                  <td>{event.resource_type}</td>
                  <td>{new Date(event.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!buildEvents.length && <div className="loading">暂无事件</div>}
        </div>
      </section>
    </div>
  );
}
