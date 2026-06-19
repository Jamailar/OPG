import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { DeveloperAuthorizationService } from '../developer-sdk/developer-authorization.service';
import {
  AddAppDataColumnInput,
  AppDataColumnRow,
  AppDataIndexRow,
  AppDataPolicyRow,
  AppDataTableRow,
  CreateAppDataColumnInput,
  CreateAppDataTableInput,
  AppSchemaApp,
  UpsertAppDataPolicyInput,
} from './app-schema.types';
import { PolicyEngineService } from './policy-engine.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{1,78}$/;
const MAX_COLUMNS_PER_CREATE = 80;
const DATA_TYPES: Record<string, string> = {
  text: 'text',
  varchar: 'varchar(255)',
  integer: 'integer',
  int: 'integer',
  bigint: 'bigint',
  numeric: 'numeric',
  boolean: 'boolean',
  bool: 'boolean',
  uuid: 'uuid',
  jsonb: 'jsonb',
  timestamptz: 'timestamptz',
  timestamp: 'timestamptz',
  date: 'date',
};

@Injectable()
export class AppSchemaService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly developerAuthorizationService: DeveloperAuthorizationService,
    private readonly policyEngineService: PolicyEngineService,
    private readonly realtimeEventsService: RealtimeEventsService,
  ) {}

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

  async createTable(appRef: string, actor: { userId?: string | null; id?: string | null; apiKeyId?: string | null } | undefined, input: CreateAppDataTableInput) {
    const app = await this.resolveApp(appRef);
    const tableSlug = this.normalizeIdentifier(input?.slug || input?.name, 'table slug');
    const physicalTableName = `${this.namespaceForApp(app.slug)}${tableSlug}`;
    const displayName = this.optionalString(input?.display_name ?? input?.displayName ?? input?.name ?? tableSlug, 160);
    const description = this.optionalString(input?.description, 2000);
    const ownerColumn = this.optionalIdentifier(input?.owner_column ?? input?.ownerColumn, 'owner column');
    const softDeleteColumn = input?.soft_delete || input?.softDelete ? 'deleted_at' : null;
    const dryRun = input?.dry_run !== undefined ? input.dry_run !== false : input?.dryRun !== false;
    const columns = this.normalizeCreateColumns(input?.columns || [], { ownerColumn, softDeleteColumn });

    await this.assertTableSlugAvailable(app.id, tableSlug);
    const sqlStatements = this.buildCreateTableSql(physicalTableName, columns);
    const sql = sqlStatements.join(';\n') + ';';

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        applied: false,
        app: this.serializeApp(app),
        table: {
          slug: tableSlug,
          physical_table_name: physicalTableName,
          columns,
        },
        sql,
        next: { apply_with: { dry_run: false } },
      };
    }

    const actorUserId = this.actorUserId(actor);
    const apiKeyId = this.optionalUuid(actor?.apiKeyId);
    const checksum = this.sha256(sql);
    const migrationKey = `create_table_${tableSlug}_${Date.now()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, app.id);
      for (const statement of sqlStatements) {
        await tx.$executeRawUnsafe(statement);
      }
      const tableRows = await (tx.$queryRawUnsafe(
        `
          INSERT INTO app_data_tables (
            app_id, slug, physical_table_name, display_name, description, primary_key,
            owner_column, soft_delete_column, status, settings_json, created_by_user_id, updated_by_user_id
          ) VALUES ($1::uuid, $2, $3, $4, $5, 'id', $6, $7, 'ACTIVE', '{}'::jsonb, $8::uuid, $8::uuid)
          RETURNING id
        `,
        app.id,
        tableSlug,
        physicalTableName,
        displayName,
        description,
        ownerColumn,
        softDeleteColumn,
        actorUserId,
      ) as Promise<Array<{ id: string }>>);
      const tableId = tableRows[0]?.id;
      if (!tableId) throw new Error('Failed to create app data table');
      for (const [index, column] of columns.entries()) {
        await tx.$executeRawUnsafe(
          `
            INSERT INTO app_data_columns (
              app_id, table_id, slug, physical_column_name, data_type, is_nullable,
              default_value_json, is_unique, is_indexed, is_hidden, is_readonly,
              validation_json, display_json, ordinal_position
            ) VALUES (
              $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
              $12::jsonb, $13::jsonb, $14
            )
          `,
          app.id,
          tableId,
          column.slug,
          column.physical_column_name,
          column.data_type,
          column.is_nullable,
          column.default_value_json === null ? null : JSON.stringify(column.default_value_json),
          column.is_unique,
          column.is_indexed,
          column.is_hidden,
          column.is_readonly,
          JSON.stringify(column.validation_json),
          JSON.stringify(column.display_json),
          index,
        );
      }
      await tx.$executeRawUnsafe(
        `
          INSERT INTO app_schema_migrations (
            app_id, migration_key, title, status, dry_run_sql, applied_sql, checksum,
            created_by_user_id, applied_by_user_id, applied_at
          ) VALUES ($1::uuid, $2, $3, 'APPLIED', $4, $4, $5, $6::uuid, $6::uuid, now())
        `,
        app.id,
        migrationKey,
        `Create data table ${tableSlug}`,
        sql,
        checksum,
        actorUserId,
      );
      await this.recordSchemaEventTx(tx, app.id, actorUserId, apiKeyId, 'table', tableId, 'schema.table.created', null, {
        slug: tableSlug,
        physical_table_name: physicalTableName,
        columns: columns.map((column) => column.slug),
      }, checksum);
      return { tableId };
    });

    return {
      ok: true,
      dry_run: false,
      applied: true,
      app: this.serializeApp(app),
      table: {
        id: created.tableId,
        slug: tableSlug,
        physical_table_name: physicalTableName,
        columns,
      },
      migration: {
        key: migrationKey,
        checksum,
      },
      sql,
    };
  }

  async addColumn(appRef: string, tableRef: string, actor: { userId?: string | null; id?: string | null; apiKeyId?: string | null } | undefined, input: AddAppDataColumnInput) {
    const app = await this.resolveApp(appRef);
    const table = await this.resolveTable(app.id, tableRef);
    const dryRun = input?.dry_run !== undefined ? input.dry_run !== false : input?.dryRun !== false;
    const column = this.normalizeColumnInput(input, { reserved: new Set(['id', 'created_at', 'updated_at', table.soft_delete_column || '']) });
    await this.assertColumnSlugAvailable(table.id, column.slug);
    const sqlStatements = this.buildAddColumnSql(table.physical_table_name, column);
    const sql = sqlStatements.join(';\n') + ';';

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        applied: false,
        app: this.serializeApp(app),
        table: {
          id: table.id,
          slug: table.slug,
          physical_table_name: table.physical_table_name,
        },
        column,
        sql,
        next: { apply_with: { dry_run: false } },
      };
    }

    const actorUserId = this.actorUserId(actor);
    const apiKeyId = this.optionalUuid(actor?.apiKeyId);
    const checksum = this.sha256(sql);
    const migrationKey = `add_column_${table.slug}_${column.slug}_${Date.now()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, app.id);
      for (const statement of sqlStatements) {
        await tx.$executeRawUnsafe(statement);
      }
      const positionRows = await (tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(ordinal_position), -1) + 1 AS next_position FROM app_data_columns WHERE table_id = $1::uuid`,
        table.id,
      ) as Promise<Array<{ next_position: number }>>);
      const columnRows = await (tx.$queryRawUnsafe(
        `
          INSERT INTO app_data_columns (
            app_id, table_id, slug, physical_column_name, data_type, is_nullable,
            default_value_json, is_unique, is_indexed, is_hidden, is_readonly,
            validation_json, display_json, ordinal_position
          ) VALUES (
            $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
            $12::jsonb, $13::jsonb, $14
          )
          RETURNING id
        `,
        app.id,
        table.id,
        column.slug,
        column.physical_column_name,
        column.data_type,
        column.is_nullable,
        column.default_value_json === null ? null : JSON.stringify(column.default_value_json),
        column.is_unique,
        column.is_indexed,
        column.is_hidden,
        column.is_readonly,
        JSON.stringify(column.validation_json),
        JSON.stringify(column.display_json),
        Number(positionRows[0]?.next_position || 0),
      ) as Promise<Array<{ id: string }>>);
      const columnId = columnRows[0]?.id;
      if (!columnId) throw new Error('Failed to create app data column');
      await tx.$executeRawUnsafe(
        `
          INSERT INTO app_schema_migrations (
            app_id, migration_key, title, status, dry_run_sql, applied_sql, checksum,
            created_by_user_id, applied_by_user_id, applied_at
          ) VALUES ($1::uuid, $2, $3, 'APPLIED', $4, $4, $5, $6::uuid, $6::uuid, now())
        `,
        app.id,
        migrationKey,
        `Add data column ${table.slug}.${column.slug}`,
        sql,
        checksum,
        actorUserId,
      );
      await this.recordSchemaEventTx(tx, app.id, actorUserId, apiKeyId, 'column', columnId, 'schema.column.created', null, {
        table: table.slug,
        slug: column.slug,
        physical_column_name: column.physical_column_name,
      }, checksum);
      return { columnId };
    });

    return {
      ok: true,
      dry_run: false,
      applied: true,
      app: this.serializeApp(app),
      table: {
        id: table.id,
        slug: table.slug,
        physical_table_name: table.physical_table_name,
      },
      column: {
        id: created.columnId,
        ...column,
      },
      migration: {
        key: migrationKey,
        checksum,
      },
      sql,
    };
  }

  async dropTable(appRef: string, tableRef: string, actor: any, input: Record<string, unknown> = {}) {
    const app = await this.resolveApp(appRef);
    const table = await this.resolveTable(app.id, tableRef);
    const dryRun = input?.dry_run !== undefined ? input.dry_run !== false : input?.dryRun !== false;
    const confirm = String(input?.confirm || '').trim();
    const sql = `DROP TABLE IF EXISTS ${this.q(table.physical_table_name)};`;
    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        applied: false,
        app: this.serializeApp(app),
        table: this.serializeTableRef(table),
        sql,
        next: { apply_with: { dry_run: false, confirm: `drop:${table.slug}` } },
      };
    }
    if (confirm !== `drop:${table.slug}`) {
      throw new BadRequestException(`confirm must be drop:${table.slug}`);
    }
    const actorUserId = this.actorUserId(actor);
    const apiKeyId = this.optionalUuid(actor?.apiKeyId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, app.id);
      await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe(`UPDATE app_data_tables SET status = 'DELETED', updated_by_user_id = $1::uuid, updated_at = now() WHERE id = $2::uuid`, actorUserId, table.id);
      await this.recordSchemaEventTx(tx, app.id, actorUserId, apiKeyId, 'table', table.id, 'schema.table.deleted', {
        slug: table.slug,
        physical_table_name: table.physical_table_name,
      }, null, this.sha256(sql));
    });
    return {
      ok: true,
      dry_run: false,
      applied: true,
      app: this.serializeApp(app),
      table: this.serializeTableRef(table),
      sql,
    };
  }

  async upsertPolicy(appRef: string, tableRef: string, actor: any, input: UpsertAppDataPolicyInput) {
    const app = await this.resolveApp(appRef);
    const table = await this.resolveTable(app.id, tableRef);
    const columns = await this.listColumnsForTable(app.id, table.id);
    const actorUserId = this.actorUserId(actor);
    const apiKeyId = this.optionalUuid(actor?.apiKeyId);
    const template = String(input?.template || '').trim();
    const policies = template
      ? this.policyEngineService.templatePolicy(template, table).map((policy) => ({ ...policy, status: 'ACTIVE' }))
      : [this.normalizePolicyInput(input)];
    const created: Array<{ id: string; action: string; effect: string; roles: string[]; condition: unknown; field_mask: unknown }> = [];

    await this.prisma.$transaction(async (tx) => {
      for (const policy of policies) {
        this.policyEngineService.validatePolicy({ columns, condition: policy.condition, fieldMask: policy.field_mask });
        const rows = input?.id && !template
          ? await (tx.$queryRawUnsafe(
              `
                UPDATE app_data_policies
                   SET action = $1, effect = $2, roles_json = $3::jsonb,
                       condition_json = $4::jsonb, field_mask_json = $5::jsonb,
                       status = $6, updated_at = now()
                 WHERE id = $7::uuid
                   AND app_id = $8::uuid
                   AND table_id = $9::uuid
                RETURNING id
              `,
              policy.action,
              policy.effect,
              JSON.stringify(policy.roles),
              JSON.stringify(policy.condition),
              JSON.stringify(policy.field_mask),
              policy.status,
              input.id,
              app.id,
              table.id,
            ) as Promise<Array<{ id: string }>>)
          : await (tx.$queryRawUnsafe(
              `
                INSERT INTO app_data_policies (
                  app_id, table_id, action, effect, roles_json, condition_json, field_mask_json, status
                ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
                RETURNING id
              `,
              app.id,
              table.id,
              policy.action,
              policy.effect,
              JSON.stringify(policy.roles),
              JSON.stringify(policy.condition),
              JSON.stringify(policy.field_mask),
              policy.status,
            ) as Promise<Array<{ id: string }>>);
        const policyId = rows[0]?.id;
        if (!policyId) {
          throw new NotFoundException('Policy not found');
        }
        created.push({ id: policyId, ...policy });
        await this.recordSchemaEventTx(tx, app.id, actorUserId, apiKeyId, 'policy', policyId, input?.id ? 'schema.policy.updated' : 'schema.policy.created', null, {
          table: table.slug,
          action: policy.action,
          effect: policy.effect,
          roles: policy.roles,
          condition: policy.condition,
          field_mask: policy.field_mask,
        }, null);
      }
    });

    return {
      ok: true,
      app: this.serializeApp(app),
      table: this.serializeTableRef(table),
      policies: created,
    };
  }

  async getDataSchema(appRef: string, actor: any) {
    const { app } = await this.assertDataAccess(appRef, actor, 'read');
    const manifest = await this.getManifest(app.id);
    return {
      app: manifest.app,
      namespace: manifest.namespace,
      tables: manifest.schema.tables.map((table: any) => ({
        slug: table.slug,
        display_name: table.display_name,
        primary_key: table.primary_key,
        columns: table.columns
          .filter((column: any) => !column.is_hidden)
          .map((column: any) => ({
            slug: column.slug,
            data_type: column.data_type,
            is_nullable: column.is_nullable,
            is_readonly: column.is_readonly,
          })),
      })),
    };
  }

  async listRows(appRef: string, tableRef: string, actor: any, query: Record<string, unknown>) {
    const { app, table, columns, policies, policyActor } = await this.resolveDataRequest(appRef, tableRef, actor, 'read');
    const limit = this.normalizeLimit(query?.limit);
    const readPolicy = this.policyEngineService.compileReadPolicy({ table, columns, policies, actor: policyActor, paramOffset: 0 });
    const selectedColumns = this.resolveSelectedColumns(readPolicy.visibleColumns, query?.select);
    const order = this.resolveOrder(readPolicy.visibleColumns, query?.order, table.primary_key);
    const filters = this.resolveFilters(columns, query);
    const whereParts = [...filters.sql];
    const params = [...filters.params];
    if (table.soft_delete_column && columns.some((column) => column.slug === table.soft_delete_column)) {
      whereParts.push(`${this.q(table.soft_delete_column)} IS NULL`);
    }
    if (readPolicy.params.length) {
      const rebased = this.rebaseSqlParams(readPolicy.where, params.length);
      whereParts.push(...rebased.sql);
      params.push(...readPolicy.params);
    } else {
      whereParts.push(...readPolicy.where);
    }
    const sql = [
      `SELECT ${selectedColumns.map((column) => this.q(column.physical_column_name)).join(', ')}`,
      `FROM ${this.q(table.physical_table_name)}`,
      whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '',
      `ORDER BY ${this.q(order.column.physical_column_name)} ${order.direction}`,
      `LIMIT $${params.length + 1}`,
    ].filter(Boolean).join(' ');
    const rows = await (this.prisma.$queryRawUnsafe(sql, ...params, limit + 1) as Promise<Record<string, unknown>[]>);
    const truncated = rows.length > limit;
    return {
      ok: true,
      app: this.serializeApp(app),
      table: this.serializeTableRef(table),
      rows: rows.slice(0, limit),
      row_count: Math.min(rows.length, limit),
      truncated,
      limit,
    };
  }

  async getRow(appRef: string, tableRef: string, id: string, actor: any, query: Record<string, unknown>) {
    const { app, table, columns, policies, policyActor } = await this.resolveDataRequest(appRef, tableRef, actor, 'read');
    const readPolicy = this.policyEngineService.compileReadPolicy({ table, columns, policies, actor: policyActor, paramOffset: 1 });
    const selectedColumns = this.resolveSelectedColumns(readPolicy.visibleColumns, query?.select);
    const whereParts = [this.primaryKeyPredicate(table, columns, 1)];
    if (table.soft_delete_column && columns.some((column) => column.slug === table.soft_delete_column)) {
      whereParts.push(`${this.q(table.soft_delete_column)} IS NULL`);
    }
    whereParts.push(...readPolicy.where);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT ${selectedColumns.map((column) => this.q(column.physical_column_name)).join(', ')}
         FROM ${this.q(table.physical_table_name)}
        WHERE ${whereParts.join(' AND ')}
        LIMIT 1`,
      id,
      ...readPolicy.params,
    ) as Promise<Record<string, unknown>[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Data row not found');
    }
    return {
      ok: true,
      app: this.serializeApp(app),
      table: this.serializeTableRef(table),
      row,
    };
  }

  async createRow(appRef: string, tableRef: string, actor: any, body: Record<string, unknown>) {
    const { app, table, columns, policies, policyActor } = await this.resolveDataRequest(appRef, tableRef, actor, 'write');
    const writable = columns.filter((column) => !column.is_readonly && !['id', 'created_at', 'updated_at', table.soft_delete_column || ''].includes(column.slug));
    const payload = this.pickWritablePayload(writable, body || {});
    if (!policyActor.privileged && table.owner_column && policyActor.userId && !Object.prototype.hasOwnProperty.call(payload, table.owner_column)) {
      payload[table.owner_column] = policyActor.userId;
    }
    this.policyEngineService.assertCreateAllowed({ columns, policies, actor: policyActor, payload });
    const insertColumns = Object.keys(payload);
    const values = Object.values(payload);
    const returning = this.visibleColumns(columns);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO ${this.q(table.physical_table_name)} (${insertColumns.map((column) => this.q(column)).join(', ')})
        VALUES (${insertColumns.map((_, index) => `$${index + 1}`).join(', ')})
        RETURNING ${returning.map((column) => this.q(column.physical_column_name)).join(', ')}
      `,
      ...values,
    ) as Promise<Record<string, unknown>[]>);
    await this.recordDataEvent(app.id, actor, table.id, 'data.row.created', rows[0]?.[table.primary_key]);
    void this.realtimeEventsService.publishDataEvent({
      appId: app.id,
      appSlug: app.slug,
      table: table.slug,
      event: 'row.created',
      rowId: rows[0]?.[table.primary_key],
      changedFields: insertColumns,
    });
    return {
      ok: true,
      app: this.serializeApp(app),
      table: this.serializeTableRef(table),
      row: rows[0],
    };
  }

  async updateRow(appRef: string, tableRef: string, id: string, actor: any, body: Record<string, unknown>) {
    const { app, table, columns, policies, policyActor } = await this.resolveDataRequest(appRef, tableRef, actor, 'write');
    const writable = columns.filter((column) => !column.is_readonly && !['id', 'created_at', 'updated_at', table.soft_delete_column || ''].includes(column.slug));
    const payload = this.pickWritablePayload(writable, body || {});
    if (columns.some((column) => column.slug === 'updated_at')) {
      payload.updated_at = new Date();
    }
    const setColumns = Object.keys(payload);
    if (!setColumns.length) {
      throw new BadRequestException('No writable fields provided');
    }
    const values = Object.values(payload);
    const returning = this.visibleColumns(columns);
    const params = [...values, id];
    const whereParts = [this.primaryKeyPredicate(table, columns, params.length)];
    if (table.soft_delete_column && columns.some((column) => column.slug === table.soft_delete_column)) {
      whereParts.push(`${this.q(table.soft_delete_column)} IS NULL`);
    }
    const writePolicy = this.policyEngineService.compileRowWritePolicy({ columns, policies, actor: policyActor, action: 'update', paramOffset: params.length });
    whereParts.push(...writePolicy.where);
    params.push(...writePolicy.params);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE ${this.q(table.physical_table_name)}
           SET ${setColumns.map((column, index) => `${this.q(column)} = $${index + 1}`).join(', ')}
         WHERE ${whereParts.join(' AND ')}
        RETURNING ${returning.map((column) => this.q(column.physical_column_name)).join(', ')}
      `,
      ...params,
    ) as Promise<Record<string, unknown>[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Data row not found');
    }
    await this.recordDataEvent(app.id, actor, table.id, 'data.row.updated', row[table.primary_key]);
    void this.realtimeEventsService.publishDataEvent({
      appId: app.id,
      appSlug: app.slug,
      table: table.slug,
      event: 'row.updated',
      rowId: row[table.primary_key],
      changedFields: setColumns,
    });
    return {
      ok: true,
      app: this.serializeApp(app),
      table: this.serializeTableRef(table),
      row,
    };
  }

  async deleteRow(appRef: string, tableRef: string, id: string, actor: any) {
    const { app, table, columns, policies, policyActor } = await this.resolveDataRequest(appRef, tableRef, actor, 'write');
    const hasSoftDelete = !!table.soft_delete_column && columns.some((column) => column.slug === table.soft_delete_column);
    const returning = this.visibleColumns(columns);
    const writePolicy = this.policyEngineService.compileRowWritePolicy({ columns, policies, actor: policyActor, action: 'delete', paramOffset: 1 });
    const policyWhere = writePolicy.where.length ? ` AND ${writePolicy.where.join(' AND ')}` : '';
    const rows = await (this.prisma.$queryRawUnsafe(
      hasSoftDelete
        ? `
            UPDATE ${this.q(table.physical_table_name)}
               SET ${this.q(table.soft_delete_column!)} = now()
             WHERE ${this.primaryKeyPredicate(table, columns, 1)}
               AND ${this.q(table.soft_delete_column!)} IS NULL
               ${policyWhere}
            RETURNING ${returning.map((column) => this.q(column.physical_column_name)).join(', ')}
          `
        : `
            DELETE FROM ${this.q(table.physical_table_name)}
             WHERE ${this.primaryKeyPredicate(table, columns, 1)}
               ${policyWhere}
            RETURNING ${returning.map((column) => this.q(column.physical_column_name)).join(', ')}
          `,
      id,
      ...writePolicy.params,
    ) as Promise<Record<string, unknown>[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Data row not found');
    }
    await this.recordDataEvent(app.id, actor, table.id, 'data.row.deleted', row[table.primary_key]);
    void this.realtimeEventsService.publishDataEvent({
      appId: app.id,
      appSlug: app.slug,
      table: table.slug,
      event: 'row.deleted',
      rowId: row[table.primary_key],
      changedFields: [],
    });
    return {
      ok: true,
      app: this.serializeApp(app),
      table: this.serializeTableRef(table),
      deleted: true,
      soft_deleted: hasSoftDelete,
      row,
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

  async resolveTable(appId: string, tableRef: string): Promise<AppDataTableRow> {
    const normalized = String(tableRef || '').trim();
    if (!normalized) {
      throw new BadRequestException('table is required');
    }
    const rows = await (UUID_RE.test(normalized)
      ? this.prisma.$queryRawUnsafe(
          `
            SELECT id, app_id, slug, physical_table_name, display_name, description, primary_key,
                   owner_column, soft_delete_column, status, settings_json, created_at, updated_at
            FROM app_data_tables
            WHERE app_id = $1::uuid AND id = $2::uuid AND status <> 'DELETED'
            LIMIT 1
          `,
          appId,
          normalized,
        )
      : this.prisma.$queryRawUnsafe(
          `
            SELECT id, app_id, slug, physical_table_name, display_name, description, primary_key,
                   owner_column, soft_delete_column, status, settings_json, created_at, updated_at
            FROM app_data_tables
            WHERE app_id = $1::uuid AND slug = $2 AND status <> 'DELETED'
            LIMIT 1
          `,
          appId,
          this.normalizeIdentifier(normalized, 'table'),
        )) as AppDataTableRow[];
    const table = rows[0];
    if (!table) {
      throw new NotFoundException('Data table not found');
    }
    return table;
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

  private async resolveDataRequest(appRef: string, tableRef: string, actor: any, mode: 'read' | 'write') {
    const { app } = await this.assertDataAccess(appRef, actor, mode);
    const table = await this.resolveTable(app.id, tableRef);
    const [columns, policies] = await Promise.all([
      this.listColumnsForTable(app.id, table.id),
      this.listPoliciesForTable(app.id, table.id),
    ]);
    return { app, table, columns, policies, policyActor: this.policyEngineService.buildActorContext(app.id, actor) };
  }

  private async assertDataAccess(appRef: string, actor: any, mode: 'read' | 'write') {
    const app = await this.resolveApp(appRef || actor?.appSlug);
    if (actor?.appSlug && actor.appSlug !== app.slug) {
      throw new ForbiddenException('Actor does not belong to this app');
    }
    if (actor?.authMode === 'developer_grant') {
      this.developerAuthorizationService.assertActorScope(actor, mode === 'read' ? 'database:data:read' : 'database:data:write');
      return { app };
    }
    if (actor?.authMode === 'api_key') {
      return { app };
    }
    if (String(actor?.role || '').toUpperCase() === 'ADMIN') {
      return { app };
    }
    if (actor?.userId || actor?.id) {
      return { app };
    }
    throw new ForbiddenException('Data API access requires authenticated app user, app admin, app API key, or developer grant');
  }

  private async listColumnsForTable(appId: string, tableId: string) {
    return this.prisma.$queryRawUnsafe(
      `
        SELECT id, table_id, slug, physical_column_name, data_type, is_nullable, default_value_json,
               is_unique, is_indexed, is_hidden, is_readonly, validation_json, display_json,
               ordinal_position, created_at, updated_at
        FROM app_data_columns
        WHERE app_id = $1::uuid
          AND table_id = $2::uuid
        ORDER BY ordinal_position ASC, created_at ASC
      `,
      appId,
      tableId,
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

  private async listPoliciesForTable(appId: string, tableId: string) {
    return this.prisma.$queryRawUnsafe(
      `
        SELECT id, table_id, action, effect, roles_json, condition_json, field_mask_json,
               status, created_at, updated_at
        FROM app_data_policies
        WHERE app_id = $1::uuid
          AND table_id = $2::uuid
          AND status = 'ACTIVE'
        ORDER BY action ASC, created_at ASC
      `,
      appId,
      tableId,
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

  private serializeTableRef(table: AppDataTableRow) {
    return {
      id: table.id,
      slug: table.slug,
      physical_table_name: table.physical_table_name,
      primary_key: table.primary_key,
    };
  }

  private visibleColumns(columns: AppDataColumnRow[]) {
    return columns.filter((column) => !column.is_hidden);
  }

  private resolveSelectedColumns(columns: AppDataColumnRow[], select: unknown) {
    const visible = this.visibleColumns(columns);
    const raw = String(select || '').trim();
    if (!raw) {
      return visible;
    }
    const bySlug = new Map(visible.map((column) => [column.slug, column]));
    const selected = raw.split(',').map((item) => item.trim()).filter(Boolean).map((item) => bySlug.get(item));
    if (selected.some((column) => !column)) {
      throw new BadRequestException('select contains unknown or hidden field');
    }
    return selected as AppDataColumnRow[];
  }

  private normalizeLimit(value: unknown) {
    const numeric = Number(value || 50);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new BadRequestException('limit must be a positive number');
    }
    return Math.min(Math.floor(numeric), 500);
  }

  private resolveOrder(columns: AppDataColumnRow[], value: unknown, primaryKey: string) {
    const raw = String(value || `${primaryKey}.asc`).trim();
    const [field, directionRaw] = raw.split('.');
    const column = columns.find((item) => item.slug === field) || columns.find((item) => item.slug === primaryKey) || columns[0];
    if (!column) {
      throw new BadRequestException('No columns are registered for this table');
    }
    const direction = String(directionRaw || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return { column, direction };
  }

  private resolveFilters(columns: AppDataColumnRow[], query: Record<string, unknown>) {
    const bySlug = new Map(columns.map((column) => [column.slug, column]));
    const sql: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(query || {})) {
      if (!key.startsWith('filter.')) continue;
      const field = key.slice('filter.'.length);
      const column = bySlug.get(field);
      if (!column || column.is_hidden) {
        throw new BadRequestException(`Unknown filter field: ${field}`);
      }
      params.push(value);
      sql.push(`${this.q(column.physical_column_name)} = ${this.sqlParam(column, params.length)}`);
    }
    return { sql, params };
  }

  private primaryKeyPredicate(table: AppDataTableRow, columns: AppDataColumnRow[], paramIndex: number) {
    const column = columns.find((item) => item.slug === table.primary_key)
      || columns.find((item) => item.physical_column_name === table.primary_key);
    const physicalColumn = column?.physical_column_name || table.primary_key;
    return `${this.q(physicalColumn)} = ${this.sqlParam(column, paramIndex)}`;
  }

  private sqlParam(column: AppDataColumnRow | undefined, paramIndex: number) {
    const sqlType = String(column?.data_type || '').trim().toLowerCase();
    return `$${paramIndex}${sqlType === 'uuid' ? '::uuid' : ''}`;
  }

  private pickWritablePayload(columns: AppDataColumnRow[], body: Record<string, unknown>) {
    const allowed = new Map(columns.map((column) => [column.slug, column]));
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body || {})) {
      const column = allowed.get(key);
      if (!column) {
        throw new BadRequestException(`Unknown or readonly field: ${key}`);
      }
      payload[column.physical_column_name] = value;
    }
    if (!Object.keys(payload).length) {
      throw new BadRequestException('No writable fields provided');
    }
    return payload;
  }

  private normalizePolicyInput(input: UpsertAppDataPolicyInput) {
    const action = String(input?.action || 'read').trim().toLowerCase();
    const effect = String(input?.effect || 'allow').trim().toLowerCase();
    const status = String(input?.status || 'ACTIVE').trim().toUpperCase();
    if (!['read', 'create', 'update', 'delete', 'all'].includes(action)) {
      throw new BadRequestException('Invalid policy action');
    }
    if (!['allow', 'deny'].includes(effect)) {
      throw new BadRequestException('Invalid policy effect');
    }
    if (!['ACTIVE', 'INACTIVE', 'DELETED'].includes(status)) {
      throw new BadRequestException('Invalid policy status');
    }
    return {
      action,
      effect,
      roles: Array.isArray(input?.roles) ? Array.from(new Set(input.roles.map((role) => String(role || '').trim().toUpperCase()).filter(Boolean))) : [],
      condition: this.jsonObject(input?.condition),
      field_mask: this.jsonObject(input?.field_mask ?? input?.fieldMask),
      status,
    };
  }

  private rebaseSqlParams(sql: string[], offset: number) {
    return {
      sql: sql.map((part) => part.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + offset}`)),
    };
  }

  private async recordDataEvent(appId: string, actor: any, tableId: string, action: string, rowId: unknown) {
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO app_schema_change_events (
          app_id, actor_user_id, actor_api_key_id, resource_type, resource_id,
          action, before_json, after_json, sql_hash
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'data_row', $4::uuid, $5, NULL, $6::jsonb, NULL)
      `,
      appId,
      this.actorUserId(actor),
      this.optionalUuid(actor?.apiKeyId),
      tableId,
      action,
      JSON.stringify({ row_id: rowId ?? null }),
    );
  }

  private normalizeCreateColumns(inputColumns: CreateAppDataColumnInput[], options: { ownerColumn: string | null; softDeleteColumn: string | null }) {
    if (!Array.isArray(inputColumns)) {
      throw new BadRequestException('columns must be an array');
    }
    if (inputColumns.length > MAX_COLUMNS_PER_CREATE) {
      throw new BadRequestException(`Too many columns; max ${MAX_COLUMNS_PER_CREATE}`);
    }
    const reserved = new Set(['id', 'created_at', 'updated_at']);
    const columns = [
      this.systemColumn('id', 'uuid', false, { expression: 'gen_random_uuid()' }, true),
      this.systemColumn('created_at', 'timestamptz', false, { expression: 'now()' }, false),
      this.systemColumn('updated_at', 'timestamptz', false, { expression: 'now()' }, false),
    ];
    if (options.ownerColumn) {
      columns.push(this.systemColumn(options.ownerColumn, 'uuid', true, null, false));
      reserved.add(options.ownerColumn);
    }
    if (options.softDeleteColumn) {
      columns.push(this.systemColumn(options.softDeleteColumn, 'timestamptz', true, null, false));
      reserved.add(options.softDeleteColumn);
    }
    const seen = new Set(columns.map((column) => column.slug));
    for (const rawColumn of inputColumns) {
      const column = this.normalizeColumnInput(rawColumn, { reserved });
      if (seen.has(column.slug)) {
        throw new BadRequestException(`Duplicate column: ${column.slug}`);
      }
      seen.add(column.slug);
      columns.push(column);
    }
    return columns;
  }

  private normalizeColumnInput(input: CreateAppDataColumnInput, options: { reserved: Set<string> }) {
    const slug = this.normalizeIdentifier(input?.slug || input?.name, 'column slug');
    if (options.reserved.has(slug)) {
      throw new BadRequestException(`Column "${slug}" is reserved`);
    }
    const rawType = String(input?.data_type || input?.dataType || '').trim().toLowerCase();
    const sqlType = DATA_TYPES[rawType];
    if (!sqlType) {
      throw new BadRequestException(`Unsupported data_type: ${rawType || '(empty)'}`);
    }
    const isUnique = input?.is_unique ?? input?.unique ?? false;
    return {
      slug,
      physical_column_name: slug,
      data_type: rawType === 'int' ? 'integer' : rawType === 'bool' ? 'boolean' : rawType === 'timestamp' ? 'timestamptz' : rawType,
      sql_type: sqlType,
      is_nullable: input?.is_nullable ?? input?.nullable ?? true,
      default_value_json: null,
      is_unique: Boolean(isUnique),
      is_indexed: Boolean(input?.is_indexed ?? input?.indexed ?? isUnique),
      is_hidden: Boolean(input?.hidden ?? false),
      is_readonly: Boolean(input?.readonly ?? false),
      validation_json: this.jsonObject(input?.validation),
      display_json: this.jsonObject(input?.display),
    };
  }

  private systemColumn(slug: string, dataType: string, nullable: boolean, defaultValue: unknown, readonly: boolean) {
    return {
      slug,
      physical_column_name: slug,
      data_type: dataType,
      sql_type: DATA_TYPES[dataType] || dataType,
      is_nullable: nullable,
      default_value_json: defaultValue,
      is_unique: false,
      is_indexed: slug === 'id',
      is_hidden: false,
      is_readonly: readonly,
      validation_json: {},
      display_json: {},
    };
  }

  private buildCreateTableSql(physicalTableName: string, columns: Array<{ slug: string; physical_column_name: string; sql_type: string; is_nullable: boolean; default_value_json: unknown; is_unique: boolean; is_indexed: boolean }>) {
    const columnSql = columns.map((column) => {
      const parts = [this.q(column.physical_column_name), column.sql_type];
      if (column.slug === 'id') {
        parts.push('PRIMARY KEY');
      }
      if (!column.is_nullable) {
        parts.push('NOT NULL');
      }
      const defaultExpression = this.defaultExpression(column.default_value_json);
      if (defaultExpression) {
        parts.push(`DEFAULT ${defaultExpression}`);
      }
      if (column.is_unique && column.slug !== 'id') {
        parts.push('UNIQUE');
      }
      return `  ${parts.join(' ')}`;
    });
    const statements = [
      `CREATE TABLE ${this.q(physicalTableName)} (\n${columnSql.join(',\n')}\n)`,
    ];
    for (const column of columns) {
      if (column.is_indexed && column.slug !== 'id' && !column.is_unique) {
        statements.push(`CREATE INDEX ${this.q(`${physicalTableName}_${column.slug}_idx`)} ON ${this.q(physicalTableName)} (${this.q(column.physical_column_name)})`);
      }
    }
    return statements;
  }

  private buildAddColumnSql(physicalTableName: string, column: { slug: string; physical_column_name: string; sql_type: string; is_nullable: boolean; default_value_json: unknown; is_unique: boolean; is_indexed: boolean }) {
    const parts = [`ALTER TABLE ${this.q(physicalTableName)} ADD COLUMN ${this.q(column.physical_column_name)} ${column.sql_type}`];
    if (!column.is_nullable) {
      parts.push('NOT NULL');
    }
    const defaultExpression = this.defaultExpression(column.default_value_json);
    if (defaultExpression) {
      parts.push(`DEFAULT ${defaultExpression}`);
    }
    if (column.is_unique) {
      parts.push('UNIQUE');
    }
    const statements = [parts.join(' ')];
    if (column.is_indexed && !column.is_unique) {
      statements.push(`CREATE INDEX ${this.q(`${physicalTableName}_${column.slug}_idx`)} ON ${this.q(physicalTableName)} (${this.q(column.physical_column_name)})`);
    }
    return statements;
  }

  private defaultExpression(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const expression = String((value as { expression?: unknown }).expression || '').trim();
    if (expression === 'gen_random_uuid()' || expression === 'now()') {
      return expression;
    }
    return '';
  }

  private async assertTableSlugAvailable(appId: string, slug: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM app_data_tables WHERE app_id = $1::uuid AND slug = $2 AND status <> 'DELETED' LIMIT 1`,
      appId,
      slug,
    ) as Promise<Array<{ id: string }>>);
    if (rows[0]) {
      throw new ConflictException('Data table already exists');
    }
  }

  private async assertColumnSlugAvailable(tableId: string, slug: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM app_data_columns WHERE table_id = $1::uuid AND slug = $2 LIMIT 1`,
      tableId,
      slug,
    ) as Promise<Array<{ id: string }>>);
    if (rows[0]) {
      throw new ConflictException('Data column already exists');
    }
  }

  private normalizeIdentifier(value: unknown, label: string) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
    if (!IDENTIFIER_RE.test(normalized)) {
      throw new BadRequestException(`Invalid ${label}; use lowercase letters, numbers, and underscores`);
    }
    return normalized;
  }

  private optionalIdentifier(value: unknown, label: string) {
    const raw = String(value || '').trim();
    return raw ? this.normalizeIdentifier(raw, label) : null;
  }

  private optionalString(value: unknown, maxLength: number) {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private actorUserId(actor: { userId?: string | null; id?: string | null } | undefined) {
    const userId = String(actor?.userId || actor?.id || '').trim();
    return UUID_RE.test(userId) ? userId : null;
  }

  private optionalUuid(value: unknown) {
    const normalized = String(value || '').trim();
    return UUID_RE.test(normalized) ? normalized : null;
  }

  private q(identifier: string) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private async recordSchemaEventTx(
    tx: Pick<PrismaClient, '$executeRawUnsafe'>,
    appId: string,
    actorUserId: string | null,
    actorApiKeyId: string | null,
    resourceType: string,
    resourceId: string | null,
    action: string,
    before: unknown,
    after: unknown,
    sqlHash: string | null,
  ) {
    await tx.$executeRawUnsafe(
      `
        INSERT INTO app_schema_change_events (
          app_id, actor_user_id, actor_api_key_id, resource_type, resource_id,
          action, before_json, after_json, sql_hash
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7::jsonb, $8::jsonb, $9)
      `,
      appId,
      actorUserId,
      actorApiKeyId,
      resourceType,
      resourceId,
      action,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      sqlHash,
    );
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
