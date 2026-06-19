import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  AppDataColumnRow,
  AppDataIndexRow,
  AppDataPolicyRow,
  AppDataTableRow,
  AppSchemaApp,
} from './app-schema.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AppSchemaService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async getManifest(appRef: string) {
    const app = await this.resolveApp(appRef);
    const namespace = this.namespaceForApp(app.slug);
    const [tables, columns, indexes, policies, migrationRows] = await Promise.all([
      this.listTables(app.id),
      this.listColumns(app.id),
      this.listIndexes(app.id),
      this.listPolicies(app.id),
      this.listMigrationSummary(app.id),
    ]);

    const columnsByTable = this.groupBy(columns, (row) => row.table_id);
    const indexesByTable = this.groupBy(indexes, (row) => row.table_id);
    const policiesByTable = this.groupBy(policies, (row) => row.table_id);

    return {
      manifest_version: '2026-06-19',
      app: this.serializeApp(app),
      namespace,
      capabilities: {
        schema_registry: true,
        structured_tables: true,
        structured_columns: true,
        policies: true,
        data_api: false,
        realtime: false,
        functions: false,
        workflows: false,
      },
      safety: {
        direct_database_url_exposed: false,
        physical_table_prefix: namespace,
        protected_platform_tables: true,
      },
      schema: {
        tables: tables.map((table) => ({
          id: table.id,
          slug: table.slug,
          physical_table_name: table.physical_table_name,
          display_name: table.display_name,
          description: table.description,
          primary_key: table.primary_key,
          owner_column: table.owner_column,
          soft_delete_column: table.soft_delete_column,
          status: table.status,
          settings: this.jsonObject(table.settings_json),
          created_at: table.created_at,
          updated_at: table.updated_at,
          columns: (columnsByTable.get(table.id) || []).map((column) => ({
            id: column.id,
            slug: column.slug,
            physical_column_name: column.physical_column_name,
            data_type: column.data_type,
            is_nullable: column.is_nullable,
            default_value: column.default_value_json ?? null,
            is_unique: column.is_unique,
            is_indexed: column.is_indexed,
            is_hidden: column.is_hidden,
            is_readonly: column.is_readonly,
            validation: this.jsonObject(column.validation_json),
            display: this.jsonObject(column.display_json),
            ordinal_position: column.ordinal_position,
            created_at: column.created_at,
            updated_at: column.updated_at,
          })),
          indexes: (indexesByTable.get(table.id) || []).map((index) => ({
            id: index.id,
            slug: index.slug,
            index_type: index.index_type,
            columns: this.jsonArray(index.columns_json),
            where: index.where_json ?? null,
            is_unique: index.is_unique,
            physical_index_name: index.physical_index_name,
            created_at: index.created_at,
            updated_at: index.updated_at,
          })),
          policies: (policiesByTable.get(table.id) || []).map((policy) => ({
            id: policy.id,
            action: policy.action,
            effect: policy.effect,
            roles: this.jsonArray(policy.roles_json),
            condition: this.jsonObject(policy.condition_json),
            field_mask: this.jsonObject(policy.field_mask_json),
            status: policy.status,
            created_at: policy.created_at,
            updated_at: policy.updated_at,
          })),
        })),
      },
      migrations: {
        total: Number(migrationRows[0]?.total || 0),
        applied: Number(migrationRows[0]?.applied || 0),
        latest_applied_at: migrationRows[0]?.latest_applied_at || null,
      },
    };
  }

  async resolveApp(appRef: string): Promise<AppSchemaApp> {
    const normalized = String(appRef || '').trim();
    if (!normalized) {
      throw new BadRequestException('app is required');
    }
    const rows = await (UUID_RE.test(normalized)
      ? this.prisma.$queryRawUnsafe(
          `SELECT id, slug, name, status::text AS status FROM apps WHERE id = $1::uuid LIMIT 1`,
          normalized,
        )
      : this.prisma.$queryRawUnsafe(
          `SELECT id, slug, name, status::text AS status FROM apps WHERE slug = $1 LIMIT 1`,
          normalized.toLowerCase(),
        )) as AppSchemaApp[];
    const app = rows[0];
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  namespaceForApp(appSlug: string) {
    const normalized = appSlug
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
    const safeSlug = normalized && /^[a-z_]/.test(normalized) ? normalized : `app_${normalized || 'default'}`;
    return `app_${safeSlug}__`;
  }

  private async listTables(appId: string) {
    return this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, slug, physical_table_name, display_name, description, primary_key,
               owner_column, soft_delete_column, status, settings_json, created_at, updated_at
        FROM app_data_tables
        WHERE app_id = $1::uuid
          AND status <> 'DELETED'
        ORDER BY slug ASC
      `,
      appId,
    ) as Promise<AppDataTableRow[]>;
  }

  private async listColumns(appId: string) {
    return this.prisma.$queryRawUnsafe(
      `
        SELECT id, table_id, slug, physical_column_name, data_type, is_nullable, default_value_json,
               is_unique, is_indexed, is_hidden, is_readonly, validation_json, display_json,
               ordinal_position, created_at, updated_at
        FROM app_data_columns
        WHERE app_id = $1::uuid
        ORDER BY table_id ASC, ordinal_position ASC, created_at ASC
      `,
      appId,
    ) as Promise<AppDataColumnRow[]>;
  }

  private async listIndexes(appId: string) {
    return this.prisma.$queryRawUnsafe(
      `
        SELECT id, table_id, slug, index_type, columns_json, where_json, is_unique,
               physical_index_name, created_at, updated_at
        FROM app_data_indexes
        WHERE app_id = $1::uuid
        ORDER BY table_id ASC, slug ASC
      `,
      appId,
    ) as Promise<AppDataIndexRow[]>;
  }

  private async listPolicies(appId: string) {
    return this.prisma.$queryRawUnsafe(
      `
        SELECT id, table_id, action, effect, roles_json, condition_json, field_mask_json,
               status, created_at, updated_at
        FROM app_data_policies
        WHERE app_id = $1::uuid
          AND status <> 'DELETED'
        ORDER BY table_id ASC, action ASC, created_at ASC
      `,
      appId,
    ) as Promise<AppDataPolicyRow[]>;
  }

  private async listMigrationSummary(appId: string) {
    return this.prisma.$queryRawUnsafe(
      `
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'APPLIED')::int AS applied,
               MAX(applied_at) FILTER (WHERE status = 'APPLIED') AS latest_applied_at
        FROM app_schema_migrations
        WHERE app_id = $1::uuid
      `,
      appId,
    ) as Promise<Array<{ total: number; applied: number; latest_applied_at: Date | null }>>;
  }

  private serializeApp(app: AppSchemaApp) {
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      status: app.status,
    };
  }

  private groupBy<T>(items: T[], keyFn: (item: T) => string) {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
      const key = keyFn(item);
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    return grouped;
  }

  private jsonObject(value: unknown) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  private jsonArray(value: unknown) {
    return Array.isArray(value) ? value : [];
  }
}
