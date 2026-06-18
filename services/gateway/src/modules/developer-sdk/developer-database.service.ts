import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { DeveloperAuthorizationService } from './developer-authorization.service';

type AppRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

type RequestActor = {
  id?: string | null;
  userId?: string | null;
  email?: string | null;
  role?: string | null;
  appSlug?: string | null;
  authMode?: string | null;
  apiKeyId?: string | null;
  developerGrantId?: string | null;
  developerScopes?: string[] | null;
};

type DatabaseRequestContext = {
  appSlug?: string;
  actor?: RequestActor;
};

type DatabaseQueryPayload = {
  sql?: string;
  params?: unknown[];
  limit?: number;
};

type DatabaseExecutePayload = {
  sql?: string;
  params?: unknown[];
  dry_run?: boolean;
  dryRun?: boolean;
  confirm?: string | boolean;
};

const MAX_SQL_LENGTH = 20_000;
const MAX_QUERY_LIMIT = 500;
const MAX_STATEMENTS = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 8_000;
const DRY_RUN_ROLLBACK = '__OPG_DATABASE_DRY_RUN_ROLLBACK__';

@Injectable()
export class DeveloperDatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DeveloperDatabaseService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly developerAuthorizationService: DeveloperAuthorizationService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`developer database schema warmup failed: ${error?.message || error}`);
    }
  }

  async getManifest(context: DatabaseRequestContext) {
    this.developerAuthorizationService.assertActorScope(context.actor, 'database:schema:read');
    const { app } = await this.assertDatabaseAccess(context);
    const namespace = this.namespaceForApp(app.slug);
    return {
      app: this.serializeApp(app),
      namespace,
      table_name_rule: `${namespace}<table_name>`,
      capabilities: {
        introspect: true,
        query: true,
        ddl_dry_run: true,
        ddl_apply: true,
        dml_apply: true,
      },
      safety: {
        direct_database_url_exposed: false,
        allowed_table_prefix: namespace,
        max_sql_length: MAX_SQL_LENGTH,
        max_statements_per_execute: MAX_STATEMENTS,
        max_query_rows: MAX_QUERY_LIMIT,
        apply_confirmation: `apply:${app.slug}`,
        blocked_sql: [
          'platform tables outside the app namespace',
          'role, grant, extension, function, trigger, copy, vacuum, notify, transaction-control statements',
        ],
      },
      examples: {
        create_table: `CREATE TABLE ${namespace}customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`,
        query: `SELECT * FROM ${namespace}customers ORDER BY created_at DESC`,
      },
    };
  }

  async listTables(context: DatabaseRequestContext) {
    this.developerAuthorizationService.assertActorScope(context.actor, 'database:schema:read');
    const { app } = await this.assertDatabaseAccess(context);
    const namespace = this.namespaceForApp(app.slug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name LIKE $1
        ORDER BY table_name ASC
      `,
      `${namespace}%`,
    ) as Promise<Array<{ table_name: string }>>);

    return {
      app: this.serializeApp(app),
      namespace,
      items: rows.map((row) => ({ name: row.table_name })),
    };
  }

  async describeTable(context: DatabaseRequestContext, tableName: string) {
    this.developerAuthorizationService.assertActorScope(context.actor, 'database:schema:read');
    const { app } = await this.assertDatabaseAccess(context);
    const namespace = this.namespaceForApp(app.slug);
    const normalizedTable = this.normalizeTableName(tableName);
    this.assertAllowedIdentifier(normalizedTable, namespace, 'table');

    const columns = await (this.prisma.$queryRawUnsafe(
      `
        SELECT column_name, data_type, is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      normalizedTable,
    ) as Promise<Array<Record<string, unknown>>>);

    if (!columns.length) {
      throw new NotFoundException('Database table not found in app namespace');
    }

    const indexes = await (this.prisma.$queryRawUnsafe(
      `
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = $1
        ORDER BY indexname ASC
      `,
      normalizedTable,
    ) as Promise<Array<Record<string, unknown>>>);

    return {
      app: this.serializeApp(app),
      namespace,
      table: normalizedTable,
      columns,
      indexes,
    };
  }

  async query(context: DatabaseRequestContext, payload: DatabaseQueryPayload) {
    this.developerAuthorizationService.assertActorScope(context.actor, 'database:data:read');
    const { app } = await this.assertDatabaseAccess(context);
    const namespace = this.namespaceForApp(app.slug);
    const statement = this.singleStatement(payload?.sql);
    const params = this.normalizeParams(payload?.params);
    const limit = this.normalizeLimit(payload?.limit);
    this.assertReadStatement(statement, namespace);

    const startedAt = Date.now();
    try {
      const rows = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`);
        const limitedSql = this.wrapReadQuery(statement, params.length + 1);
        return tx.$queryRawUnsafe(limitedSql, ...params, limit + 1) as Promise<unknown[]>;
      });
      const truncated = Array.isArray(rows) && rows.length > limit;
      const sliced = Array.isArray(rows) ? rows.slice(0, limit) : rows;
      await this.recordEvent(app.id, context.actor, 'query', statement, false, true, null, Array.isArray(sliced) ? sliced.length : null, Date.now() - startedAt);
      return {
        ok: true,
        app: this.serializeApp(app),
        namespace,
        rows: sliced,
        row_count: Array.isArray(sliced) ? sliced.length : null,
        truncated,
        limit,
        execution_ms: Date.now() - startedAt,
      };
    } catch (error: any) {
      await this.recordEvent(app.id, context.actor, 'query', statement, false, false, error?.message || String(error), null, Date.now() - startedAt);
      throw error;
    }
  }

  async execute(context: DatabaseRequestContext, payload: DatabaseExecutePayload) {
    const { app } = await this.assertDatabaseAccess(context);
    const namespace = this.namespaceForApp(app.slug);
    const sql = this.normalizeSql(payload?.sql);
    const statements = splitSqlStatements(sql);
    const params = this.normalizeParams(payload?.params);
    if (statements.length === 0) {
      throw new BadRequestException('sql is required');
    }
    if (statements.length > MAX_STATEMENTS) {
      throw new BadRequestException(`Too many statements; max ${MAX_STATEMENTS}`);
    }
    if (statements.length > 1 && params.length > 0) {
      throw new BadRequestException('params are only supported for single-statement execution');
    }
    for (const statement of statements) {
      this.assertWriteStatement(statement, namespace);
    }
    this.assertExecuteScopes(context, statements);

    const dryRun = payload?.dry_run !== undefined ? payload.dry_run !== false : payload?.dryRun !== false;
    if (!dryRun && payload?.confirm !== `apply:${app.slug}`) {
      throw new BadRequestException(`Set confirm to "apply:${app.slug}" to apply database changes`);
    }

    const startedAt = Date.now();
    try {
      const rowCounts: number[] = [];
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`);
          for (const [index, statement] of statements.entries()) {
            const statementParams = index === 0 ? params : [];
            const count = await tx.$executeRawUnsafe(statement, ...statementParams);
            rowCounts.push(Number(count || 0));
          }
          if (dryRun) {
            throw new Error(DRY_RUN_ROLLBACK);
          }
        },
        { maxWait: 10_000, timeout: 60_000 },
      ).catch((error: any) => {
        if (dryRun && error?.message === DRY_RUN_ROLLBACK) {
          return;
        }
        throw error;
      });

      const executionMs = Date.now() - startedAt;
      await this.recordEvent(app.id, context.actor, 'execute', sql, dryRun, true, null, rowCounts.reduce((sum, value) => sum + value, 0), executionMs);
      return {
        ok: true,
        app: this.serializeApp(app),
        namespace,
        dry_run: dryRun,
        applied: !dryRun,
        statements: statements.map((statement, index) => ({
          index,
          operation: this.statementOperation(statement),
          tables: this.extractTableReferences(statement),
          row_count: rowCounts[index] ?? null,
        })),
        execution_ms: executionMs,
        next: dryRun ? { apply_confirm: `apply:${app.slug}` } : null,
      };
    } catch (error: any) {
      await this.recordEvent(app.id, context.actor, 'execute', sql, dryRun, false, error?.message || String(error), null, Date.now() - startedAt);
      throw error;
    }
  }

  private async assertDatabaseAccess(context: DatabaseRequestContext) {
    const app = await this.resolveApp(context.appSlug || context.actor?.appSlug || undefined);
    const actorUserId = String(context.actor?.userId || context.actor?.id || '').trim();
    if (!actorUserId) {
      throw new ForbiddenException('Database access requires an authenticated user or app API key owner');
    }
    if (context.actor?.appSlug && context.actor.appSlug !== app.slug) {
      throw new ForbiddenException('Actor does not belong to this app');
    }
    if (context.actor?.authMode === 'developer_grant') {
      return { app, actorUserId };
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, role::text AS role, admin_type::text AS admin_type, is_superuser
        FROM users
        WHERE id = $1::uuid
          AND app_id = $2::uuid
          AND deleted_at IS NULL
          AND is_active = true
        LIMIT 1
      `,
      actorUserId,
      app.id,
    ) as Promise<Array<{ id: string; role: string; admin_type: string | null; is_superuser: boolean }>>);

    const user = rows[0];
    if (!user) {
      throw new ForbiddenException('Actor does not belong to this app');
    }
    if (user.role !== 'ADMIN' && !user.admin_type && !user.is_superuser) {
      throw new ForbiddenException('Database access requires an app admin');
    }
    return { app, actorUserId };
  }

  private assertExecuteScopes(context: DatabaseRequestContext, statements: string[]) {
    if (context.actor?.authMode !== 'developer_grant') {
      return;
    }
    const needsSchemaWrite = statements.some((statement) => /^(create|alter|drop|truncate)\b/i.test(statement.trim()));
    const needsDataWrite = statements.some((statement) => /^(insert|update|delete|merge)\b/i.test(statement.trim()));
    if (needsSchemaWrite) {
      this.developerAuthorizationService.assertActorScope(context.actor, 'database:schema:write');
    }
    if (needsDataWrite) {
      this.developerAuthorizationService.assertActorScope(context.actor, 'database:data:write');
    }
    if (!needsSchemaWrite && !needsDataWrite) {
      this.developerAuthorizationService.assertActorScope(context.actor, 'database:schema:write');
    }
  }

  private async resolveApp(appSlug?: string) {
    const normalized = String(appSlug || '').trim();
    if (!normalized) {
      throw new BadRequestException('app is required');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name, status::text AS status FROM apps WHERE slug = $1 LIMIT 1`,
      normalized,
    ) as Promise<AppRow[]>);

    const app = rows[0];
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private serializeApp(app: AppRow) {
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      status: app.status,
    };
  }

  private namespaceForApp(appSlug: string) {
    const normalized = appSlug
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
    const safeSlug = normalized && /^[a-z_]/.test(normalized) ? normalized : `app_${normalized || 'default'}`;
    return `app_${safeSlug}__`;
  }

  private normalizeSql(sql: unknown) {
    const normalized = String(sql || '').trim();
    if (!normalized) {
      throw new BadRequestException('sql is required');
    }
    if (normalized.length > MAX_SQL_LENGTH) {
      throw new BadRequestException(`sql is too long; max ${MAX_SQL_LENGTH} characters`);
    }
    return normalized;
  }

  private singleStatement(sql: unknown) {
    const normalized = this.normalizeSql(sql);
    const statements = splitSqlStatements(normalized);
    if (statements.length !== 1) {
      throw new BadRequestException('exactly one SQL statement is required');
    }
    return statements[0].replace(/;+\s*$/, '').trim();
  }

  private normalizeParams(params: unknown) {
    if (params === undefined || params === null) {
      return [];
    }
    if (!Array.isArray(params)) {
      throw new BadRequestException('params must be an array');
    }
    if (params.length > 50) {
      throw new BadRequestException('params is too long; max 50');
    }
    return params;
  }

  private normalizeLimit(limit: unknown) {
    const numeric = Number(limit || 100);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new BadRequestException('limit must be a positive number');
    }
    return Math.min(Math.floor(numeric), MAX_QUERY_LIMIT);
  }

  private normalizeTableName(value: unknown) {
    return String(value || '')
      .trim()
      .replace(/^public\./i, '')
      .replace(/^"public"\./i, '')
      .replace(/^"|"$/g, '');
  }

  private assertReadStatement(statement: string, namespace: string) {
    const operation = this.statementOperation(statement);
    if (!['select', 'with'].includes(operation)) {
      throw new BadRequestException('database query only allows SELECT or WITH');
    }
    this.assertSqlSafe(statement, namespace);
  }

  private assertWriteStatement(statement: string, namespace: string) {
    const operation = this.statementOperation(statement);
    if (!['create', 'alter', 'drop', 'insert', 'update', 'delete', 'comment'].includes(operation)) {
      throw new BadRequestException(`database execute does not allow ${operation || 'unknown'} statements`);
    }
    if (!this.isAllowedWriteShape(statement)) {
      throw new BadRequestException('database execute only allows table/index DDL, table comments, and table DML');
    }
    this.assertSqlSafe(statement, namespace);
  }

  private assertSqlSafe(statement: string, namespace: string) {
    const scrubbed = scrubSql(statement);
    const blocked = [
      /\bcopy\b/i,
      /\bgrant\b/i,
      /\brevoke\b/i,
      /\balter\s+system\b/i,
      /\bcreate\s+extension\b/i,
      /\bdrop\s+extension\b/i,
      /\bcreate\s+(?:or\s+replace\s+)?function\b/i,
      /\bcreate\s+(?:or\s+replace\s+)?procedure\b/i,
      /\bcreate\s+trigger\b/i,
      /\bdo\s+\$/i,
      /\bcreate\s+role\b/i,
      /\balter\s+role\b/i,
      /\bdrop\s+role\b/i,
      /\bvacuum\b/i,
      /\banalyze\b/i,
      /\bcluster\b/i,
      /\breindex\b/i,
      /\blisten\b/i,
      /\bnotify\b/i,
      /\bcall\b/i,
      /\bconcurrently\b/i,
      /\bbegin\b/i,
      /\bcommit\b/i,
      /\brollback\b/i,
      /\bset\s+role\b/i,
      /\bset\s+session\b/i,
    ];
    if (blocked.some((pattern) => pattern.test(scrubbed))) {
      throw new BadRequestException('SQL contains blocked database operation');
    }

    for (const table of this.extractTableReferences(statement)) {
      this.assertAllowedIdentifier(table, namespace, 'table');
    }
  }

  private assertAllowedIdentifier(identifier: string, namespace: string, label: string) {
    const normalized = this.normalizeTableName(identifier).toLowerCase();
    if (!normalized || !/^[a-z_][a-z0-9_]*$/.test(normalized)) {
      throw new BadRequestException(`Invalid ${label} identifier`);
    }
    if (!normalized.startsWith(namespace)) {
      throw new ForbiddenException(`${label} "${normalized}" is outside app database namespace "${namespace}"`);
    }
  }

  private statementOperation(statement: string) {
    const match = scrubSql(statement).trim().match(/^([a-z]+)/i);
    return match ? match[1].toLowerCase() : '';
  }

  private isAllowedWriteShape(statement: string) {
    const scrubbed = scrubSql(statement).trim();
    return [
      /^create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
      /^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+on\s+(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
      /^alter\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
      /^drop\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
      /^insert\s+into\s+(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
      /^update\s+(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
      /^delete\s+from\s+(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
      /^comment\s+on\s+table\s+(?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\b/i,
    ].some((pattern) => pattern.test(scrubbed));
  }

  private extractTableReferences(statement: string) {
    const scrubbed = scrubSql(statement);
    const cteAliases = this.extractCteAliases(scrubbed);
    const references = new Set<string>();
    const patterns = [
      /\b(?:from|join|into|update)\s+((?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi,
      /\b(?:using|references)\s+((?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi,
      /\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?((?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi,
      /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+on\s+((?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi,
      /\bcomment\s+on\s+table\s+((?:"?public"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi,
    ];
    for (const pattern of patterns) {
      for (const match of scrubbed.matchAll(pattern)) {
        if (match[1]) {
          const tableName = this.normalizeTableName(match[1]).toLowerCase();
          if (!cteAliases.has(tableName)) {
            references.add(tableName);
          }
        }
      }
    }
    return Array.from(references);
  }

  private extractCteAliases(scrubbedSql: string) {
    const aliases = new Set<string>();
    const normalized = scrubbedSql.trim();
    if (!/^with\s/i.test(normalized)) {
      return aliases;
    }
    const pattern = /(?:^with\s+(?:recursive\s+)?|,\s*)("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+as\s*\(/gi;
    for (const match of normalized.matchAll(pattern)) {
      if (match[1]) {
        aliases.add(this.normalizeTableName(match[1]).toLowerCase());
      }
    }
    return aliases;
  }

  private wrapReadQuery(statement: string, limitParamIndex: number) {
    return `SELECT * FROM (${statement.replace(/;+\s*$/, '')}) AS opg_result LIMIT $${limitParamIndex}`;
  }

  private async recordEvent(
    appId: string,
    actor: RequestActor | undefined,
    operation: string,
    sqlText: string,
    dryRun: boolean,
    success: boolean,
    errorMessage: string | null,
    rowCount: number | null,
    executionMs: number,
  ) {
    await this.ensureSchema();
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO app_database_change_events (
          app_id, actor_user_id, api_key_id, operation, sql_text, dry_run, success, error_message, row_count, execution_ms
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
      `,
      appId,
      this.nullableUuid(actor?.userId || actor?.id),
      this.nullableUuid(actor?.apiKeyId),
      operation,
      sqlText.slice(0, MAX_SQL_LENGTH),
      dryRun,
      success,
      errorMessage ? errorMessage.slice(0, 2000) : null,
      rowCount,
      executionMs,
    ).catch((error: any) => {
      this.logger.warn(`failed to record developer database event: ${error?.message || error}`);
    });
  }

  private nullableUuid(value: unknown) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }
    this.schemaPromise = this.initSchema();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async initSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS app_database_change_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        api_key_id uuid NULL,
        operation varchar(32) NOT NULL,
        sql_text text NOT NULL,
        dry_run boolean NOT NULL DEFAULT true,
        success boolean NOT NULL DEFAULT false,
        error_message text NULL,
        row_count integer NULL,
        execution_ms integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_app_database_change_events_app_created
      ON app_database_change_events(app_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_app_database_change_events_actor_created
      ON app_database_change_events(actor_user_id, created_at DESC)
    `);
  }
}

function scrubSql(sql: string) {
  let output = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] || '';

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        blockComment = false;
      } else {
        output += ' ';
      }
      continue;
    }
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        output += ' '.repeat(dollarQuoteTag.length);
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      } else {
        output += ' ';
      }
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '-' && next === '-') {
      output += '  ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '/' && next === '*') {
      output += '  ';
      index += 1;
      blockComment = true;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '$') {
      const rest = sql.slice(index);
      const match = rest.match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarQuoteTag = match[0];
        output += ' '.repeat(dollarQuoteTag.length);
        index += dollarQuoteTag.length - 1;
        continue;
      }
    }
    if (singleQuoted && char === "'" && next === "'") {
      output += '  ';
      index += 1;
      continue;
    }
    if (!doubleQuoted && char === "'" && sql[index - 1] !== '\\') {
      singleQuoted = !singleQuoted;
      output += ' ';
      continue;
    }
    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted;
      output += char;
      continue;
    }
    output += singleQuoted ? ' ' : char;
  }
  return output;
}

function splitSqlStatements(sql: string) {
  const statements: string[] = [];
  let current = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] || '';

    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (dollarQuoteTag) {
      current += char;
      if (sql.startsWith(dollarQuoteTag, index)) {
        current += dollarQuoteTag.slice(1);
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '-' && next === '-') {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '/' && next === '*') {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '$') {
      const rest = sql.slice(index);
      const match = rest.match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarQuoteTag = match[0];
        current += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        continue;
      }
    }
    if (singleQuoted && char === "'" && next === "'") {
      current += char + next;
      index += 1;
      continue;
    }
    if (!doubleQuoted && char === "'" && sql[index - 1] !== '\\') {
      singleQuoted = !singleQuoted;
      current += char;
      continue;
    }
    if (doubleQuoted && char === '"' && next === '"') {
      current += char + next;
      index += 1;
      continue;
    }
    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted;
      current += char;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }
    current += char;
  }

  const finalStatement = current.trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}
